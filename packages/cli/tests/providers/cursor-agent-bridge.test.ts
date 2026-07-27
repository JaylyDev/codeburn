import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { createCursorAgentProvider } from '../../src/providers/cursor-agent.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { estimateTokensFromChars } from '../../src/token-estimate.js'
import type { ParsedProviderCall, Provider, SessionSource } from '../../src/providers/types.js'
import { isSqliteAvailable } from '../../src/sqlite.js'

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

const FIXED_UUID = '123e4567-e89b-12d3-a456-426614174000'

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tempRoots: string[] = []

beforeEach(() => {
  tempRoots = []
})

afterEach(async () => {
  await Promise.all(tempRoots.filter(existsSync).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeBaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-agent-bridge-test-'))
  tempRoots.push(dir)
  return dir
}

async function collect(provider: Provider, source: SessionSource): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = require('node:sqlite')
  const db = new Database(dbPath)
  fn(db)
  db.close()
}

async function buildFixture(baseDir: string): Promise<void> {
  const transcriptDir = join(baseDir, 'projects', 'my-proj', 'agent-transcripts')
  const aiTrackingDir = join(baseDir, 'ai-tracking')
  await mkdir(transcriptDir, { recursive: true })
  await mkdir(aiTrackingDir, { recursive: true })

  const userText = 'explain parser output'
  const assistantText = 'first line\nsecond line'
  const transcriptPath = join(transcriptDir, `${FIXED_UUID}.txt`)

  await writeFile(
    transcriptPath,
    `user:\n<user_query>${userText}</user_query>\nA:\n${assistantText}\n`,
  )

  const dbPath = join(aiTrackingDir, 'ai-code-tracking.db')
  withTestDb(dbPath, (db) => {
    db.exec('CREATE TABLE conversation_summaries (conversationId TEXT, title TEXT, tldr TEXT, model TEXT, mode TEXT, updatedAt INTEGER)')
    db.prepare('INSERT INTO conversation_summaries (conversationId, title, tldr, model, mode, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(FIXED_UUID, 'Demo title', '', 'claude-4.6-sonnet', 'agent', 1735689600000)
  })
}

describe('cursor-agent bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    const baseDir = await makeBaseDir()
    await buildFixture(baseDir)

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const raw = await collect(provider, source)

    // Golden captured from the unmodified cursor-agent provider over this fixture.
    const userText = 'explain parser output'
    const assistantText = 'first line\nsecond line'
    const GOLDEN: ParsedProviderCall[] = [
      {
        provider: 'cursor-agent',
        model: 'claude-4.6-sonnet',
        inputTokens: estimateTokensFromChars(userText.length),
        outputTokens: estimateTokensFromChars(assistantText.length),
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        tools: [],
        bashCommands: [],
        timestamp: '2025-01-01T00:00:00.000Z',
        speed: 'standard',
        deduplicationKey: `cursor-agent:${FIXED_UUID}:0`,
        userMessage: userText,
        sessionId: FIXED_UUID,
      },
    ]

    expect(raw).toEqual(GOLDEN)
  })

  it('derives a sha1 session id host-side for a non-uuid transcript filename', async () => {
    // The uuid-stem-vs-sha1 choice is host-side; the decoder consumes the id
    // the host derived, so this arm is pinned here rather than in core.
    const baseDir = await makeBaseDir()
    const transcriptDir = join(baseDir, 'projects', 'my-proj', 'agent-transcripts')
    await mkdir(transcriptDir, { recursive: true })
    await writeFile(
      join(transcriptDir, 'not-a-uuid.txt'),
      'user:\n<user_query>hello</user_query>\nA:\nworld\n',
    )

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const calls = await collect(provider, source)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toMatch(/^[0-9a-f]{16}$/)
    expect(calls[0]!.deduplicationKey).toBe(`cursor-agent:${calls[0]!.sessionId}:0`)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const baseDir = await makeBaseDir()
    await buildFixture(baseDir)

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const raw = await collect(provider, source)
    const priced = raw.map(priceProviderCall)

    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('dedup threads through the host-owned seenKeys set', async () => {
    const baseDir = await makeBaseDir()
    await buildFixture(baseDir)

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const seen = new Set<string>()

    const first: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seen).parse()) first.push(call)
    const second: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seen).parse()) second.push(call)

    expect(first).toHaveLength(1)
    expect(second).toEqual([])
  })
})
