import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { createRequire } from 'node:module'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { isSqliteAvailable } from '../src/sqlite.js'

// The exported Hermes provider resolves HERMES_HOME when its singleton is
// created, at import time. Point it at the fixture during module hoisting so the
// provider reads the temp DB instead of the real ~/.hermes.
const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/hermes-cost-fallback-${process.pid}-${Date.now()}`
  process.env['HERMES_HOME'] = `${root}/hermes`
  return root
})
const HERMES_HOME = join(testRoot, 'hermes')
const CACHE_DIR = join(testRoot, 'cache')

const requireForTest = createRequire(import.meta.url)

function seedDb(): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(join(HERMES_HOME, 'state.db'))
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT, model TEXT, cwd TEXT, git_repo_root TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0, estimated_cost_usd REAL, actual_cost_usd REAL,
      api_call_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
      started_at REAL, title TEXT
    )
  `)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_calls TEXT, timestamp REAL NOT NULL
    )
  `)
  const startedAt = Date.now() / 1000 - 3600
  const insert = db.prepare(
    `INSERT INTO sessions (id, source, model, input_tokens, output_tokens,
      estimated_cost_usd, actual_cost_usd, api_call_count, started_at)
     VALUES (?, 'cli', ?, ?, ?, ?, ?, 1, ?)`,
  )
  // Hermes writes estimated 0.0 when cost_status is 'unknown' or 'included'
  // (subscription). CodeBurn must not trust that $0: the tokens are real, so
  // cost falls through to the token-based calculation.
  insert.run('zero-estimate', 'claude-opus-4-6', 100000, 10000, 0.0, null, startedAt)
  // A positive recorded estimate stays authoritative.
  insert.run('positive-estimate', 'claude-opus-4-6', 100000, 10000, 0.5, null, startedAt)
  // An explicit $0 *actual* invoice amount is recorded fact and stays $0.
  insert.run('zero-actual', 'claude-opus-4-6', 100000, 10000, null, 0.0, startedAt)
  for (const id of ['zero-estimate', 'positive-estimate', 'zero-actual']) {
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run(id, 'user', `session ${id}`, startedAt)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run(id, 'assistant', 'ok', startedAt + 1)
  }
  db.close()
}

beforeEach(async () => {
  clearSessionCache()
  await rm(testRoot, { recursive: true, force: true })
  await mkdir(HERMES_HOME, { recursive: true })
  process.env['HERMES_HOME'] = HERMES_HOME
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
})

afterEach(async () => {
  clearSessionCache()
  await rm(testRoot, { recursive: true, force: true })
})

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('hermes recorded-cost fallback', () => {
  it('ignores a $0 estimated cost and calculates from tokens', async () => {
    seedDb()
    const projects = await parseAllSessions(undefined, 'hermes')
    const sessions = projects.flatMap(project => project.sessions)
    const byId = new Map(sessions.map(s => [s.sessionId, s]))

    const zeroEstimate = byId.get('zero-estimate')!
    expect(zeroEstimate.totalCostUSD).toBeGreaterThan(0)

    const positive = byId.get('positive-estimate')!
    expect(positive.totalCostUSD).toBe(0.5)

    const zeroActual = byId.get('zero-actual')!
    expect(zeroActual.totalCostUSD).toBe(0)
  })
})
