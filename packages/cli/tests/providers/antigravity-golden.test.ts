import { mkdtemp, mkdir, rm, stat, utimes, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import { isSqliteAvailable } from '../../src/sqlite.js'
import {
  createAntigravityProvider,
  getAntigravityStatusLineEventsPath,
  recordAntigravityStatusLinePayload,
  toProviderCall,
} from '../../src/providers/antigravity.js'
import { decodeAntigravityGeneratorMetadata } from '@codeburn/core/providers/antigravity'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

type CurrentCliFixture = {
  conversationId: string
  rows: Array<{ idx: number; hex: string }>
}

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

function createCurrentAntigravityCliDb(dbPath: string, fixture: CurrentCliFixture): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath) as TestDb
  try {
    db.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))')
    db.exec('CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id))')
    db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run(
      'main',
      Buffer.from('file:///Users/example/private-project'),
    )
    for (const row of fixture.rows) {
      const data = Buffer.from(row.hex, 'hex')
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(row.idx, data, data.length)
    }
  } finally {
    db.close()
  }
}

function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}

function tag(field: number, wire: number): number[] {
  return varint(field * 8 + wire)
}

function varintField(field: number, n: number): number[] {
  return [...tag(field, 0), ...varint(n)]
}

function lenField(field: number, bytes: number[]): number[] {
  return [...tag(field, 2), ...varint(bytes.length), ...bytes]
}

function textField(field: number, text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)]
  return lenField(field, bytes)
}

function attrField(key: string, value: string): number[] {
  return lenField(20, [...textField(1, key), ...textField(2, value)])
}

