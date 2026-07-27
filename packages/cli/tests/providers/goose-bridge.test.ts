import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createGooseProvider } from '../../src/providers/goose.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the goose bridge migration (phase 8, Category
// B / sqlite). Goose is not present in the frozen corpus and had no pre-
// existing fixture test, so this fixture-building pattern is modeled on the
// sibling sqlite providers (crush/zed/forge). The GOLDEN below was captured
// from the legacy in-CLI decode before the migration (createGooseProvider has
// no db-path override, so `createSessionParser` is exercised directly against
// a manually-built source, exactly as the capture script did).

const requireForTest = createRequire(import.meta.url)

function createGooseDb(dir: string): string {
  const dbPath = join(dir, 'sessions.db')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, name TEXT, working_dir TEXT, created_at TEXT, updated_at TEXT,
    accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, provider_name TEXT, model_config_json BLOB
  )`)
  db.exec(`CREATE TABLE messages (
    message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content_json BLOB NOT NULL, created_timestamp INTEGER NOT NULL
  )`)
  db.close()
  return dbPath
}

function seed(dbPath: string, opts: { badTimestamps?: boolean; singleTurn?: boolean } = {}): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    const modelConfig = JSON.stringify({ model_name: 'gpt-5.5', reasoning: true })
    db.prepare(`INSERT INTO sessions (id, name, working_dir, created_at, updated_at, accumulated_input_tokens, accumulated_output_tokens, provider_name, model_config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sess-1', 'goose session', '/Users/me/project',
        opts.badTimestamps ? 'not-a-date' : '2026-06-01T10:00:00Z',
        opts.badTimestamps ? 'also-not-a-date' : '2026-06-01T10:05:30Z',
        1500, 400, 'openai', Buffer.from(modelConfig))

    db.prepare(`INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?, ?)`)
      .run('msg-1', 'sess-1', 'user', Buffer.from(JSON.stringify([{ type: 'text', text: 'please refactor the shell wrapper and run tests' }])), 1_780_000_000)

    const assistantContent1 = [
      { type: 'text', text: 'working on it' },
      { type: 'toolRequest', toolCall: { value: { name: 'developer__shell', arguments: { command: 'npm test && npm run lint' } } } },
      { type: 'toolRequest', toolCall: { value: { name: 'developer__read_file', arguments: { file_path: 'src/index.ts' } } } },
    ]
    db.prepare(`INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?, ?)`)
      .run('msg-2', 'sess-1', 'assistant', Buffer.from(JSON.stringify(assistantContent1)), 1_780_000_010)

    if (!opts.singleTurn) {
      const assistantContent2 = [
        { type: 'toolRequest', toolCall: { value: { name: 'some_native_tool', arguments: {} } } },
      ]
      db.prepare(`INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?, ?)`)
        .run('msg-3', 'sess-1', 'assistant', Buffer.from(JSON.stringify(assistantContent2)), 1_780_000_020)
    }
  } finally {
    db.close()
  }
}

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'goose',
    model: 'gpt-5.5',
    inputTokens: 1500,
    outputTokens: 400,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: ['Bash', 'Read', 'some_native_tool'],
    bashCommands: ['npm'],
    toolSequence: [
      [
        { tool: 'Bash', command: 'npm test && npm run lint' },
        { tool: 'Read', file: 'src/index.ts' },
      ],
      [
        { tool: 'some_native_tool' },
      ],
    ],
    timestamp: '2026-06-01T10:05:30.000Z',
    speed: 'standard',
    deduplicationKey: 'goose:sess-1',
    userMessage: 'please refactor the shell wrapper and run tests',
    sessionId: 'sess-1',
  },
]

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'goose-bridge-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

async function collect(dbPath: string, seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createGooseProvider()
  const source: SessionSource = { path: `${dbPath}:sess-1`, project: 'goose-bridge', provider: 'goose' }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seen).parse()) {
    calls.push(call)
  }
  return calls
}

describe.skipIf(!isSqliteAvailable())('goose bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    const dbPath = createGooseDb(tmpRoot)
    seed(dbPath)
    expect(await collect(dbPath)).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const dbPath = createGooseDb(tmpRoot)
    seed(dbPath)
    const raw = await collect(dbPath)
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('discovery, I/O, and dedup stay CLI-side; the shared seenKeys set dedups', async () => {
    const dbPath = createGooseDb(tmpRoot)
    seed(dbPath)
    const seen = new Set<string>()
    const first = await collect(dbPath, seen)
    const second = await collect(dbPath, seen)
    expect(first.length).toBe(1)
    expect(second).toEqual([])
  })

  it('omits toolSequence when only one turn carries tool calls', async () => {
    const dbPath = createGooseDb(tmpRoot)
    seed(dbPath, { singleTurn: true })
    const [call] = await collect(dbPath)
    expect(call).toEqual({
      ...GOLDEN[0]!,
      tools: ['Bash', 'Read'],
      toolSequence: undefined,
    })
  })

  it('falls back to the current time when neither timestamp column parses', async () => {
    const dbPath = createGooseDb(tmpRoot)
    seed(dbPath, { badTimestamps: true })
    const before = Date.now()
    const [call] = await collect(dbPath)
    const after = Date.now()
    // Every other field is identical to the golden; only the timestamp differs,
    // and it must land on "now" exactly as the pre-migration `new Date()` did.
    const { timestamp, ...rest } = call!
    const { timestamp: _goldenTimestamp, ...goldenRest } = GOLDEN[0]!
    expect(rest).toEqual(goldenRest)
    expect(Date.parse(timestamp)).toBeGreaterThanOrEqual(before - 1000)
    expect(Date.parse(timestamp)).toBeLessThanOrEqual(after + 1000)
  })
})
