import { mkdtemp, rm } from 'fs/promises'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWarpProvider } from '../../src/providers/warp.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

type QueryFixture = {
  exchangeId: string
  conversationId: string
  startTs: string
  input: string
  outputStatus?: string
  modelId?: string
  workingDirectory?: string | null
}

type BlockFixture = {
  blockId: string
  conversationId: string
  startTs: string
  completedTs: string
  exitCode: number
  command: string
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'warp-provider-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function createWarpDb(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'warp.sqlite')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      conversation_data TEXT NOT NULL,
      last_modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      start_ts DATETIME NOT NULL,
      input TEXT NOT NULL,
      working_directory TEXT,
      output_status TEXT NOT NULL,
      model_id TEXT NOT NULL DEFAULT '',
      planning_model_id TEXT NOT NULL DEFAULT '',
      coding_model_id TEXT NOT NULL DEFAULT ''
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pane_leaf_uuid BLOB NOT NULL,
      stylized_command BLOB NOT NULL,
      stylized_output BLOB NOT NULL,
      pwd TEXT,
      git_branch TEXT,
      virtual_env TEXT,
      conda_env TEXT,
      exit_code INTEGER NOT NULL,
      did_execute BOOLEAN NOT NULL,
      completed_ts DATETIME,
      start_ts DATETIME,
      ps1 TEXT,
      honor_ps1 BOOLEAN NOT NULL DEFAULT 0,
      shell TEXT,
      user TEXT,
      host TEXT,
      is_background BOOLEAN NOT NULL DEFAULT 0,
      rprompt TEXT,
      prompt_snapshot TEXT,
      block_id TEXT NOT NULL DEFAULT '',
      ai_metadata TEXT,
      is_local BOOLEAN,
      agent_view_visibility TEXT,
      git_branch_name TEXT
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

function insertConversation(
  db: TestDb,
  conversationId: string,
  conversationData: unknown,
  lastModifiedAt = '2026-05-18 10:10:00',
): void {
  db.prepare(
    'INSERT INTO agent_conversations (conversation_id, conversation_data, last_modified_at) VALUES (?, ?, ?)',
  ).run(conversationId, JSON.stringify(conversationData), lastModifiedAt)
}

function insertQuery(db: TestDb, q: QueryFixture): void {
  db.prepare(
    `INSERT INTO ai_queries (
      exchange_id, conversation_id, start_ts, input, working_directory, output_status, model_id, planning_model_id, coding_model_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '')`,
  ).run(
    q.exchangeId,
    q.conversationId,
    q.startTs,
    q.input,
    q.workingDirectory ?? null,
    q.outputStatus ?? '"Completed"',
    q.modelId ?? 'auto-efficient',
  )
}

function insertBlock(db: TestDb, b: BlockFixture): void {
  db.prepare(
    `INSERT INTO blocks (
      pane_leaf_uuid, stylized_command, stylized_output, exit_code, did_execute,
      completed_ts, start_ts, block_id, ai_metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Buffer.from([0]),
    b.command,
    '',
    b.exitCode,
    1,
    b.completedTs,
    b.startTs,
    b.blockId,
    JSON.stringify({
      requested_command_action_id: `call-${b.blockId}`,
      conversation_id: b.conversationId,
    }),
  )
}

async function buildFixtureDb(dir: string): Promise<string> {
  const dbPath = createWarpDb(dir)
  withTestDb(dbPath, (db) => {
    insertConversation(db, 'conv-1', {
      conversation_usage_metadata: {
        token_usage: [
          {
            model_id: 'GPT-5.3 Codex (medium reasoning)',
            warp_tokens: 300,
            byok_tokens: 0,
            warp_token_usage_by_category: { primary_agent: 300 },
            byok_token_usage_by_category: {},
          },
          {
            model_id: 'Claude Haiku 4.5',
            warp_tokens: 90,
            byok_tokens: 0,
            warp_token_usage_by_category: { full_terminal_use: 90 },
            byok_token_usage_by_category: {},
          },
        ],
      },
    })
    insertQuery(db, {
      exchangeId: 'ex-1',
      conversationId: 'conv-1',
      startTs: '2026-05-18 10:00:00.000000',
      input: JSON.stringify([{ Query: { text: 'short prompt' } }]),
      modelId: 'auto-efficient',
      workingDirectory: '/Users/test/project-a',
    })
    insertQuery(db, {
      exchangeId: 'ex-2',
      conversationId: 'conv-1',
      startTs: '2026-05-18 10:03:00.000000',
      input: JSON.stringify([{ Query: { text: 'longer prompt with substantially more detail for weighting' } }]),
      modelId: 'auto-efficient',
      workingDirectory: '/Users/test/project-a',
    })

    insertConversation(db, 'conv-2', {
      conversation_usage_metadata: {
        token_usage: [
          {
            model_id: 'GPT-5.3 Codex (medium reasoning)',
            warp_tokens: 120,
            byok_tokens: 0,
            warp_token_usage_by_category: { primary_agent: 120 },
            byok_token_usage_by_category: {},
          },
        ],
      },
    })
    insertQuery(db, {
      exchangeId: 'ex-a',
      conversationId: 'conv-2',
      startTs: '2026-05-18 11:00:00.000000',
      input: JSON.stringify([{ Query: { text: 'run tests' } }]),
    })
    insertQuery(db, {
      exchangeId: 'ex-b',
      conversationId: 'conv-2',
      startTs: '2026-05-18 11:05:00.000000',
      input: JSON.stringify([{ Query: { text: 'summarize results' } }]),
    })
    insertBlock(db, {
      blockId: 'block-1',
      conversationId: 'conv-2',
      startTs: '2026-05-18 11:01:00.000000',
      completedTs: '2026-05-18 11:01:04.000000',
      exitCode: 0,
      command: 'npm test && git status',
    })
  })
  return dbPath
}

async function collect(dbPath: string): Promise<ParsedProviderCall[]> {
  const provider = createWarpProvider(dbPath)
  const sources: SessionSource[] = await provider.discoverSessions()
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

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

// Byte-identical parity gate for the warp bridge migration (phase 8). The
// GOLDEN below was captured from the legacy in-CLI decode run over the fixture
// above. Covers: token-budget allocation from conversation-level usage,
// model-alias resolution, command-block attribution to the nearest preceding
// exchange, Bash tool mapping + base-name extraction, and project path shaping.
const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'warp',
    model: 'gpt-5.3-codex',
    inputTokens: 50,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    costIsEstimated: true,
    tools: [],
    bashCommands: [],
    timestamp: '2026-05-18T10:00:00.000Z',
    speed: 'standard',
    deduplicationKey: 'warp:conv-1:ex-1',
    userMessage: 'short prompt',
    sessionId: 'conv-1',
    project: 'Users-test-project-a',
    projectPath: '/Users/test/project-a',
  },
  {
    provider: 'warp',
    model: 'gpt-5.3-codex',
    inputTokens: 250,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    costIsEstimated: true,
    tools: [],
    bashCommands: [],
    timestamp: '2026-05-18T10:03:00.000Z',
    speed: 'standard',
    deduplicationKey: 'warp:conv-1:ex-2',
    userMessage: 'longer prompt with substantially more detail for weighting',
    sessionId: 'conv-1',
    project: 'Users-test-project-a',
    projectPath: '/Users/test/project-a',
  },
  {
    provider: 'warp',
    model: 'gpt-5.3-codex',
    inputTokens: 45,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    costIsEstimated: true,
    tools: ['Bash'],
    bashCommands: ['npm', 'git'],
    timestamp: '2026-05-18T11:00:00.000Z',
    speed: 'standard',
    deduplicationKey: 'warp:conv-2:ex-a',
    userMessage: 'run tests',
    sessionId: 'conv-2',
    project: 'warp',
  },
  {
    provider: 'warp',
    model: 'gpt-5.3-codex',
    inputTokens: 75,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    costIsEstimated: true,
    tools: [],
    bashCommands: [],
    timestamp: '2026-05-18T11:05:00.000Z',
    speed: 'standard',
    deduplicationKey: 'warp:conv-2:ex-b',
    userMessage: 'summarize results',
    sessionId: 'conv-2',
    project: 'warp',
  },
]

skipUnlessSqlite('warp bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    const dbPath = await buildFixtureDb(tmpDir)
    expect(await collect(dbPath)).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const dbPath = await buildFixtureDb(tmpDir)
    const raw = await collect(dbPath)
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      expect(call.costBasis).toBe('estimated')
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('toolDisplayName never resolves an inherited Object member', () => {
    // Guard against re-expressing the run_command check as a bare object
    // lookup: 'constructor'/'toString'/'__proto__' would then resolve to
    // inherited members instead of passing through unchanged.
    const provider = createWarpProvider('/nonexistent.sqlite')
    expect(provider.toolDisplayName('run_command')).toBe('Bash')
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(provider.toolDisplayName(name)).toBe(name)
    }
  })

  it('dedup threads through the host-owned seenKeys set', async () => {
    const dbPath = await buildFixtureDb(tmpDir)
    const provider = createWarpProvider(dbPath)
    const sources = await provider.discoverSessions()
    sources.sort((a, b) => a.path.localeCompare(b.path))
    const seen = new Set<string>()
    const first: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) first.push(call)
    }
    const second: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) second.push(call)
    }
    expect(first.length).toBe(4)
    expect(second).toEqual([])
  })
})
