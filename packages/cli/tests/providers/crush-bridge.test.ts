import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createCrushProvider } from '../../src/providers/crush.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

// Byte-identical parity gate for the crush bridge migration (phase 8, Category
// B / sqlite). Crush is not present in the frozen corpus, so a committed
// fixture golden is THE parity gate: the bridged provider (sqlite driver + SQL
// queries CLI-side, pure row->call decode delegated to
// @codeburn/core/providers/crush) must reproduce exactly what the
// pre-migration in-CLI decode produced for this fixture DB. The GOLDEN below
// was captured from the legacy provider before the migration.

const requireForTest = createRequire(import.meta.url)

// CREATE TABLE statements taken verbatim from charmbracelet/crush@v0.66.1
// internal/db/migrations/20250424200609_initial.sql (same fixture shape as
// tests/providers/crush.test.ts).
function createCrushDb(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'crush.db')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      title TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
      prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
      completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
      cost REAL NOT NULL DEFAULT 0.0 CHECK (cost >= 0.0),
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      summary_message_id TEXT,
      todos TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      parts TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER,
      provider TEXT,
      is_summary_message INTEGER DEFAULT 0 NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    )
  `)
  db.close()
  return dbPath
}

function seed(dbPath: string): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    db.prepare(`
      INSERT INTO sessions (id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-alpha', null, 'test session', 3, 1500, 420, 0.0921, 1_700_000_100, 1_700_000_555)
    for (const [id, model, ts] of [['m1', 'claude-sonnet-4-6', 1_700_000_100], ['m2', 'claude-sonnet-4-6', 1_700_000_200], ['m3', 'gpt-5', 1_700_000_300]] as const) {
      db.prepare(`INSERT INTO messages (id, session_id, role, parts, model, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, ?, ?)`)
        .run(id, 'sess-alpha', 'assistant', model, ts, ts)
    }
    // No cost -> estimated fallback.
    db.prepare(`
      INSERT INTO sessions (id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-beta', null, 'test session 2', 1, 300, 80, 0, 1_700_000_600, 1_700_000_600)
  } finally {
    db.close()
  }
}

// Captured from the pre-migration crush decode (dominant model wins among
// tied assistant messages, measured cost from the DB, estimated fallback when
// cost is 0). `costUSD` in the GOLDEN below is the raw decoder output
// (pre-pricing-pass); the second test proves the pricing pass adds costUSD to
// the estimated row and leaves the measured row untouched.
const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'crush',
    model: 'claude-sonnet-4-6',
    inputTokens: 1500,
    outputTokens: 420,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.0921,
    costBasis: 'measured',
    tools: [],
    bashCommands: [],
    timestamp: '2023-11-14T22:22:35.000Z',
    speed: 'standard',
    deduplicationKey: 'crush:sess-alpha',
    userMessage: '',
    sessionId: 'sess-alpha',
  },
  {
    provider: 'crush',
    model: 'unknown',
    inputTokens: 300,
    outputTokens: 80,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    timestamp: '2023-11-14T22:23:20.000Z',
    speed: 'standard',
    deduplicationKey: 'crush:sess-beta',
    userMessage: '',
    sessionId: 'sess-beta',
  },
]

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'crush-bridge-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

async function collect(): Promise<ParsedProviderCall[]> {
  const projectDir = join(tmpRoot, 'project-alpha')
  const dbPath = createCrushDb(join(projectDir, '.crush'))
  seed(dbPath)

  const globalData = join(tmpRoot, 'crush-global')
  await mkdir(globalData, { recursive: true })
  await writeFile(join(globalData, 'projects.json'), JSON.stringify({
    'proj-a': { path: projectDir, data_dir: '.crush' },
  }))
  process.env['CRUSH_GLOBAL_DATA'] = globalData

  const provider = createCrushProvider()
  const sources = await provider.discoverSessions()
  sources.sort((a, b) => a.path.localeCompare(b.path))
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) {
      calls.push(call)
    }
  }
  return calls
}

describe.skipIf(!isSqliteAvailable())('crush bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    expect(await collect()).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD (for the estimated row) filled in', async () => {
    const raw = await collect()
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      const { costUSD, ...rest } = call
      const { costUSD: rawCostUSD, ...rawRest } = raw[i]!
      expect(rest).toEqual(rawRest)
      // The measured row's costUSD is untouched; the estimated row's is filled in.
      if (raw[i]!.costBasis === 'measured') expect(costUSD).toBe(rawCostUSD)
    })
  })

  it('discovery, I/O, and dedup stay CLI-side; the shared seenKeys set dedups', async () => {
    const projectDir = join(tmpRoot, 'project-alpha')
    const dbPath = createCrushDb(join(projectDir, '.crush'))
    seed(dbPath)
    const globalData = join(tmpRoot, 'crush-global')
    await mkdir(globalData, { recursive: true })
    await writeFile(join(globalData, 'projects.json'), JSON.stringify({ 'proj-a': { path: projectDir, data_dir: '.crush' } }))
    process.env['CRUSH_GLOBAL_DATA'] = globalData

    const provider = createCrushProvider()
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    const first: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) first.push(call)
    }
    const second: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) second.push(call)
    }
    expect(first.length).toBe(2)
    expect(second).toEqual([])
  })
})
