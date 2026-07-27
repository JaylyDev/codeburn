import { describe, expect, it } from 'vitest'

import { decodeQuickdesk, toObservations } from '../../src/providers/quickdesk/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type {
  QuickdeskDatabaseInput,
  QuickdeskMetricsInput,
  QuickdeskSessionMetadata,
} from '../../src/providers/quickdesk/types.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'quickdesk', sourceRef: 'ref' }

function makeSession(overrides: Partial<QuickdeskSessionMetadata> = {}): QuickdeskSessionMetadata {
  return {
    id: 'sess-a',
    title: 'Test',
    agentMode: 'agent',
    createdAt: 1783987200,
    deleted: false,
    firstUserMessage: 'hello',
    inputChars: 0,
    outputChars: 0,
    tools: [],
    ...overrides,
  }
}

function makeMetricsInput(overrides: Partial<QuickdeskMetricsInput> = {}): QuickdeskMetricsInput {
  return {
    variant: 'metrics',
    records: [],
    sessions: new Map(),
    project: 'default',
    projectPath: '/Users/me/projects/codeburn',
    fileId: 'metrics-2026-07-14.jsonl',
    ...overrides,
  }
}

function makeDatabaseInput(overrides: Partial<QuickdeskDatabaseInput> = {}): QuickdeskDatabaseInput {
  return {
    variant: 'database',
    sessions: [],
    meteredSessionIds: new Set(),
    project: 'default',
    projectPath: '/Users/me/projects/codeburn',
    ...overrides,
  }
}

