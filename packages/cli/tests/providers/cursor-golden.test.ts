import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'node:module'

import {
  createCursorProvider,
  clearCursorWorkspaceMapCache,
} from '../../src/providers/cursor.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'
import type { DateRange } from '../../src/types.js'

const requireForTest = createRequire(import.meta.url)

const skipReason = isSqliteAvailable()
  ? null
  : 'node:sqlite not available — needs Node 22+; skipping'

let tmpDir: string
let originalSuppressCacheWrites: string | undefined
let originalHome: string | undefined
let originalMaxBubbles: string | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cursor-golden-'))
  clearCursorWorkspaceMapCache()
  originalSuppressCacheWrites = process.env['CODEBURN_SUPPRESS_CACHE_WRITES']
  process.env['CODEBURN_SUPPRESS_CACHE_WRITES'] = '1'
  originalMaxBubbles = process.env['CODEBURN_CURSOR_MAX_BUBBLES']
})

afterEach(async () => {
  clearCursorWorkspaceMapCache()
  if (originalSuppressCacheWrites === undefined) {
    delete process.env['CODEBURN_SUPPRESS_CACHE_WRITES']
  } else {
    process.env['CODEBURN_SUPPRESS_CACHE_WRITES'] = originalSuppressCacheWrites
  }
  // G12 overrides the scan budget; vitest reuses a worker across files, so
  // leaving it set would silently change cursor-large-db-cap.test.ts.
  if (originalMaxBubbles === undefined) {
    delete process.env['CODEBURN_CURSOR_MAX_BUBBLES']
  } else {
    process.env['CODEBURN_CURSOR_MAX_BUBBLES'] = originalMaxBubbles
  }
  if (originalHome !== undefined) {
    process.env['HOME'] = originalHome
  } else {
    delete process.env['HOME']
  }
  await rm(tmpDir, { recursive: true, force: true })
})

function buildDb(fn: (db: {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}) => void): string {
  const dbPath = join(tmpDir, 'state.vscdb')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)')
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)')
  fn(db)
  db.close()
  return dbPath
}

function insertBubble(db: {
  prepare(sql: string): { run(...params: unknown[]): void }
}, opts: {
  composerId: string
  bubbleUuid: string
  type: 1 | 2
  text: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  createdAt?: string | null
  requestId?: string
  codeBlocks?: string
}): void {
  const key = `bubbleId:${opts.composerId}:${opts.bubbleUuid}`
  const valueObj: Record<string, unknown> = {
    type: opts.type,
    conversationId: '',
    tokenCount: {
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
    },
    modelInfo: opts.model ? { modelName: opts.model } : undefined,
    text: opts.text,
    codeBlocks: opts.codeBlocks ?? '[]',
    requestId: opts.requestId,
  }
  if (opts.createdAt !== null) {
    valueObj.createdAt = opts.createdAt ?? new Date().toISOString()
  }
  const value = JSON.stringify(valueObj)
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, value)
}

function insertComposerData(db: {
  prepare(sql: string): { run(...params: unknown[]): void }
}, opts: {
  composerId: string
  totalUsedTokens?: number | null
  contextTokensUsed?: number | null
  createdAt?: number
}): void {
  const key = `composerData:${opts.composerId}`
  const breakdown: Record<string, unknown> = {}
  if (opts.totalUsedTokens !== undefined) breakdown.totalUsedTokens = opts.totalUsedTokens
  const value = JSON.stringify({
    promptTokenBreakdown: breakdown,
    contextTokensUsed: opts.contextTokensUsed ?? undefined,
    createdAt: opts.createdAt ?? undefined,
  })
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, value)
}

function insertAgentKv(db: {
  prepare(sql: string): { run(...params: unknown[]): void }
}, opts: {
  blobId: string
  role: string
  content: unknown
  requestId?: string
  model?: string
}): void {
  const key = `agentKv:blob:${opts.blobId}`
  const value = JSON.stringify({
    role: opts.role,
    content: opts.content,
    providerOptions: opts.requestId || opts.model
      ? { cursor: { requestId: opts.requestId, modelName: opts.model } }
      : undefined,
  })
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, value)
}

