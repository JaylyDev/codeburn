import { mkdir, mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHermesProvider } from '../../src/providers/hermes.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tmpDir: string
let originalHermesHome: string | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hermes-bridge-test-'))
  originalHermesHome = process.env['HERMES_HOME']
})

afterEach(async () => {
  if (originalHermesHome === undefined) delete process.env['HERMES_HOME']
  else process.env['HERMES_HOME'] = originalHermesHome
  await rm(tmpDir, { recursive: true, force: true })
})

function createHermesDb(homeDir: string): string {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const dbPath = join(homeDir, 'state.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      model TEXT,
      cwd TEXT,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      api_call_count INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      started_at REAL,
      ended_at REAL,
      title TEXT
    )
  `)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL
    )
  `)
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

function insertSession(db: TestDb, values: {
  id: string
  source?: string
  model?: string
  cwd?: string | null
  billingProvider?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedCost?: number | null
  actualCost?: number | null
  apiCalls?: number
  toolCalls?: number
  startedAt: number
  title?: string
}): void {
  db.prepare(
    `INSERT INTO sessions (
      id, source, model, cwd, billing_provider, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd,
      actual_cost_usd, api_call_count, tool_call_count, started_at, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.id,
    values.source ?? 'cli',
    values.model ?? 'gpt-5.5',
    values.cwd ?? null,
    values.billingProvider ?? 'openai-codex',
    values.inputTokens,
    values.outputTokens,
    values.cacheReadTokens,
    values.cacheWriteTokens,
    values.reasoningTokens,
    values.estimatedCost ?? null,
    values.actualCost ?? null,
    values.apiCalls ?? 1,
    values.toolCalls ?? 0,
    values.startedAt,
    values.title ?? values.id,
  )
}

async function collect(source: SessionSource): Promise<ParsedProviderCall[]> {
  const provider = createHermesProvider(tmpDir)
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

// Golden captured from the legacy in-CLI decode over the fixture below.
// Covers: sqlite row decode, token buckets, costBasis='measured' precedence,
// tool-name map (incl. composio MCP before generic MCP), tool-result tool_name,
// project from sessions.cwd, dedup key, turnId, userMessage, toolSequence.
const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'hermes',
    model: 'claude-sonnet-4-20250514',
    inputTokens: 1234,
    outputTokens: 567,
    cacheCreationInputTokens: 12,
    cacheReadInputTokens: 89,
    cachedInputTokens: 89,
    reasoningTokens: 34,
    webSearchRequests: 0,
    costUSD: 0.0045,
    costBasis: 'measured',
    costIsEstimated: false,
    tools: ['Read', 'Bash', 'MCP'],
    bashCommands: ['npm test && npm run build'],
    timestamp: '2026-05-23T15:13:20.000Z',
    speed: 'standard',
    deduplicationKey: 'hermes:default:bridge-session',
    turnId: 'bridge-session:session',
    toolSequence: [
      [
        { tool: 'Read', file: '/tmp/bridge.ts' },
        { tool: 'Bash', command: 'npm test && npm run build' },
        { tool: 'MCP' },
      ],
    ],
    userMessage: 'Add Hermes bridge parity test',
    sessionId: 'bridge-session',
    project: 'Users-me-projects-codeburn-bridge',
    projectPath: '/Users/me/projects/codeburn-bridge',
  },
]

skipUnlessSqlite('hermes bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'bridge-session',
        source: 'tui',
        model: 'claude-sonnet-4-20250514',
        cwd: '/Users/me/projects/codeburn-bridge',
        inputTokens: 1234,
        outputTokens: 567,
        cacheReadTokens: 89,
        cacheWriteTokens: 12,
        reasoningTokens: 34,
        actualCost: 0.0045,
        apiCalls: 3,
        toolCalls: 2,
        startedAt: 1779549200,
        title: 'Bridge Test',
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('bridge-session', 'user', 'Add Hermes bridge parity test', 1779549201)
      db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run(
          'bridge-session',
          'assistant',
          '',
          JSON.stringify([
            { function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/bridge.ts' }) } },
            { function: { name: 'terminal', arguments: JSON.stringify({ command: 'npm test && npm run build' }) } },
            { function: { name: 'mcp_composio_GMAIL_SEND_EMAIL', arguments: '{}' } },
          ]),
          1779549202,
        )
      db.prepare('INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('bridge-session', 'tool', null, 'read_file', 1779549203)
    })

    const source: SessionSource = { path: `${dbPath}#hermes-session=bridge-session`, project: 'hermes', provider: 'hermes' }
    expect(await collect(source)).toEqual(GOLDEN)
  })

  it('the measured-cost output survives the pricing pass unchanged', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'bridge-session',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1234,
        outputTokens: 567,
        cacheReadTokens: 89,
        cacheWriteTokens: 12,
        reasoningTokens: 34,
        actualCost: 0.0045,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('bridge-session', 'user', 'Add Hermes bridge parity test', 1779549201)
    })

    const source: SessionSource = { path: `${dbPath}#hermes-session=bridge-session`, project: 'hermes', provider: 'hermes' }
    const raw = await collect(source)
    const priced = raw.map(priceProviderCall)
    expect(priced).toEqual(raw)
  })

  it('dedup threads through the host-owned seenKeys set', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'bridge-session',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
    })

    const source: SessionSource = { path: `${dbPath}#hermes-session=bridge-session`, project: 'hermes', provider: 'hermes' }
    const provider = createHermesProvider(tmpDir)
    const seen = new Set<string>()
    const first: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seen).parse()) first.push(call)
    const second: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seen).parse()) second.push(call)
    expect(first).toHaveLength(1)
    expect(second).toEqual([])
  })
})