describe('quickdesk rich decode (moved to @codeburn/core)', () => {
  it('decodes a metrics record into a cost-free rich call', () => {
    const input = makeMetricsInput({
      records: [
        { record: { Model: 'claude-sonnet-4-5', InputTokens: 120, OutputTokens: 30, CostUSD: 0.0042 } },
      ],
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('quickdesk')
    expect(call.model).toBe('claude-sonnet-4-5')
    expect(call.inputTokens).toBe(120)
    expect(call.outputTokens).toBe(30)
    expect(call.recordedCost).toBe(0.0042)
    expect(call.project).toBe('default')
    expect(call.projectPath).toBe('/Users/me/projects/codeburn')
  })

  it('estimates cost when metrics record lacks CostUSD', () => {
    const input = makeMetricsInput({
      records: [{ record: { Model: 'claude-sonnet-4-5', InputTokens: 40, OutputTokens: 10 } }],
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!).not.toHaveProperty('recordedCost')
  })

  it('links sqlite session metadata to metrics by session_id', () => {
    const sessions = new Map<string, QuickdeskSessionMetadata>()
    sessions.set('linked', makeSession({
      id: 'linked',
      firstUserMessage: 'linked prompt',
      tools: ['read_file'],
    }))
    const input = makeMetricsInput({
      records: [{ record: { session_id: 'linked', Model: 'claude-sonnet-4-5', InputTokens: 10, OutputTokens: 5 } }],
      sessions,
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.userMessage).toBe('linked prompt')
    expect(calls[0]!.tools).toEqual(['Read'])
    expect(calls[0]!.sessionId).toBe('linked')
  })

  it('merges tools from metrics ToolName and linked session metadata', () => {
    const sessions = new Map<string, QuickdeskSessionMetadata>()
    sessions.set('merged', makeSession({ id: 'merged', tools: ['write_file'] }))
    const input = makeMetricsInput({
      records: [
        { record: { session_id: 'merged', ToolName: 'read_file' } },
        { record: { session_id: 'merged', Model: 'claude-sonnet-4-5', InputTokens: 10, OutputTokens: 5 } },
      ],
      sessions,
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['Read', 'Edit'])
  })

  it('dedups metrics calls via the live seenKeys set', () => {
    const input = makeMetricsInput({
      records: [{ record: { Model: 'claude-sonnet-4-5', InputTokens: 10, OutputTokens: 5 } }],
    })
    const seen = new Set<string>()
    const first = decodeQuickdesk({ records: [input], context, seenKeys: seen }).calls
    expect(first).toHaveLength(1)
    const again = decodeQuickdesk({ records: [input], context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('skips deleted linked sessions', () => {
    const sessions = new Map<string, QuickdeskSessionMetadata>()
    sessions.set('deleted', makeSession({ id: 'deleted', deleted: true }))
    const input = makeMetricsInput({
      records: [{ record: { session_id: 'deleted', Model: 'claude-sonnet-4-5', InputTokens: 10, OutputTokens: 5 } }],
      sessions,
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(0)
  })

  it('keeps metrics records with zero tokens because usageRecord does not filter them', () => {
    const input = makeMetricsInput({
      records: [{ record: { Model: 'claude-sonnet-4-5', InputTokens: 0, OutputTokens: 0 } }],
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(0)
    expect(calls[0]!.outputTokens).toBe(0)
  })

  it('skips metrics records missing required fields', () => {
    const input = makeMetricsInput({
      records: [
        { record: { Model: 'claude-sonnet-4-5', InputTokens: 10 } },
        { record: { InputTokens: 10, OutputTokens: 5 } },
      ],
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(0)
  })

  it('decodes database sessions into estimated rich calls', () => {
    const input = makeDatabaseInput({
      sessions: [makeSession({ id: 'db-sess', inputChars: 12, outputChars: 8, firstUserMessage: 'db prompt', tools: ['Bash'] })],
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('quickdesk-auto')
    expect(calls[0]!.inputTokens).toBe(3)
    expect(calls[0]!.outputTokens).toBe(2)
    expect(calls[0]!.tools).toEqual(['Bash'])
    expect(calls[0]!.userMessage).toBe('db prompt')
    expect(calls[0]!).not.toHaveProperty('recordedCost')
  })

  it('skips database sessions with zero estimated tokens', () => {
    const input = makeDatabaseInput({
      sessions: [makeSession({ id: 'empty', inputChars: 0, outputChars: 0 })],
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(0)
  })

  it('skips metered database sessions', () => {
    const input = makeDatabaseInput({
      sessions: [makeSession({ id: 'metered', inputChars: 12, outputChars: 8 })],
      meteredSessionIds: new Set(['metered']),
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(0)
  })

  it('skips deleted database sessions', () => {
    const input = makeDatabaseInput({
      sessions: [makeSession({ id: 'deleted', inputChars: 12, outputChars: 8, deleted: true })],
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(0)
  })

  it('treats millisecond created_at values as milliseconds', () => {
    const input = makeDatabaseInput({
      sessions: [makeSession({ id: 'ms', createdAt: 1783987200000, inputChars: 4, outputChars: 4 })],
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.timestamp).toBe('2026-07-14T00:00:00.000Z')
  })

  it('dedups database calls via the live seenKeys set', () => {
    const input = makeDatabaseInput({
      sessions: [makeSession({ id: 'db-sess', inputChars: 12, outputChars: 8 })],
    })
    const seen = new Set<string>()
    const first = decodeQuickdesk({ records: [input], context, seenKeys: seen }).calls
    expect(first).toHaveLength(1)
    const again = decodeQuickdesk({ records: [input], context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('maps tool names through the quickdesk tool-name map', () => {
    const input = makeMetricsInput({
      records: [
        { record: { session_id: 'tools', ToolName: 'readFile' } },
        { record: { session_id: 'tools', ToolName: 'runCommand' } },
        { record: { session_id: 'tools', ToolName: 'unknownTool' } },
        { record: { session_id: 'tools', Model: 'claude-sonnet-4-5', InputTokens: 10, OutputTokens: 5 } },
      ],
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls[0]!.tools).toEqual(['Read', 'Bash', 'unknownTool'])
  })

  it('falls back to file-date timestamp when _aws.Timestamp is absent', () => {
    const input = makeMetricsInput({
      records: [{ record: { Model: 'claude-sonnet-4-5', InputTokens: 10, OutputTokens: 5 } }],
      fileId: 'metrics-2026-05-01.jsonl',
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    expect(calls[0]!.timestamp).toBe('2026-05-01T00:00:00.000Z')
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const input = makeMetricsInput({
      records: [{ record: { Model: 'claude-sonnet-4-5', InputTokens: 10, OutputTokens: 5 } }],
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/me/projects/codeburn', calls },
      { privacyKey: 'test-privacy-key', provider: 'quickdesk' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
  })

  it('toObservations emits measured cost when recordedCost is present', () => {
    const input = makeMetricsInput({
      records: [{ record: { Model: 'claude-sonnet-4-5', InputTokens: 10, OutputTokens: 5, CostUSD: 0.001 } }],
    })
    const { calls } = decodeQuickdesk({ records: [input], context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/me/projects/codeburn', calls },
      { privacyKey: 'test-privacy-key', provider: 'quickdesk' },
    )
    const call = sessions[0]!.calls[0]!
    expect(call.costBasis).toBe('measured')
    expect(call.measuredCostUSD).toBe(0.001)
  })
})