async function collectCalls(
  provider: ReturnType<typeof createCursorProvider>,
  dbPath: string,
  dateRange?: DateRange,
): Promise<ParsedProviderCall[]> {
  const source = { path: dbPath, project: 'test', provider: 'cursor' as const }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, new Set(), dateRange).parse()) {
    calls.push(call)
  }
  return calls
}

function sortedKeys(call: ParsedProviderCall): string[] {
  return Object.keys(call).sort()
}

const CURSOR_CALL_KEYS = [
  'bashCommands',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'cachedInputTokens',
  'costBasis',
  'costIsEstimated',
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

function wideRange(): DateRange {
  return {
    start: new Date('2025-01-01T00:00:00.000Z'),
    end: new Date('2027-01-01T00:00:00.000Z'),
  }
}

describe.skipIf(skipReason !== null)('cursor golden tests', () => {
  it('G1: arm A full shape with code-block language synthesis', async () => {
    const composerId = 'g1-composer-1111-2222-3333-4444-555566667777'
    const bubbleUuid = 'g1-bubble-1111-2222-3333-4444-555566667777'
    const createdAt = '2026-06-15T10:00:00.000Z'
    const assistantText = 'assistant reply text'
    const dbPath = buildDb((db) => {
      insertBubble(db, {
        composerId,
        bubbleUuid,
        type: 2,
        text: assistantText,
        model: 'claude-4.6-sonnet',
        createdAt,
        codeBlocks: JSON.stringify([
          { languageId: 'ts' },
          { languageId: 'plaintext' },
          { languageId: 'ts' },
        ]),
      })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath, wideRange())

    expect(calls).toHaveLength(1)
    expect(sortedKeys(calls[0]!)).toEqual(CURSOR_CALL_KEYS)
    expect(calls[0]).toEqual({
      provider: 'cursor',
      model: 'claude-4.6-sonnet',
      inputTokens: 0,
      outputTokens: Math.ceil(assistantText.length / 4),
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      pricingModel: 'claude-4.6-sonnet',
      tools: ['cursor:edit', 'lang:ts'],
      bashCommands: [],
      timestamp: createdAt,
      speed: 'standard',
      deduplicationKey: `cursor:bubble:bubbleId:${composerId}:${bubbleUuid}`,
      userMessage: assistantText,
      sessionId: composerId,
    })
  })

  it('G2: text source, both turns, userMessage composition', async () => {
    const composerId = 'g2-composer-1111-2222-3333-4444-555566667777'
    const createdAt = '2026-06-15T10:00:00.000Z'
    const question = 'question text?'
    const reply = 'reply text.'
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId, bubbleUuid: 'u1', type: 1, text: question, createdAt })
      insertBubble(db, { composerId, bubbleUuid: 'a1', type: 2, text: reply, model: 'gpt-5', createdAt })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath, wideRange())

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(sortedKeys(call)).toEqual(CURSOR_CALL_KEYS)
    }

    expect(calls[0]).toEqual({
      provider: 'cursor',
      model: 'gpt-5',
      inputTokens: Math.ceil(question.length / 4),
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      pricingModel: 'gpt-5',
      tools: [],
      bashCommands: [],
      timestamp: createdAt,
      speed: 'standard',
      deduplicationKey: `cursor:bubble:bubbleId:${composerId}:u1`,
      userMessage: `${question} ${question}`,
      sessionId: composerId,
    })

    expect(calls[1]).toEqual({
      provider: 'cursor',
      model: 'gpt-5',
      inputTokens: 0,
      outputTokens: Math.ceil(reply.length / 4),
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      pricingModel: 'gpt-5',
      tools: [],
      bashCommands: [],
      timestamp: createdAt,
      speed: 'standard',
      deduplicationKey: `cursor:bubble:bubbleId:${composerId}:a1`,
      userMessage: `${question} ${reply}`,
      sessionId: composerId,
    })
  })

  it('G3: meter conversation with composer-anchored record', async () => {
    const composerId = 'g3-composer-1111-2222-3333-4444-555566667777'
    const createdAtMs = Date.parse('2026-06-10T12:00:00.000Z')
    const createdAt = new Date(createdAtMs).toISOString()
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: 5000, createdAt: createdAtMs })
      insertBubble(db, { composerId, bubbleUuid: 'u1', type: 1, text: 'first question', createdAt })
      insertBubble(db, { composerId, bubbleUuid: 'a1', type: 2, text: 'first reply', model: 'gpt-5', createdAt })
      insertBubble(db, { composerId, bubbleUuid: 'u2', type: 1, text: 'second question', createdAt })
      insertBubble(db, { composerId, bubbleUuid: 'a2', type: 2, text: 'second reply', model: 'gpt-5', createdAt })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath, wideRange())

    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(sortedKeys(call)).toEqual(CURSOR_CALL_KEYS)
    }

    expect(calls[0]).toEqual({
      provider: 'cursor',
      model: 'gpt-5',
      inputTokens: 0,
      outputTokens: Math.ceil('first reply'.length / 4),
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      pricingModel: 'gpt-5',
      tools: [],
      bashCommands: [],
      timestamp: createdAt,
      speed: 'standard',
      deduplicationKey: `cursor:bubble:bubbleId:${composerId}:a1`,
      userMessage: 'first question first reply',
      sessionId: composerId,
    })

    expect(calls[1]).toEqual({
      provider: 'cursor',
      model: 'gpt-5',
      inputTokens: 0,
      outputTokens: Math.ceil('second reply'.length / 4),
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      pricingModel: 'gpt-5',
      tools: [],
      bashCommands: [],
      timestamp: createdAt,
      speed: 'standard',
      deduplicationKey: `cursor:bubble:bubbleId:${composerId}:a2`,
      userMessage: 'second question second reply',
      sessionId: composerId,
    })

    expect(calls[2]).toEqual({
      provider: 'cursor',
      model: 'gpt-5',
      inputTokens: 5000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      pricingModel: 'gpt-5',
      tools: [],
      bashCommands: [],
      timestamp: createdAt,
      speed: 'standard',
      deduplicationKey: `cursor:composer-input:${composerId}`,
      userMessage: '',
      sessionId: composerId,
    })
  })

  it('G4: meter fallbacks (zero totalUsedTokens + context; absent breakdown)', async () => {
    const composerA = 'g4-a-composer-1111-2222-3333-4444-555566667777'
    const composerB = 'g4-b-composer-1111-2222-3333-4444-555566667777'
    const createdAt = '2026-06-15T10:00:00.000Z'
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId: composerA, totalUsedTokens: 0, contextTokensUsed: 300 })
      insertBubble(db, { composerId: composerA, bubbleUuid: 'u1', type: 1, text: 'prompt a', createdAt })
      insertBubble(db, { composerId: composerA, bubbleUuid: 'a1', type: 2, text: 'reply a', model: 'gpt-5', createdAt })

      insertBubble(db, { composerId: composerB, bubbleUuid: 'u1', type: 1, text: 'prompt b', createdAt })
      insertBubble(db, { composerId: composerB, bubbleUuid: 'a1', type: 2, text: 'reply b', model: 'gpt-5', createdAt })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath, wideRange())

    const metered = calls.find(c => c.sessionId === composerA && c.deduplicationKey === `cursor:composer-input:${composerA}`)
    expect(metered).toBeDefined()
    expect(metered!.inputTokens).toBe(300)

    const textUser = calls.find(c => c.sessionId === composerB && c.deduplicationKey === `cursor:bubble:bubbleId:${composerB}:u1`)
    expect(textUser).toBeDefined()
    expect(textUser!.inputTokens).toBe(Math.ceil('prompt b'.length / 4))

    const composerBInput = calls.find(c => c.deduplicationKey === `cursor:composer-input:${composerB}`)
    expect(composerBInput).toBeUndefined()
  })

  it('G5: stream source, system boundary reset, dropped orphan tool row', async () => {
    const composerId = 'g5-composer-1111-2222-3333-4444-555566667777'
    const requestId = 'req-g5'
    const createdAt = '2026-06-15T10:00:00.000Z'
    const userPrompt = 'the full prompt with injected context'
    const secondPrompt = 'second prompt'
    const systemInfo = 'os info'
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId, bubbleUuid: 'u1', type: 1, text: '', requestId, createdAt })
      insertBubble(db, { composerId, bubbleUuid: 'a1', type: 2, text: 'done', model: 'gpt-5', requestId, createdAt })
      insertAgentKv(db, { blobId: 'tool-orphan', role: 'tool', content: [{ type: 'text', text: 'tool dropped' }] })
      insertAgentKv(db, { blobId: 'user-1', role: 'user', content: userPrompt, requestId })
      insertAgentKv(db, { blobId: 'system-1', role: 'system', content: systemInfo, requestId })
      insertAgentKv(db, { blobId: 'user-2', role: 'user', content: secondPrompt, requestId })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath, wideRange())

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(sortedKeys(call)).toEqual(CURSOR_CALL_KEYS)
    }

    const userChars = userPrompt.length + secondPrompt.length
    const contextChars = systemInfo.length
    const streamInput = Math.ceil((userChars + contextChars) / 4)

    expect(calls[0]).toEqual({
      provider: 'cursor',
      model: 'gpt-5',
      inputTokens: 0,
      outputTokens: Math.ceil('done'.length / 4),
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      pricingModel: 'gpt-5',
      tools: [],
      bashCommands: [],
      timestamp: createdAt,
      speed: 'standard',
      deduplicationKey: `cursor:bubble:bubbleId:${composerId}:a1`,
      userMessage: 'done',
      sessionId: composerId,
    })

    expect(calls[1]).toEqual({
      provider: 'cursor',
      model: 'gpt-5',
      inputTokens: streamInput,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      pricingModel: 'gpt-5',
      tools: [],
      bashCommands: [],
      timestamp: createdAt,
      speed: 'standard',
      deduplicationKey: `cursor:composer-input:${composerId}`,
      userMessage: '',
      sessionId: composerId,
    })
  })

  it('G6: arm C agentKv-only session uses DB mtime as timestamp', async () => {
    const requestId = 'req-headless-g6'
    const prompt = 'run the nightly data export'
    const reply = 'export completed with 3 warnings'
    const mtime = new Date('2026-05-20T08:30:00.000Z')
    const dbPath = buildDb((db) => {
      insertAgentKv(db, { blobId: 'akv-user', role: 'user', content: prompt, requestId })
      insertAgentKv(db, { blobId: 'akv-assistant', role: 'assistant', content: [{ type: 'text', text: reply }], requestId })
    })
    await utimes(dbPath, mtime, mtime)

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath, wideRange())

    expect(calls).toHaveLength(1)
    expect(sortedKeys(calls[0]!)).toEqual(CURSOR_CALL_KEYS)
    expect(calls[0]).toEqual({
      provider: 'cursor',
      model: 'cursor-auto',
      inputTokens: Math.ceil(prompt.length / 4),
      outputTokens: Math.ceil(reply.length / 4),
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      pricingModel: 'claude-sonnet-4-5',
      tools: [],
      bashCommands: [],
      timestamp: mtime.toISOString(),
      speed: 'standard',
      deduplicationKey: `cursor:agentKv:${requestId}`,
      userMessage: '',
      sessionId: requestId,
    })
  })

  it('G7: tools and bash attach to first emitted call only, no Set dedup', async () => {
    const composerId = 'g7-composer-1111-2222-3333-4444-555566667777'
    const requestId = 'req-g7'
    const createdAt = '2026-06-15T10:00:00.000Z'
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId, bubbleUuid: 'u1', type: 1, text: 'do stuff', requestId, inputTokens: 0, outputTokens: 0, createdAt })
      insertBubble(db, { composerId, bubbleUuid: 'a1', type: 2, text: 'doing stuff', model: 'gpt-5', requestId, inputTokens: 0, outputTokens: 900, createdAt })
      insertBubble(db, { composerId, bubbleUuid: 'u2', type: 1, text: 'do more stuff', requestId: 'req-002', inputTokens: 0, outputTokens: 0, createdAt })
      insertBubble(db, { composerId, bubbleUuid: 'a2', type: 2, text: 'doing more stuff', model: 'gpt-5', requestId: 'req-002', inputTokens: 0, outputTokens: 900, createdAt })
      insertAgentKv(db, { blobId: 'user-1', role: 'user', content: 'do stuff', requestId })
      insertAgentKv(db, {
        blobId: 'assistant-1',
        role: 'assistant',
        requestId,
        content: [
          { type: 'tool-call', toolName: 'Read', args: {} },
          { type: 'tool-call', toolName: 'Shell', args: { command: 'npm test' } },
          { type: 'tool-call', toolName: 'Shell', args: { command: 'yarn install' } },
        ],
      })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath, wideRange())

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(sortedKeys(call)).toEqual(CURSOR_CALL_KEYS)
    }

    expect(calls[0]).toEqual({
      provider: 'cursor',
      model: 'gpt-5',
      inputTokens: 0,
      outputTokens: 900,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      pricingModel: 'gpt-5',
      tools: ['Read', 'Bash', 'Bash'],
      bashCommands: ['npm', 'yarn'],
      timestamp: createdAt,
      speed: 'standard',
      deduplicationKey: `cursor:bubble:bubbleId:${composerId}:a1`,
      userMessage: 'do stuff doing stuff',
      sessionId: composerId,
    })

    expect(calls[1]).toEqual({
      provider: 'cursor',
      model: 'gpt-5',
      inputTokens: 0,
      outputTokens: 900,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      pricingModel: 'gpt-5',
      tools: [],
      bashCommands: [],
      timestamp: createdAt,
      speed: 'standard',
      deduplicationKey: `cursor:bubble:bubbleId:${composerId}:a2`,
      userMessage: 'do more stuff doing more stuff',
      sessionId: composerId,
    })
  })

  it('G8: queue pops before skip in metered conversation', async () => {
    const composerId = 'g8-composer-1111-2222-3333-4444-555566667777'
    const createdAt = '2026-06-15T10:00:00.000Z'
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: 5000 })
      insertBubble(db, { composerId, bubbleUuid: 'u1', type: 1, text: 'first question', createdAt })
      insertBubble(db, { composerId, bubbleUuid: 'a1', type: 2, text: 'first reply', model: 'gpt-5', createdAt })
      insertBubble(db, { composerId, bubbleUuid: 'u2', type: 1, text: 'second question', createdAt })
      insertBubble(db, { composerId, bubbleUuid: 'a2', type: 2, text: 'second reply', model: 'gpt-5', createdAt })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath, wideRange())

    const first = calls.find(c => c.userMessage.includes('first reply'))
    const second = calls.find(c => c.userMessage.includes('second reply'))
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first!.userMessage).toBe('first question first reply')
    expect(second!.userMessage).toBe('second question second reply')
  })

  it('G9: skip asymmetry and stderr message', async () => {
    const composerId = 'g9-composer-1111-2222-3333-4444-555566667777'
    const createdAt = '2026-06-15T10:00:00.000Z'
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId, bubbleUuid: 'null-created', type: 2, text: 'null created', model: 'gpt-5', createdAt: null })
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
        'bubbleId:task-call_x\nfc_yyy:bubble-sub',
        JSON.stringify({
          type: 2,
          conversationId: '',
          createdAt,
          tokenCount: { inputTokens: 10, outputTokens: 5 },
          modelInfo: { modelName: 'gpt-5' },
          text: 'cr lf',
          codeBlocks: '[]',
        }),
      )
    })

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath, wideRange())

    expect(calls).toHaveLength(0)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledWith('codeburn: skipped 1 unreadable Cursor entries\n')

    stderrSpy.mockRestore()
  })

  it('G10: model fallbacks (scan inheritance and default -> cursor-auto)', async () => {
    const composerA = 'g10-a-composer-1111-2222-3333-4444-555566667777'
    const composerB = 'g10-b-composer-1111-2222-3333-4444-555566667777'
    const createdAt = '2026-06-15T10:00:00.000Z'
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId: composerA, bubbleUuid: 'u1', type: 1, text: 'prompt', createdAt })
      insertBubble(db, { composerId: composerA, bubbleUuid: 'a1', type: 2, text: 'reply one', model: 'claude-4.6-sonnet', createdAt })
      insertBubble(db, { composerId: composerA, bubbleUuid: 'a2', type: 2, text: 'reply two', createdAt })

      insertBubble(db, { composerId: composerB, bubbleUuid: 'u1', type: 1, text: 'prompt', createdAt })
      insertBubble(db, { composerId: composerB, bubbleUuid: 'a1', type: 2, text: 'reply', model: 'default', createdAt })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath, wideRange())

    const inherited = calls.find(c => c.deduplicationKey === `cursor:bubble:bubbleId:${composerA}:a2`)
    expect(inherited).toBeDefined()
    expect(inherited!.model).toBe('claude-4.6-sonnet')
    expect(inherited!.pricingModel).toBe('claude-4.6-sonnet')

    const defaulted = calls.find(c => c.deduplicationKey === `cursor:bubble:bubbleId:${composerB}:a1`)
    expect(defaulted).toBeDefined()
    expect(defaulted!.model).toBe('cursor-auto')
    expect(defaulted!.pricingModel).toBe('claude-sonnet-4-5')
  })

  it('G11: cache round-trip preserves exact call shape', async () => {
    const composerId = 'g11-composer-1111-2222-3333-4444-555566667777'
    const createdAt = '2026-06-15T10:00:00.000Z'
    const dbPath = buildDb((db) => {
      insertBubble(db, {
        composerId,
        bubbleUuid: 'a1',
        type: 2,
        text: 'cached reply',
        model: 'gpt-5',
        createdAt,
        inputTokens: 100,
        outputTokens: 50,
      })
    })

    delete process.env['CODEBURN_SUPPRESS_CACHE_WRITES']
    originalHome = process.env['HOME']
    process.env['HOME'] = tmpDir

    const readSpy = vi.spyOn(await import('../../src/cursor-cache.js'), 'readCachedResults')

    const provider = createCursorProvider(dbPath)
    const first = await collectCalls(provider, dbPath, wideRange())
    const second = await collectCalls(provider, dbPath, wideRange())

    expect(readSpy).toHaveReturnedWith(expect.anything())
    expect(second.length).toBeGreaterThan(0)

    // The cache survives at version 6, so a call written by one build and read
    // back by another must be shape-identical. `toEqual` cannot see a key that
    // is present with an `undefined` value — and JSON.stringify drops exactly
    // those on the way into cursor-results.json — so it would compare the
    // fresh and cached arrays as equal while the key sets diverged. Gate the
    // key sets explicitly on both sides, and use toStrictEqual for the values.
    expect(first).toStrictEqual(second)
    for (const call of [...first, ...second]) {
      expect(sortedKeys(call)).toEqual(CURSOR_CALL_KEYS)
    }

    readSpy.mockRestore()
  })

  it('G12: paged and un-paged scans produce identical call arrays', async () => {
    const dbPath = buildDb((db) => {
      const old = '2026-01-01T00:00:00.000Z'
      const recent = '2026-07-01T00:00:00.000Z'
      insertBubble(db, { composerId: 'old-1', bubbleUuid: 'b1', type: 2, text: 'old one', model: 'gpt-5', createdAt: old, inputTokens: 10, outputTokens: 5 })
      insertBubble(db, { composerId: 'old-2', bubbleUuid: 'b1', type: 2, text: 'old two', model: 'gpt-5', createdAt: old, inputTokens: 10, outputTokens: 5 })
      insertBubble(db, { composerId: 'new-1', bubbleUuid: 'b1', type: 2, text: 'new one', model: 'gpt-5', createdAt: recent, inputTokens: 10, outputTokens: 5 })
      insertBubble(db, { composerId: 'new-2', bubbleUuid: 'b1', type: 2, text: 'new two', model: 'gpt-5', createdAt: recent, inputTokens: 10, outputTokens: 5 })
    })

    const range: DateRange = { start: new Date('2026-06-01T00:00:00.000Z'), end: new Date('2027-01-01T00:00:00.000Z') }

    const provider = createCursorProvider(dbPath)
    process.env['CODEBURN_CURSOR_MAX_BUBBLES'] = '100'
    const unpaged = await collectCalls(provider, dbPath, range)

    process.env['CODEBURN_CURSOR_MAX_BUBBLES'] = '2'
    const paged = await collectCalls(provider, dbPath, range)

    expect(unpaged).toEqual(paged)
    expect(unpaged).toHaveLength(2)
  })
})
