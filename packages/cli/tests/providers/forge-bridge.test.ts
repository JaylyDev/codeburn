import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createForgeProvider } from '../../src/providers/forge.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

// Byte-identical parity gate for the forge bridge migration (phase 8, Category
// B / sqlite). Forge is not present in the frozen corpus, so a committed
// fixture golden is THE parity gate. The GOLDEN below was captured from the
// legacy provider before the migration.

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

function createForgeDb(dir: string): string {
  const dbPath = join(dir, 'forge.db')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE conversations(
    conversation_id TEXT PRIMARY KEY NOT NULL, title TEXT, workspace_id BIGINT NOT NULL,
    context TEXT, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP, metrics TEXT
  )`)
  db.close()
  return dbPath
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    fn(db)
  } finally {
    db.close()
  }
}

const CONTEXT = {
  messages: [
    { message: { text: { role: 'User', content: 'implement forge bridge' } } },
    {
      message: {
        text: {
          role: 'Assistant', content: '', model: 'claude-opus-4-6',
          tool_calls: [
            { name: 'shell', call_id: 'call-1', arguments: { command: 'git status && npm test' } },
            { name: 'Read', call_id: 'call-2', arguments: { file_path: '/tmp/a' } },
          ],
        },
      },
      usage: { prompt_tokens: { actual: 1200 }, completion_tokens: { actual: 300 }, cached_tokens: { actual: 200 } },
    },
    { message: { text: { role: 'User', content: 'now write tests' } } },
    {
      message: { text: { role: 'Assistant', model: 'claude-sonnet-4-6', tool_calls: [{ name: 'unknown_tool', call_id: 'call-3', arguments: {} }] } },
      usage: { prompt_tokens: { actual: 400 }, completion_tokens: { actual: 90 } },
    },
    // Zero-token assistant message: must be skipped.
    { message: { text: { role: 'Assistant', model: 'claude-sonnet-4-6' } }, usage: { prompt_tokens: { actual: 0 }, completion_tokens: { actual: 0 } } },
    // Tool names that collide with Object.prototype members. Tool names come
    // straight from the conversation JSON, so mapping them through a plain
    // object-literal lookup would resolve the INHERITED member (a Function, or
    // Object.prototype itself for `__proto__`) instead of falling through to
    // the identity default. The pre-migration decode used a `switch` and
    // returned each name verbatim; this row pins that.
    {
      message: {
        text: {
          role: 'Assistant', model: 'claude-haiku-4-5',
          tool_calls: [
            { name: 'constructor', call_id: 'call-4', arguments: {} },
            { name: 'toString', call_id: 'call-5', arguments: {} },
            { name: '__proto__', call_id: 'call-6', arguments: {} },
            { name: 'hasOwnProperty', call_id: 'call-7', arguments: {} },
          ],
        },
      },
      usage: { prompt_tokens: { actual: 50 }, completion_tokens: { actual: 5 } },
    },
  ],
}

function seed(dbPath: string): void {
  withTestDb(dbPath, db => {
    db.prepare(`INSERT INTO conversations (conversation_id, title, workspace_id, context, created_at, updated_at, metrics) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('conv-1', 'Forge Project', 123, JSON.stringify(CONTEXT), '2026-05-06 15:00:00', '2026-05-06 15:20:41.379094', null)
  })
}

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'forge',
    model: 'claude-opus-4-6',
    inputTokens: 1000,
    outputTokens: 300,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 200,
    cachedInputTokens: 200,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: ['Bash', 'Read'],
    bashCommands: ['git', 'npm'],
    timestamp: '2026-05-06T15:20:41.379Z',
    speed: 'standard',
    deduplicationKey: 'forge:conv-1:call-1',
    userMessage: 'implement forge bridge',
    sessionId: 'conv-1',
  },
  {
    provider: 'forge',
    model: 'claude-sonnet-4-6',
    inputTokens: 400,
    outputTokens: 90,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: ['unknown_tool'],
    bashCommands: [],
    timestamp: '2026-05-06T15:20:41.379Z',
    speed: 'standard',
    deduplicationKey: 'forge:conv-1:call-3',
    userMessage: 'now write tests',
    sessionId: 'conv-1',
  },
  {
    provider: 'forge',
    model: 'claude-haiku-4-5',
    inputTokens: 50,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: ['constructor', 'toString', '__proto__', 'hasOwnProperty'],
    bashCommands: [],
    timestamp: '2026-05-06T15:20:41.379Z',
    speed: 'standard',
    deduplicationKey: 'forge:conv-1:call-4',
    userMessage: 'now write tests',
    sessionId: 'conv-1',
  },
]

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'forge-bridge-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

async function collect(dbPath: string, seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createForgeProvider(dbPath)
  const sources = await provider.discoverSessions()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) {
      calls.push(call)
    }
  }
  return calls
}

describe.skipIf(!isSqliteAvailable())('forge bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    const dbPath = createForgeDb(tmpRoot)
    seed(dbPath)
    expect(await collect(dbPath)).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const dbPath = createForgeDb(tmpRoot)
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
    const dbPath = createForgeDb(tmpRoot)
    seed(dbPath)
    const seen = new Set<string>()
    const first = await collect(dbPath, seen)
    const second = await collect(dbPath, seen)
    expect(first.length).toBe(3)
    expect(second).toEqual([])
  })

  it('every emitted tool name is a string (no inherited prototype member leaks in)', async () => {
    const dbPath = createForgeDb(tmpRoot)
    seed(dbPath)
    for (const call of await collect(dbPath)) {
      for (const tool of call.tools) expect(typeof tool).toBe('string')
    }
  })
})
