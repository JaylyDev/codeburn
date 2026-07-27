import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { quickdesk } from '../../src/providers/quickdesk.js'
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
let originalQuickworkHome: string | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'quickdesk-bridge-test-'))
  originalQuickworkHome = process.env['QUICKWORK_HOME']
  process.env['QUICKWORK_HOME'] = tmpDir
})

afterEach(async () => {
  if (originalQuickworkHome === undefined) delete process.env['QUICKWORK_HOME']
  else process.env['QUICKWORK_HOME'] = originalQuickworkHome
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeMetrics(basePath: string, date: string, lines: Array<Record<string, unknown> | string>): Promise<string> {
  const metricsDir = join(basePath, 'metrics')
  await mkdir(metricsDir, { recursive: true })
  const path = join(metricsDir, `metrics-${date}.jsonl`)
  await writeFile(path, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n')
  return path
}

async function createSessionsDb(basePath: string): Promise<string> {
  const sessionsDir = join(basePath, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const dbPath = join(sessionsDir, 'sessions.db')
  const { DatabaseSync: Database } = requireForTest('node:sqlite') as {
    DatabaseSync: new (path: string) => TestDb
  }
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at REAL,
      updated_at REAL,
      message_count INTEGER,
      agent_mode TEXT,
      deleted_at REAL
    )
  `)
  db.exec(`
    CREATE TABLE session_messages (
      session_id TEXT,
      role TEXT,
      content TEXT,
      timestamp REAL,
      tool_names TEXT
    )
  `)
  db.close()
  return dbPath
}

function withDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite') as {
    DatabaseSync: new (path: string) => TestDb
  }
  const db = new Database(dbPath)
  try {
    fn(db)
  } finally {
    db.close()
  }
}

async function collect(): Promise<ParsedProviderCall[]> {
  const sources: SessionSource[] = await quickdesk.discoverSessions()
  sources.sort((a, b) => a.path.localeCompare(b.path))
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of quickdesk.createSessionParser(source, seen).parse()) {
      calls.push(call)
    }
  }
  return calls
}

async function buildFixture(): Promise<void> {
  const profileBase = join(tmpDir, 'profiles', 'bridge-data')
  await mkdir(join(tmpDir, 'profiles'), { recursive: true })
  await writeFile(
    join(tmpDir, 'profiles.json'),
    JSON.stringify({ last_active: 'bridge-profile', entries: [{ id: 'bridge-profile', data_path: 'profiles/bridge-data' }] }),
  )

  const dbPath = await createSessionsDb(profileBase)
  withDb(dbPath, db => {
    db.prepare(
      'INSERT INTO sessions (id, title, created_at, updated_at, message_count, agent_mode, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('bridge-metered', 'Metered session', 1783987200, 1783987300, 2, 'agent', null)
    db.prepare(
      'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
    ).run('bridge-metered', 'user', 'metered prompt', 1783987201, null)
    db.prepare(
      'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
    ).run('bridge-metered', 'assistant', 'metered answer', 1783987202, '["read_file"]')

    db.prepare(
      'INSERT INTO sessions (id, title, created_at, updated_at, message_count, agent_mode, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('bridge-estimate', 'Estimate session', 1783900800, 1783900900, 3, 'agent', null)
    db.prepare(
      'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
    ).run('bridge-estimate', 'user', 'estimate prompt', 1783900801, null)
    db.prepare(
      'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
    ).run('bridge-estimate', 'tool', 'tool output', 1783900802, '["run_command"]')
    db.prepare(
      'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
    ).run('bridge-estimate', 'assistant', 'estimate answer', 1783900803, null)

    db.prepare(
      'INSERT INTO sessions (id, title, created_at, updated_at, message_count, agent_mode, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('bridge-deleted', 'Deleted session', 1784073600, 1784073700, 2, 'agent', 1784073800)
    db.prepare(
      'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
    ).run('bridge-deleted', 'user', 'deleted prompt', 1784073601, null)
    db.prepare(
      'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
    ).run('bridge-deleted', 'assistant', 'deleted answer', 1784073602, null)
  })

  await writeMetrics(profileBase, '2026-07-14', [
    { session_id: 'bridge-metered', ToolName: 'write_file' },
    {
      _aws: { Timestamp: 1783987200123 },
      session_id: 'bridge-metered',
      thread_id: 'thread-1',
      Model: 'claude-sonnet-4-5',
      InputTokens: 120,
      OutputTokens: 30,
      CostUSD: 0.0042,
    },
  ])
}



function golden(): ParsedProviderCall[] {
  const projectPath = join(tmpDir, 'profiles', 'bridge-data')
  return [
    {
      provider: 'quickdesk',
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      bashCommands: [],
      speed: 'standard',
      project: 'bridge-profile',
      projectPath,
      model: 'claude-sonnet-4-5',
      inputTokens: 120,
      outputTokens: 30,
      costUSD: 0.0042,
      costBasis: 'measured',
      costIsEstimated: false,
      tools: ['Edit', 'Read'],
      timestamp: '2026-07-14T00:00:00.123Z',
      deduplicationKey: 'quickdesk:bridge-metered:2026-07-14T00:00:00.123Z:claude-sonnet-4-5:120:30',
      userMessage: 'metered prompt',
      sessionId: 'bridge-metered',
    },
    {
      provider: 'quickdesk',
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      bashCommands: [],
      speed: 'standard',
      project: 'bridge-profile',
      projectPath,
      model: 'quickdesk-auto',
      inputTokens: 7,
      outputTokens: 4,
      costBasis: 'estimated',
      costIsEstimated: true,
      tools: ['Bash'],
      timestamp: '2026-07-13T00:00:00.000Z',
      deduplicationKey: 'quickdesk-est:bridge-estimate',
      userMessage: 'estimate prompt',
      sessionId: 'bridge-estimate',
    },
  ]
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('quickdesk bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    await buildFixture()
    expect(await collect()).toEqual(golden())
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    await buildFixture()
    const raw = await collect()
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      if (raw[i]!.costBasis === 'measured') {
        // Measured calls already carry costUSD from the provider; pricing leaves them byte-identical.
        expect(call).toEqual(raw[i])
      } else {
        const { costUSD, ...rest } = call
        expect(rest).toEqual(raw[i])
      }
    })
  })

  it('dedup threads through the host-owned seenKeys set', async () => {
    await buildFixture()
    const sources = await quickdesk.discoverSessions()
    sources.sort((a, b) => a.path.localeCompare(b.path))
    const seen = new Set<string>()
    const first: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of quickdesk.createSessionParser(source, seen).parse()) first.push(call)
    }
    const second: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of quickdesk.createSessionParser(source, seen).parse()) second.push(call)
    }
    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual([])
  })
})
