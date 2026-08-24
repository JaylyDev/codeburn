import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createGooseProvider } from '../../src/providers/goose.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { buildOtlpPayload, deriveSpanId } from '../../src/sync/otlp.js'
import type { ParsedApiCall } from '../../src/types.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let root: string
const originalRoot = process.env.GOOSE_PATH_ROOT

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-goose-sync-'))
  process.env.GOOSE_PATH_ROOT = root
})

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.GOOSE_PATH_ROOT
  else process.env.GOOSE_PATH_ROOT = originalRoot
  await rm(root, { recursive: true, force: true })
})

const sqliteDescribe = isSqliteAvailable() ? describe : describe.skip

sqliteDescribe('Goose sync project provenance', () => {
  it('carries the exact working_dir and emits only its basename', async () => {
    const dbPath = join(root, 'data', 'sessions', 'sessions.db')
    await mkdir(dirname(dbPath), { recursive: true })
    const { DatabaseSync: Database } = requireForTest('node:sqlite') as {
      DatabaseSync: new (path: string) => TestDb
    }
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        working_dir TEXT,
        created_at TEXT,
        updated_at TEXT,
        accumulated_input_tokens INTEGER,
        accumulated_output_tokens INTEGER,
        provider_name TEXT,
        model_config_json TEXT
      );
      CREATE TABLE messages (
        session_id TEXT,
        message_id TEXT,
        role TEXT,
        content_json TEXT,
        created_timestamp INTEGER
      );
    `)
    db.prepare(`
      INSERT INTO sessions (
        id, name, working_dir, created_at, updated_at,
        accumulated_input_tokens, accumulated_output_tokens,
        provider_name, model_config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'goose-session-1',
      'LLM-authored session title',
      '/Users/alice/company/private-widget',
      '2026-08-23T10:00:00.000Z',
      '2026-08-23T10:01:00.000Z',
      100,
      20,
      'openai',
      JSON.stringify({ model_name: 'gpt-5.4' }),
    )
    db.close()

    const provider = createGooseProvider()
    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(1)
    const calls = []
    for await (const providerCall of provider.createSessionParser(sources[0]!, new Set()).parse()) calls.push(providerCall)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.workingDirectory).toBe('/Users/alice/company/private-widget')

    const raw = calls[0]!
    const parsed: ParsedApiCall = {
      provider: raw.provider,
      model: raw.model,
      usage: {
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        cacheCreationInputTokens: raw.cacheCreationInputTokens,
        cacheReadInputTokens: raw.cacheReadInputTokens,
        cachedInputTokens: raw.cachedInputTokens,
        reasoningTokens: raw.reasoningTokens,
        webSearchRequests: raw.webSearchRequests,
      },
      costUSD: raw.costUSD,
      tools: raw.tools,
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed: raw.speed,
      timestamp: raw.timestamp,
      bashCommands: raw.bashCommands,
      deduplicationKey: raw.deduplicationKey,
    }
    const payload = buildOtlpPayload([{
      call: parsed,
      sessionId: raw.sessionId,
      project: sources[0]!.project,
      workingDirectory: raw.workingDirectory,
    }])
    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    const attributes = Object.fromEntries(span.attributes.map(attribute => [attribute.key, attribute.value]))

    expect(attributes['ai.project']).toEqual({ stringValue: 'private-widget' })
    expect(JSON.stringify(payload)).not.toContain('/Users/alice')
    expect(JSON.stringify(payload)).not.toContain('LLM-authored session title')
    expect(span.spanId).toBe(deriveSpanId(raw.deduplicationKey))
  })
})
