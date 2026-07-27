import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'node:module'
import zlib from 'zlib'

import { createZedProvider } from '../../src/providers/zed.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

// Byte-identical parity gate for the zed bridge migration (phase 8, Category B
// / sqlite). Zed is not present in the frozen corpus, so a committed fixture
// golden is THE parity gate. The GOLDEN below was captured from the legacy
// provider before the migration.

const requireForTest = createRequire(import.meta.url)
const zstd = (zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync

const skipReason = !isSqliteAvailable()
  ? 'node:sqlite not available — needs Node 22+; skipping'
  : !zstd
    ? 'zlib zstd not available — needs Node 22.15+; skipping'
    : null

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zed-bridge-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function buildDb(fn: (db: {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}) => void): string {
  const dbPath = join(tmpDir, 'threads.db')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data_type TEXT NOT NULL,
    data BLOB NOT NULL,
    parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT
  )`)
  fn(db)
  db.close()
  return dbPath
}

function insertThread(db: {
  prepare(sql: string): { run(...params: unknown[]): void }
}, opts: {
  id: string
  summary?: string
  updatedAt?: string
  dataType?: string
  thread?: unknown
  rawData?: Buffer
}): void {
  const data = opts.rawData ?? zstd!(Buffer.from(JSON.stringify(opts.thread ?? {})))
  db.prepare('INSERT INTO threads (id, summary, updated_at, data_type, data) VALUES (?, ?, ?, ?, ?)').run(
    opts.id,
    opts.summary ?? 'a thread',
    opts.updatedAt ?? '2026-06-20T10:00:00Z',
    opts.dataType ?? 'zstd',
    data,
  )
}

function seedDb(): string {
  return buildDb((db) => {
    insertThread(db, {
      id: 'thread-1',
      summary: 'refactor the parser',
      updatedAt: '2026-06-21T09:30:00Z',
      thread: {
        model: { provider: 'anthropic', model: 'claude-opus-4-8' },
        request_token_usage: {
          'req-1': { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 5000, cache_read_input_tokens: 90000 },
          'req-2': { input_tokens: 800, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 95000 },
        },
        cumulative_token_usage: { input_tokens: 2000, output_tokens: 450 },
      },
    })
    insertThread(db, { id: 'bad-type', dataType: 'protobuf', rawData: Buffer.from('{}') })
    insertThread(db, { id: 'bad-blob', rawData: Buffer.from('not zstd at all') })
    insertThread(db, {
      id: 'legacy',
      dataType: 'json',
      updatedAt: '2026-06-22T11:00:00Z',
      rawData: Buffer.from(JSON.stringify({
        model: { model: 'claude-sonnet-4-6' },
        request_token_usage: { 'req-1': { input_tokens: 40, output_tokens: 8 } },
      })),
    })
    insertThread(db, {
      id: 'zero-usage',
      thread: {
        model: { model: 'claude-opus-4-8' },
        request_token_usage: { 'req-1': { input_tokens: 0, output_tokens: 0 } },
        cumulative_token_usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  })
}

// Captured from the pre-migration zed decode: two per-request calls for
// thread-1 (cumulative exactly covered by the map, no remainder), one call for
// the legacy uncompressed row, and the bad-type/bad-blob/zero-usage rows
// skipped without dropping the healthy threads.
const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'zed',
    model: 'claude-opus-4-8',
    inputTokens: 1200,
    outputTokens: 300,
    cacheCreationInputTokens: 5000,
    cacheReadInputTokens: 90000,
    cachedInputTokens: 90000,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-06-21T09:30:00.000Z',
    speed: 'standard',
    deduplicationKey: 'zed:thread-1:req-1',
    userMessage: 'refactor the parser',
    sessionId: 'thread-1',
  },
  {
    provider: 'zed',
    model: 'claude-opus-4-8',
    inputTokens: 800,
    outputTokens: 150,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 95000,
    cachedInputTokens: 95000,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-06-21T09:30:00.000Z',
    speed: 'standard',
    deduplicationKey: 'zed:thread-1:req-2',
    userMessage: 'refactor the parser',
    sessionId: 'thread-1',
  },
  {
    provider: 'zed',
    model: 'claude-sonnet-4-6',
    inputTokens: 40,
    outputTokens: 8,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2026-06-22T11:00:00.000Z',
    speed: 'standard',
    deduplicationKey: 'zed:legacy:req-1',
    userMessage: 'a thread',
    sessionId: 'legacy',
  },
]

async function collectCalls(dbPath: string, seenKeys = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createZedProvider(dbPath)
  const sources = await provider.discoverSessions()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
      calls.push(call)
    }
  }
  return calls
}

describe.skipIf(skipReason !== null)('zed bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    const dbPath = seedDb()
    expect(await collectCalls(dbPath)).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const dbPath = seedDb()
    const raw = await collectCalls(dbPath)
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('discovery, I/O, and dedup stay CLI-side; the shared seenKeys set dedups', async () => {
    const dbPath = seedDb()
    const seen = new Set<string>()
    const first = await collectCalls(dbPath, seen)
    const second = await collectCalls(dbPath, seen)
    expect(first.length).toBe(3)
    expect(second).toEqual([])
  })

  it('still prints the pre-migration aggregate stderr line for unreadable threads', async () => {
    const dbPath = seedDb()
    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    ;(process.stderr as { write: unknown }).write = (chunk: unknown) => { written.push(String(chunk)); return true }
    try {
      await collectCalls(dbPath)
    } finally {
      ;(process.stderr as { write: unknown }).write = original
    }
    // bad-type (unknown data_type) + bad-blob (zstd decompress throws) = 2.
    expect(written).toEqual(['codeburn: skipped 2 unreadable Zed threads\n'])
  })
})
