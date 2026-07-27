import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDevinProvider } from '../../src/providers/devin.js'
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
let originalHome: string | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'devin-bridge-test-'))
  originalHome = process.env['HOME']
  process.env['HOME'] = tmpDir
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  await rm(tmpDir, { recursive: true, force: true })
})

async function configureDevinRate(rate = 1): Promise<void> {
  await mkdir(join(tmpDir, '.config', 'codeburn'), { recursive: true })
  await writeFile(join(tmpDir, '.config', 'codeburn', 'config.json'), JSON.stringify({
    devin: { acuUsdRate: rate },
  }))
}

function createDevinDb(cliDir: string): string {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const dbPath = join(cliDir, 'sessions.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      working_directory TEXT,
      backend_type TEXT,
      model TEXT,
      agent_mode TEXT,
      created_at INTEGER,
      last_activity_at INTEGER,
      title TEXT,
      hidden INTEGER NOT NULL DEFAULT 0
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

async function writeTranscript(name: string, transcript: unknown): Promise<string> {
  const transcriptsDir = join(tmpDir, 'transcripts')
  await mkdir(transcriptsDir, { recursive: true })
  const filePath = join(transcriptsDir, name)
  await writeFile(filePath, JSON.stringify(transcript))
  return filePath
}

async function collect(source: SessionSource): Promise<ParsedProviderCall[]> {
  const provider = createDevinProvider(tmpDir)
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

// Golden captured from the legacy in-CLI decode over the fixture below.
// Covers: transcript JSON parsing, ATIF v1.7 step metrics, user-message
// threading, generation_model display-name resolution, tool_names, sessions.db
// enrichment (project/projectPath/model/timestamp fallback), and per-step
// committed ACU cost converted to costUSD via the configured rate.
const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'devin',
    model: 'Opus 4.6',
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationInputTokens: 10,
    cacheReadInputTokens: 5,
    cachedInputTokens: 5,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.123,
    tools: ['read_file'],
    bashCommands: [],
    timestamp: '2027-01-15T08:00:01.000Z',
    speed: 'standard',
    deduplicationKey: 'devin:bridge-session:2',
    userMessage: 'add devin bridge test',
    sessionId: 'bridge-session',
    project: 'codeburn-bridge',
    projectPath: '/Users/me/projects/codeburn-bridge',
  },
]

skipUnlessSqlite('devin bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    await configureDevinRate()
    const dbPath = createDevinDb(tmpDir)
    withTestDb(dbPath, (db) => {
      db.prepare(`
        INSERT INTO sessions (id, working_directory, model, created_at, last_activity_at, title, hidden)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('bridge-session', '/Users/me/projects/codeburn-bridge', 'claude-sonnet-4-6', 1_800_000_000, 1_800_000_010, 'Bridge Test', 0)
    })

    const filePath = await writeTranscript('bridge-session.json', {
      schema_version: '1.7',
      session_id: 'bridge-session',
      agent: { name: 'devin', version: '2.0', model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          message: 'add devin bridge test',
          metadata: { is_user_input: true, created_at: '2027-01-15T08:00:00.000Z' },
        },
        {
          step_id: 2,
          source: 'assistant',
          model_name: 'step-model',
          message: 'I will read the file first',
          tool_calls: [{ tool_call_id: 'tc1', function_name: 'read_file', arguments: { path: 'src/main.ts' } }],
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.123,
            generation_model: 'claude-opus-4-6',
            metrics: { input_tokens: 100, output_tokens: 20, cache_creation_tokens: 10, cache_read_tokens: 5 },
          },
        },
      ],
    })

    const source: SessionSource = { path: filePath, project: 'devin', provider: 'devin' }
    expect(await collect(source)).toEqual(GOLDEN)
  })

  it('the measured-cost output survives the pricing pass unchanged', async () => {
    await configureDevinRate()
    const dbPath = createDevinDb(tmpDir)
    withTestDb(dbPath, (db) => {
      db.prepare(`
        INSERT INTO sessions (id, working_directory, model, created_at, last_activity_at, title, hidden)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('bridge-session', '/Users/me/projects/codeburn-bridge', 'claude-sonnet-4-6', 1_800_000_000, 1_800_000_010, 'Bridge Test', 0)
    })

    await writeTranscript('bridge-session.json', {
      schema_version: '1.7',
      session_id: 'bridge-session',
      agent: { name: 'devin', version: '2.0' },
      steps: [
        {
          step_id: 2,
          source: 'assistant',
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.123,
            metrics: { input_tokens: 100 },
          },
        },
      ],
    })

    const source: SessionSource = { path: join(tmpDir, 'transcripts', 'bridge-session.json'), project: 'devin', provider: 'devin' }
    const raw = await collect(source)
    const priced = raw.map(priceProviderCall)
    expect(priced).toEqual(raw)
  })

  it('derives the session id from the filename host-side when the transcript omits session_id', async () => {
    // Deriving the id (transcript session_id, else the .json basename) is
    // host-side; the decoder consumes it, so this arm is pinned here.
    await configureDevinRate(1)
    createDevinDb(tmpDir)
    const filePath = await writeTranscript('fallback-session.json', {
      schema_version: '1.7',
      agent: { name: 'devin', version: '2.0' },
      steps: [
        {
          step_id: 1,
          source: 'assistant',
          message: 'working',
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 10 },
          },
        },
      ],
    })

    const source: SessionSource = { path: filePath, project: 'devin', provider: 'devin' }
    const calls = await collect(source)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('fallback-session')
    expect(calls[0]!.deduplicationKey).toBe('devin:fallback-session:1')
  })

  it('dedup threads through the host-owned seenKeys set', async () => {
    await configureDevinRate()
    const dbPath = createDevinDb(tmpDir)
    withTestDb(dbPath, (db) => {
      db.prepare(`
        INSERT INTO sessions (id, working_directory, model, created_at, last_activity_at, title, hidden)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('bridge-session', '/Users/me/projects/codeburn-bridge', 'claude-sonnet-4-6', 1_800_000_000, 1_800_000_010, 'Bridge Test', 0)
    })

    await writeTranscript('bridge-session.json', {
      schema_version: '1.7',
      session_id: 'bridge-session',
      agent: { name: 'devin', version: '2.0' },
      steps: [
        {
          step_id: 2,
          source: 'assistant',
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.123,
            metrics: { input_tokens: 100 },
          },
        },
      ],
    })

    const source: SessionSource = { path: join(tmpDir, 'transcripts', 'bridge-session.json'), project: 'devin', provider: 'devin' }
    const provider = createDevinProvider(tmpDir)
    const seen = new Set<string>()
    const first: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seen).parse()) first.push(call)
    const second: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seen).parse()) second.push(call)
    expect(first).toHaveLength(1)
    expect(second).toEqual([])
  })
})