async function withTempAntigravityHome(prefix: string, fn: (tempHome: string) => Promise<void>): Promise<void> {
  const tempHome = await mkdtemp(join(tmpdir(), prefix))
  const previousCacheDir = process.env['CODEBURN_CACHE_DIR']
  process.env['CODEBURN_CACHE_DIR'] = join(tempHome, 'cache')
  try {
    await fn(tempHome)
  } finally {
    if (previousCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
    else process.env['CODEBURN_CACHE_DIR'] = previousCacheDir
    await rm(tempHome, { recursive: true, force: true })
  }
}

async function parseRawCallsFromDb(dbPath: string, project = 'antigravity-cli'): Promise<ParsedProviderCall[]> {
  const parser = createAntigravityProvider().createSessionParser(
    { path: dbPath, project, provider: 'antigravity' },
    new Set(),
  )
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

function sortedKeys(call: ParsedProviderCall): string[] {
  return Object.keys(call).sort()
}

const sqliteCallKeys = [
  'bashCommands',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'cachedInputTokens',
  'costBasis',
  'deduplicationKey',
  'inputTokens',
  'model',
  'outputTokens',
  'pricingModel',
  'project',
  'provider',
  'reasoningTokens',
  'sessionId',
  'speed',
  'timestamp',
  'tools',
  'userMessage',
  'webSearchRequests',
]

const statusLineCallKeys = sqliteCallKeys

const rpcCallKeys = [
  'bashCommands',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'cachedInputTokens',
  'costBasis',
  'deduplicationKey',
  'inputTokens',
  'model',
  'outputTokens',
  'pricingModel',
  'provider',
  'reasoningTokens',
  'sessionId',
  'speed',
  'timestamp',
  'tools',
  'userMessage',
  'webSearchRequests',
]

describe('antigravity golden tests', () => {
  it('G1: shipped 1-row fixture produces the exact baseline call', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-g1-', async (tempHome) => {
      const fixture = JSON.parse(
        await readFile(new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url), 'utf-8'),
      ) as CurrentCliFixture
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, fixture)

      const mtime = new Date('2026-01-15T12:00:00.000Z')
      await utimes(dbPath, mtime, mtime)

      const calls = await parseRawCallsFromDb(dbPath)

      expect(calls).toHaveLength(1)
      expect(sortedKeys(calls[0]!)).toEqual(sqliteCallKeys)
      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'gemini-3.1-pro-high',
        inputTokens: 30265,
        outputTokens: 659,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 71,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'gemini-3.1-pro',
        tools: [],
        bashCommands: [],
        timestamp: '2026-01-15T12:00:00.000Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:fixture-current-cli:fixture-response-1',
        userMessage: '',
        sessionId: 'fixture-current-cli',
        project: 'antigravity-cli',
      })
    })
  })

  it('G2: per-cascade seenResponseIds deduplicates identical response ids', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-g2-', async (tempHome) => {
      const usage = lenField(4, [...varintField(2, 100), ...varintField(3, 10), ...textField(11, 'dup-response')])
      const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
      const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

      const conversationId = 'g2-dedup'
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, {
        conversationId,
        rows: [
          { idx: 0, hex },
          { idx: 1, hex },
        ],
      })

      const mtime = new Date('2026-01-15T12:00:00.000Z')
      await utimes(dbPath, mtime, mtime)

      const calls = await parseRawCallsFromDb(dbPath)

      expect(calls).toHaveLength(1)
      expect(sortedKeys(calls[0]!)).toEqual(sqliteCallKeys)
      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'gemini-3.1-pro-high',
        inputTokens: 100,
        outputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'gemini-3.1-pro',
        tools: [],
        bashCommands: [],
        timestamp: '2026-01-15T12:00:00.000Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:g2-dedup:dup-response',
        userMessage: '',
        sessionId: 'g2-dedup',
        project: 'antigravity-cli',
      })
    })
  })

  it('G3: responseTokens falls back to totalOutputTokens when split fields are absent', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-g3-', async (tempHome) => {
      const usage = lenField(4, [...varintField(2, 50), ...varintField(3, 500)])
      const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
      const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

      const conversationId = 'g3-total-output'
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, { conversationId, rows: [{ idx: 0, hex }] })

      const mtime = new Date('2026-01-15T12:00:00.000Z')
      await utimes(dbPath, mtime, mtime)

      const calls = await parseRawCallsFromDb(dbPath)

      expect(calls).toHaveLength(1)
      expect(sortedKeys(calls[0]!)).toEqual(sqliteCallKeys)
      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'gemini-3.1-pro-high',
        inputTokens: 50,
        outputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'gemini-3.1-pro',
        tools: [],
        bashCommands: [],
        timestamp: '2026-01-15T12:00:00.000Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:g3-total-output:0',
        userMessage: '',
        sessionId: 'g3-total-output',
        project: 'antigravity-cli',
      })
    })
  })

  it('G4: output split adjust arm reconciles response + thinking to total', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-g4-', async (tempHome) => {
      const usage = lenField(4, [
        ...varintField(2, 80),
        ...varintField(3, 100),
        ...varintField(9, 10),
        ...varintField(10, 30),
      ])
      const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
      const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

      const conversationId = 'g4-adjust'
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, { conversationId, rows: [{ idx: 0, hex }] })

      const mtime = new Date('2026-01-15T12:00:00.000Z')
      await utimes(dbPath, mtime, mtime)

      const calls = await parseRawCallsFromDb(dbPath)

      expect(calls).toHaveLength(1)
      expect(sortedKeys(calls[0]!)).toEqual(sqliteCallKeys)
      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'gemini-3.1-pro-high',
        inputTokens: 80,
        outputTokens: 70,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 30,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'gemini-3.1-pro',
        tools: [],
        bashCommands: [],
        timestamp: '2026-01-15T12:00:00.000Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:g4-adjust:0',
        userMessage: '',
        sessionId: 'g4-adjust',
        project: 'antigravity-cli',
      })
    })
  })

  it('G5: inputTokens falls back to field #1 when field #2 is absent', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-g5-', async (tempHome) => {
      const usage = lenField(4, [...varintField(1, 777), ...varintField(3, 5)])
      const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
      const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

      const conversationId = 'g5-input-fallback'
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, { conversationId, rows: [{ idx: 0, hex }] })

      const mtime = new Date('2026-01-15T12:00:00.000Z')
      await utimes(dbPath, mtime, mtime)

      const calls = await parseRawCallsFromDb(dbPath)

      expect(calls).toHaveLength(1)
      expect(sortedKeys(calls[0]!)).toEqual(sqliteCallKeys)
      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'gemini-3.1-pro-high',
        inputTokens: 777,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'gemini-3.1-pro',
        tools: [],
        bashCommands: [],
        timestamp: '2026-01-15T12:00:00.000Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:g5-input-fallback:0',
        userMessage: '',
        sessionId: 'g5-input-fallback',
        project: 'antigravity-cli',
      })
    })
  })

  it('G6: responseId falls back to row idx when field #11 is absent', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-g6-', async (tempHome) => {
      const usage = lenField(4, [...varintField(2, 33), ...varintField(3, 3)])
      const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
      const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

      const conversationId = 'g6-response-id-fallback'
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, { conversationId, rows: [{ idx: 3, hex }] })

      const mtime = new Date('2026-01-15T12:00:00.000Z')
      await utimes(dbPath, mtime, mtime)

      const calls = await parseRawCallsFromDb(dbPath)

      expect(calls).toHaveLength(1)
      expect(sortedKeys(calls[0]!)).toEqual(sqliteCallKeys)
      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'gemini-3.1-pro-high',
        inputTokens: 33,
        outputTokens: 3,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'gemini-3.1-pro',
        tools: [],
        bashCommands: [],
        timestamp: '2026-01-15T12:00:00.000Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:g6-response-id-fallback:3',
        userMessage: '',
        sessionId: 'g6-response-id-fallback',
        project: 'antigravity-cli',
      })
    })
  })

  it('G7: model precedence and placeholder guard produce distinct canonical models', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-g7-', async (tempHome) => {
      const conversationId = 'g7-model-precedence'
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${conversationId}.db`)

      const baseUsage = lenField(4, [...varintField(2, 10), ...varintField(3, 1)])

      // (a) #19 only
      const aChat = [
        ...baseUsage,
        ...textField(19, 'gemini-3.1-pro-high'),
      ]
      const aHex = Buffer.from(lenField(1, aChat)).toString('hex')

      // (b) no #19, model_enum attr only
      const bChat = [
        ...baseUsage,
        ...attrField('model_enum', 'gemini-3.5-flash-agent'),
      ]
      const bHex = Buffer.from(lenField(1, bChat)).toString('hex')

      // (c) no #19/no attr, #21 only
      const cChat = [...baseUsage, ...textField(21, 'Gemini 3 Flash')]
      const cHex = Buffer.from(lenField(1, cChat)).toString('hex')

      // (d) none
      const dChat = [...baseUsage]
      const dHex = Buffer.from(lenField(1, dChat)).toString('hex')

      // (e) #19 placeholder with no #21
      const eChat = [...baseUsage, ...textField(19, 'MODEL_PLACEHOLDER_M99')]
      const eHex = Buffer.from(lenField(1, eChat)).toString('hex')

      createCurrentAntigravityCliDb(dbPath, {
        conversationId,
        rows: [
          { idx: 0, hex: aHex },
          { idx: 1, hex: bHex },
          { idx: 2, hex: cHex },
          { idx: 3, hex: dHex },
          { idx: 4, hex: eHex },
        ],
      })

      const mtime = new Date('2026-01-15T12:00:00.000Z')
      await utimes(dbPath, mtime, mtime)

      const calls = await parseRawCallsFromDb(dbPath)

      expect(calls).toHaveLength(5)
      for (const call of calls) {
        expect(sortedKeys(call)).toEqual(sqliteCallKeys)
      }

      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'gemini-3.1-pro-high',
        inputTokens: 10,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'gemini-3.1-pro',
        tools: [],
        bashCommands: [],
        timestamp: '2026-01-15T12:00:00.000Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:g7-model-precedence:0',
        userMessage: '',
        sessionId: 'g7-model-precedence',
        project: 'antigravity-cli',
      })

      expect(calls[1]).toEqual({
        provider: 'antigravity',
        model: 'gemini-3.5-flash-agent',
        inputTokens: 10,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'gemini-3.5-flash',
        tools: [],
        bashCommands: [],
        timestamp: '2026-01-15T12:00:00.000Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:g7-model-precedence:1',
        userMessage: '',
        sessionId: 'g7-model-precedence',
        project: 'antigravity-cli',
      })

      expect(calls[2]).toEqual({
        provider: 'antigravity',
        model: 'gemini-3-flash',
        inputTokens: 10,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'gemini-3-flash',
        tools: [],
        bashCommands: [],
        timestamp: '2026-01-15T12:00:00.000Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:g7-model-precedence:2',
        userMessage: '',
        sessionId: 'g7-model-precedence',
        project: 'antigravity-cli',
      })

      expect(calls[3]).toEqual({
        provider: 'antigravity',
        model: 'unknown',
        inputTokens: 10,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'unknown',
        tools: [],
        bashCommands: [],
        timestamp: '2026-01-15T12:00:00.000Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:g7-model-precedence:3',
        userMessage: '',
        sessionId: 'g7-model-precedence',
        project: 'antigravity-cli',
      })

      expect(calls[4]).toEqual({
        provider: 'antigravity',
        model: 'unknown',
        inputTokens: 10,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'unknown',
        tools: [],
        bashCommands: [],
        timestamp: '2026-01-15T12:00:00.000Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:g7-model-precedence:4',
        userMessage: '',
        sessionId: 'g7-model-precedence',
        project: 'antigravity-cli',
      })
    })
  })

  it('G8: chatStartMetadata.created_at beats file mtime', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-g8-', async (tempHome) => {
      const seconds = 1783326234
      const nanos = 724675400
      const timestamp = [...varintField(1, seconds), ...varintField(2, nanos)]
      const chatStartMetadata = lenField(4, timestamp)
      const usage = lenField(4, [...varintField(2, 100), ...varintField(3, 50)])
      const chatModel = [...usage, ...lenField(9, chatStartMetadata)]
      const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

      const conversationId = 'g8-created-at'
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, { conversationId, rows: [{ idx: 0, hex }] })

      const mtime = new Date('2026-01-01T00:00:00.000Z')
      await utimes(dbPath, mtime, mtime)

      const calls = await parseRawCallsFromDb(dbPath)

      expect(calls).toHaveLength(1)
      expect(sortedKeys(calls[0]!)).toEqual(sqliteCallKeys)
      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'unknown',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'unknown',
        tools: [],
        bashCommands: [],
        timestamp: '2026-07-06T08:23:54.724Z',
        speed: 'standard',
        deduplicationKey: 'antigravity:g8-created-at:0',
        userMessage: '',
        sessionId: 'g8-created-at',
        project: 'antigravity-cli',
      })
    })
  })

  it('G9: zero input and output tokens skip the row', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-g9-', async (tempHome) => {
      const usage = lenField(4, [...varintField(2, 0), ...varintField(3, 0)])
      const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
      const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

      const conversationId = 'g9-zero'
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, { conversationId, rows: [{ idx: 0, hex }] })

      const calls = await parseRawCallsFromDb(dbPath)

      expect(calls).toEqual([])
    })
  })

  it('G10: statusline singleton skip, monotonic delta, and turnIndex/dedupKey', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-g10-'))
    process.env['CODEBURN_CACHE_DIR'] = dir

    const basePayload = {
      conversation_id: 'statusline-g10',
      session_id: 'session-1',
      model: 'Gemini 3.5 Flash (High)',
    }

    const withUsage = (
      input_tokens: number,
      output_tokens: number,
      cache_read_input_tokens = 0,
    ) => ({
      ...basePayload,
      context_window: {
        current_usage: {
          input_tokens,
          output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens,
        },
      },
    })

    try {
      expect(await recordAntigravityStatusLinePayload(withUsage(100, 10))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(200, 20))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(200, 20))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(300, 30, 50))).toBe(true)

      const recorded = (await readFile(getAntigravityStatusLineEventsPath(), 'utf-8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as { at: string })

      const source = {
        path: getAntigravityStatusLineEventsPath(),
        project: 'antigravity-cli',
        provider: 'antigravity' as const,
      }
      const parser = createAntigravityProvider().createSessionParser(source, new Set())
      const calls: ParsedProviderCall[] = []
      for await (const call of parser.parse()) calls.push(call)

      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(sortedKeys(call)).toEqual(statusLineCallKeys)
        expect(call.project).toBe('antigravity-cli')
        expect(call.projectPath).toBeUndefined()
      }

      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'Gemini 3.5 Flash (High)',
        inputTokens: 200,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'Gemini 3.5 Flash (High)',
        tools: [],
        bashCommands: [],
        timestamp: recorded[2]!.at,
        speed: 'standard',
        deduplicationKey:
          'antigravity-statusline:statusline-g10:0:Gemini 3.5 Flash (High):200:20:0:0',
        userMessage: '',
        sessionId: 'statusline-g10',
        project: 'antigravity-cli',
      })

      expect(calls[1]).toEqual({
        provider: 'antigravity',
        model: 'Gemini 3.5 Flash (High)',
        inputTokens: 100,
        outputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 50,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'Gemini 3.5 Flash (High)',
        tools: [],
        bashCommands: [],
        timestamp: recorded[3]!.at,
        speed: 'standard',
        deduplicationKey:
          'antigravity-statusline:statusline-g10:1:Gemini 3.5 Flash (High):300:30:0:50',
        userMessage: '',
        sessionId: 'statusline-g10',
        project: 'antigravity-cli',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('G11: non-monotonic usage resets to the full snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-g11-'))
    process.env['CODEBURN_CACHE_DIR'] = dir

    const basePayload = {
      conversation_id: 'statusline-g11',
      session_id: 'session-1',
      model: 'Gemini 3.5 Flash (High)',
    }

    const withUsage = (
      input_tokens: number,
      output_tokens: number,
      cache_read_input_tokens = 0,
    ) => ({
      ...basePayload,
      context_window: {
        current_usage: {
          input_tokens,
          output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens,
        },
      },
    })

    try {
      expect(await recordAntigravityStatusLinePayload(withUsage(1000, 100))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(1000, 100))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(200, 30, 500))).toBe(true)

      const recorded = (await readFile(getAntigravityStatusLineEventsPath(), 'utf-8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as { at: string })

      const source = {
        path: getAntigravityStatusLineEventsPath(),
        project: 'antigravity-cli',
        provider: 'antigravity' as const,
      }
      const parser = createAntigravityProvider().createSessionParser(source, new Set())
      const calls: ParsedProviderCall[] = []
      for await (const call of parser.parse()) calls.push(call)

      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(sortedKeys(call)).toEqual(statusLineCallKeys)
      }

      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'Gemini 3.5 Flash (High)',
        inputTokens: 1000,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'Gemini 3.5 Flash (High)',
        tools: [],
        bashCommands: [],
        timestamp: recorded[1]!.at,
        speed: 'standard',
        deduplicationKey:
          'antigravity-statusline:statusline-g11:0:Gemini 3.5 Flash (High):1000:100:0:0',
        userMessage: '',
        sessionId: 'statusline-g11',
        project: 'antigravity-cli',
      })

      expect(calls[1]).toEqual({
        provider: 'antigravity',
        model: 'Gemini 3.5 Flash (High)',
        inputTokens: 200,
        outputTokens: 30,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 500,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'Gemini 3.5 Flash (High)',
        tools: [],
        bashCommands: [],
        timestamp: recorded[2]!.at,
        speed: 'standard',
        deduplicationKey:
          'antigravity-statusline:statusline-g11:1:Gemini 3.5 Flash (High):200:30:0:500',
        userMessage: '',
        sessionId: 'statusline-g11',
        project: 'antigravity-cli',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('G12: antigravity: prefix in seenKeys skips the whole conversation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-g12-'))
    process.env['CODEBURN_CACHE_DIR'] = dir

    try {
      expect(await recordAntigravityStatusLinePayload({
        conversation_id: 'rpc-covered-g12',
        session_id: 'session-1',
        model: 'Gemini 3.5 Flash (High)',
        context_window: {
          current_usage: {
            input_tokens: 1000,
            output_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })).toBe(true)

      const source = {
        path: getAntigravityStatusLineEventsPath(),
        project: 'antigravity-cli',
        provider: 'antigravity' as const,
      }
      const parser = createAntigravityProvider().createSessionParser(
        source,
        new Set(['antigravity:rpc-covered-g12:0']),
      )
      const calls: ParsedProviderCall[] = []
      for await (const call of parser.parse()) calls.push(call)

      expect(calls).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('G13: only the last repeated run survives singleton skip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-g13-'))
    process.env['CODEBURN_CACHE_DIR'] = dir

    const basePayload = {
      conversation_id: 'statusline-g13',
      session_id: 'session-1',
      model: 'Gemini 3.5 Flash (High)',
    }

    const withUsage = (
      input_tokens: number,
      output_tokens: number,
    ) => ({
      ...basePayload,
      context_window: {
        current_usage: {
          input_tokens,
          output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })

    try {
      expect(await recordAntigravityStatusLinePayload(withUsage(100, 10))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(200, 20))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(300, 30))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(300, 30))).toBe(true)

      const recorded = (await readFile(getAntigravityStatusLineEventsPath(), 'utf-8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as { at: string })

      const source = {
        path: getAntigravityStatusLineEventsPath(),
        project: 'antigravity-cli',
        provider: 'antigravity' as const,
      }
      const parser = createAntigravityProvider().createSessionParser(source, new Set())
      const calls: ParsedProviderCall[] = []
      for await (const call of parser.parse()) calls.push(call)

      expect(calls).toHaveLength(1)
      expect(sortedKeys(calls[0]!)).toEqual(statusLineCallKeys)
      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'Gemini 3.5 Flash (High)',
        inputTokens: 300,
        outputTokens: 30,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'Gemini 3.5 Flash (High)',
        tools: [],
        bashCommands: [],
        timestamp: recorded[3]!.at,
        speed: 'standard',
        deduplicationKey:
          'antigravity-statusline:statusline-g13:0:Gemini 3.5 Flash (High):300:30:0:0',
        userMessage: '',
        sessionId: 'statusline-g13',
        project: 'antigravity-cli',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // The emit loop increments turnIndex AFTER building the dedup key but BEFORE
  // the seenKeys check, and updates previousSnapshotUsage before either. A run
  // that is skipped because its key is already seen therefore still consumes a
  // turn index and still advances the delta baseline. Both orderings are
  // invisible unless a statusline key is pre-seeded, which is what this does.
  it('G15: a seenKeys-skipped run still consumes its turn index and advances the delta baseline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-g15-'))
    process.env['CODEBURN_CACHE_DIR'] = dir

    const basePayload = {
      conversation_id: 'statusline-g15',
      session_id: 'session-1',
      model: 'Gemini 3.5 Flash (High)',
    }

    const withUsage = (input_tokens: number, output_tokens: number) => ({
      ...basePayload,
      context_window: {
        current_usage: {
          input_tokens,
          output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })

    try {
      expect(await recordAntigravityStatusLinePayload(withUsage(100, 10))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(100, 10))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(300, 30))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(300, 30))).toBe(true)

      const recorded = (await readFile(getAntigravityStatusLineEventsPath(), 'utf-8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as { at: string })

      const source = {
        path: getAntigravityStatusLineEventsPath(),
        project: 'antigravity-cli',
        provider: 'antigravity' as const,
      }
      const parser = createAntigravityProvider().createSessionParser(
        source,
        new Set(['antigravity-statusline:statusline-g15:0:Gemini 3.5 Flash (High):100:10:0:0']),
      )
      const calls: ParsedProviderCall[] = []
      for await (const call of parser.parse()) calls.push(call)

      expect(calls).toHaveLength(1)
      expect(sortedKeys(calls[0]!)).toEqual(statusLineCallKeys)
      expect(calls[0]).toEqual({
        provider: 'antigravity',
        model: 'Gemini 3.5 Flash (High)',
        // 300-100 / 30-10: the skipped run still moved the delta baseline.
        inputTokens: 200,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costBasis: 'estimated',
        pricingModel: 'Gemini 3.5 Flash (High)',
        tools: [],
        bashCommands: [],
        timestamp: recorded[3]!.at,
        speed: 'standard',
        // turnIndex 1, not 0: the skipped run consumed index 0.
        deduplicationKey:
          'antigravity-statusline:statusline-g15:1:Gemini 3.5 Flash (High):300:30:0:0',
        userMessage: '',
        sessionId: 'statusline-g15',
        project: 'antigravity-cli',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('G14: RPC generator metadata decode handles skips, fallbacks, model map, and timestamps', () => {
    const modelMap = {
      'raw-model-a': 'gemini-3-pro',
      'placeholder-key': 'MODEL_PLACEHOLDER_7',
    }

    const metadata = [
      // lacks chatModel.usage -> skipped
      { chatModel: { model: 'no-usage' } },
      // zero tokens -> skipped
      {
        chatModel: {
          model: 'zero',
          usage: {
            model: 'zero',
            inputTokens: '0',
            outputTokens: '0',
            apiProvider: 'google',
          },
        },
      },
      // responseId absent -> index fallback
      {
        chatModel: {
          model: 'unmapped-model-a',
          usage: {
            model: 'unmapped-model-a',
            inputTokens: '100',
            outputTokens: '20',
            responseOutputTokens: '15',
            thinkingOutputTokens: '5',
            apiProvider: 'google',
          },
        },
      },
      // usage.model IS in modelMap
      {
        chatModel: {
          model: 'raw-model-a',
          usage: {
            model: 'raw-model-a',
            inputTokens: '50',
            outputTokens: '10',
            responseOutputTokens: '8',
            thinkingOutputTokens: '2',
            apiProvider: 'google',
            responseId: 'mapped-call',
          },
        },
      },
      // usage.model is NOT in modelMap -> raw passthrough
      {
        chatModel: {
          model: 'unmapped-model-b',
          usage: {
            model: 'unmapped-model-b',
            inputTokens: '77',
            outputTokens: '7',
            responseOutputTokens: '6',
            thinkingOutputTokens: '1',
            apiProvider: 'google',
            responseId: 'raw-passthrough-call',
          },
        },
      },
      // mapped value is MODEL_PLACEHOLDER_* -> unknown
      {
        chatModel: {
          model: 'placeholder-key',
          usage: {
            model: 'placeholder-key',
            inputTokens: '25',
            outputTokens: '5',
            responseOutputTokens: '4',
            thinkingOutputTokens: '1',
            apiProvider: 'google',
            responseId: 'placeholder-call',
          },
        },
      },
      // createdAt set
      {
        chatModel: {
          model: 'with-timestamp',
          usage: {
            model: 'with-timestamp',
            inputTokens: '99',
            outputTokens: '9',
            responseOutputTokens: '9',
            apiProvider: 'google',
            responseId: 'timestamp-call',
          },
          chatStartMetadata: { createdAt: '2026-03-15T09:30:00.000Z' },
        },
      },
      // createdAt not set
      {
        chatModel: {
          model: 'no-timestamp',
          usage: {
            model: 'no-timestamp',
            inputTokens: '11',
            outputTokens: '2',
            responseOutputTokens: '2',
            apiProvider: 'google',
            responseId: 'no-timestamp-call',
          },
        },
      },
    ]

    const { calls: richCalls } = decodeAntigravityGeneratorMetadata({
      records: metadata as never,
      context: { privacyKey: '', providerId: 'antigravity', sourceRef: 'g14-rpc' },
      cascadeId: 'g14-rpc',
      modelMap,
    })
    const calls = richCalls.map(c => toProviderCall(c))

    expect(calls).toHaveLength(6)
    for (const call of calls) {
      expect(sortedKeys(call)).toEqual(rpcCallKeys)
    }

    expect(calls[0]).toEqual({
      provider: 'antigravity',
      model: 'unmapped-model-a',
      inputTokens: 100,
      outputTokens: 15,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 5,
      webSearchRequests: 0,
      costBasis: 'estimated',
      pricingModel: 'unmapped-model-a',
      tools: [],
      bashCommands: [],
      timestamp: '',
      speed: 'standard',
      deduplicationKey: 'antigravity:g14-rpc:2',
      userMessage: '',
      sessionId: 'g14-rpc',
    })

    expect(calls[1]).toEqual({
      provider: 'antigravity',
      model: 'gemini-3-pro',
      inputTokens: 50,
      outputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 2,
      webSearchRequests: 0,
      costBasis: 'estimated',
      pricingModel: 'gemini-3-pro',
      tools: [],
      bashCommands: [],
      timestamp: '',
      speed: 'standard',
      deduplicationKey: 'antigravity:g14-rpc:mapped-call',
      userMessage: '',
      sessionId: 'g14-rpc',
    })

    expect(calls[2]).toEqual({
      provider: 'antigravity',
      model: 'unmapped-model-b',
      inputTokens: 77,
      outputTokens: 6,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 1,
      webSearchRequests: 0,
      costBasis: 'estimated',
      pricingModel: 'unmapped-model-b',
      tools: [],
      bashCommands: [],
      timestamp: '',
      speed: 'standard',
      deduplicationKey: 'antigravity:g14-rpc:raw-passthrough-call',
      userMessage: '',
      sessionId: 'g14-rpc',
    })

    expect(calls[3]).toEqual({
      provider: 'antigravity',
      model: 'unknown',
      inputTokens: 25,
      outputTokens: 4,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 1,
      webSearchRequests: 0,
      costBasis: 'estimated',
      pricingModel: 'unknown',
      tools: [],
      bashCommands: [],
      timestamp: '',
      speed: 'standard',
      deduplicationKey: 'antigravity:g14-rpc:placeholder-call',
      userMessage: '',
      sessionId: 'g14-rpc',
    })

    expect(calls[4]).toEqual({
      provider: 'antigravity',
      model: 'with-timestamp',
      inputTokens: 99,
      outputTokens: 9,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      pricingModel: 'with-timestamp',
      tools: [],
      bashCommands: [],
      timestamp: '2026-03-15T09:30:00.000Z',
      speed: 'standard',
      deduplicationKey: 'antigravity:g14-rpc:timestamp-call',
      userMessage: '',
      sessionId: 'g14-rpc',
    })

    expect(calls[5]).toEqual({
      provider: 'antigravity',
      model: 'no-timestamp',
      inputTokens: 11,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      pricingModel: 'no-timestamp',
      tools: [],
      bashCommands: [],
      timestamp: '',
      speed: 'standard',
      deduplicationKey: 'antigravity:g14-rpc:no-timestamp-call',
      userMessage: '',
      sessionId: 'g14-rpc',
    })
  })
})
