import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createZcodeProvider } from '../../src/providers/zcode.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

// Byte-identical parity gate for the zcode bridge migration (phase 8, Category
// B / sqlite). ZCode is not present in the frozen corpus, so a committed
// fixture golden is THE parity gate. The GOLDEN below was captured from the
// legacy provider before the migration.

const requireForTest = createRequire(import.meta.url)

function createZcodeDb(dir: string): string {
  const dbPath = join(dir, 'db.sqlite')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)`)
  db.exec(`CREATE TABLE model_usage (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, completed_at INTEGER)`)
  db.exec(`CREATE TABLE tool_usage (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, tool_name TEXT NOT NULL, started_at INTEGER NOT NULL)`)
  db.close()
  return dbPath
}

function seed(dbPath: string): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('sess-1', '/Users/me/proj')
    db.prepare(`INSERT INTO model_usage (id, session_id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('mu-1', 'sess-1', 'turn-1', 'GLM-5.2', 9125, 27, 12, 0, 8064, 1781981181862, 1781981202412)
    db.prepare(`INSERT INTO model_usage (id, session_id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('mu-2', 'sess-1', 'turn-1', 'GLM-5.2', 200, 40, 0, 0, 0, 1781981210000, 1781981220000)
    // Zero-token row: must be skipped entirely.
    db.prepare(`INSERT INTO model_usage (id, session_id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('mu-zero', 'sess-1', 'turn-2', 'GLM-5.2', 0, 0, 0, 0, 0, 1781981230000, 1781981231000)
    // No turn_id -> no tools attached.
    db.prepare(`INSERT INTO model_usage (id, session_id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('mu-3', 'sess-1', null, 'GLM-5.2', 500, 60, 0, 100, 0, 1781981240000, null)

    db.prepare('INSERT INTO tool_usage (id, session_id, turn_id, tool_name, started_at) VALUES (?, ?, ?, ?, ?)').run('tu-1', 'sess-1', 'turn-1', 'Bash', 1781981185000)
    db.prepare('INSERT INTO tool_usage (id, session_id, turn_id, tool_name, started_at) VALUES (?, ?, ?, ?, ?)').run('tu-2', 'sess-1', 'turn-1', 'Read', 1781981190000)
  } finally {
    db.close()
  }
}

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'zcode',
    model: 'GLM-5.2',
    inputTokens: 1061,
    outputTokens: 27,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 8064,
    cachedInputTokens: 0,
    reasoningTokens: 12,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: ['Bash', 'Read'],
    bashCommands: [],
    timestamp: '2026-06-20T18:46:42.412Z',
    speed: 'standard',
    deduplicationKey: 'zcode:mu-1',
    turnId: 'turn-1',
    userMessage: '',
    sessionId: 'sess-1',
  },
  {
    provider: 'zcode',
    model: 'GLM-5.2',
    inputTokens: 200,
    outputTokens: 40,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-06-20T18:47:00.000Z',
    speed: 'standard',
    deduplicationKey: 'zcode:mu-2',
    turnId: 'turn-1',
    userMessage: '',
    sessionId: 'sess-1',
  },
  {
    provider: 'zcode',
    model: 'GLM-5.2',
    inputTokens: 400,
    outputTokens: 60,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-06-20T18:47:20.000Z',
    speed: 'standard',
    deduplicationKey: 'zcode:mu-3',
    userMessage: '',
    sessionId: 'sess-1',
  },
]

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'zcode-bridge-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

async function collect(dbPath: string, seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createZcodeProvider(dbPath)
  const sources = await provider.discoverSessions()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) {
      calls.push(call)
    }
  }
  return calls
}

describe.skipIf(!isSqliteAvailable())('zcode bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    const dbPath = createZcodeDb(tmpRoot)
    seed(dbPath)
    expect(await collect(dbPath)).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const dbPath = createZcodeDb(tmpRoot)
    seed(dbPath)
    const raw = await collect(dbPath)
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      expect(call.costUSD).toBeGreaterThan(0)
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('discovery, I/O, and dedup stay CLI-side; the shared seenKeys set dedups', async () => {
    const dbPath = createZcodeDb(tmpRoot)
    seed(dbPath)
    const seen = new Set<string>()
    const first = await collect(dbPath, seen)
    const second = await collect(dbPath, seen)
    expect(first.length).toBe(3)
    expect(second).toEqual([])
  })
})
