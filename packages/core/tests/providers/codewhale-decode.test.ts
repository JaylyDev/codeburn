import { describe, expect, it } from 'vitest'

import { decodeCodeWhale, toObservations } from '../../src/providers/codewhale/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { CodeWhaleSessionRecords } from '../../src/providers/codewhale/types.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'codewhale', sourceRef: 'ref' }

function session(opts: Partial<CodeWhaleSessionRecords> = {}): CodeWhaleSessionRecords {
  return {
    metadata: {
      id: 'session-a',
      created_at: '2026-07-14T10:00:00.000Z',
      updated_at: '2026-07-15T12:34:56.000Z',
      total_tokens: 12345,
      model: 'anthropic/claude-sonnet-4-6',
      model_provider: 'anthropic',
      workspace: '/Users/alice/codewhale-demo',
      cost: { session_cost_usd: 0.75, subagent_cost_usd: 0.20 },
      ...opts.metadata,
    },
    messages: opts.messages ?? [],
    fileMtime: opts.fileMtime ?? '2026-07-15T10:00:00.000Z',
  }
}

describe('codewhale rich decode (moved to @codeburn/core)', () => {
  it('decodes one cumulative session with measured cost and tool sequence', () => {
    const records: CodeWhaleSessionRecords[] = [
      session({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Implement the parser' }] },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '...' },
              { type: 'tool_use', id: 't1', name: 'read_file', input: { file_path: 'src/app.ts' } },
              { type: 'tool_use', id: 't2', name: 'exec_shell', input: { command: 'npm test && git status' } },
              { type: 'tool_use', id: 't3', name: 'edit_file', input: { path: 'src/app.ts' } },
            ] as any,
          },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 't4', name: 'load_skill', input: { name: 'typescript' } },
              { type: 'tool_use', id: 't5', name: 'agent', input: { type: 'reviewer' } },
              { type: 'server_tool_use', id: 't6', name: 'web_search', input: { query: 'CodeWhale' } },
            ] as any,
          },
        ],
      }),
    ]

    const { calls } = decodeCodeWhale({ records, context })
    expect(calls).toHaveLength(1)

    const call = calls[0]!
    expect(call.provider).toBe('codewhale')
    expect(call.model).toBe('anthropic/claude-sonnet-4-6')
    expect(call.inputTokens).toBe(12345)
    expect(call.outputTokens).toBe(0)
    expect(call.measuredCostUSD).toBe(0.95)
    expect(call.webSearchRequests).toBe(1)
    expect(call.tools).toEqual(['Read', 'Bash', 'Edit', 'Skill', 'Agent', 'WebSearch'])
    expect(call.rawBashCommands).toEqual(['npm test && git status'])
    expect(call.skills).toEqual(['typescript'])
    expect(call.subagentTypes).toEqual(['reviewer'])
    expect(call.userMessage).toBe('Implement the parser')
    expect(call.sessionId).toBe('session-a')
    expect(call.project).toBe('codewhale-demo')
    expect(call.projectPath).toBe('/Users/alice/codewhale-demo')
    expect(call.toolSequence).toEqual([
      [
        { tool: 'Read', file: 'src/app.ts' },
        { tool: 'Bash', command: 'npm test && git status' },
        { tool: 'Edit', file: 'src/app.ts' },
      ],
      [{ tool: 'Skill' }, { tool: 'Agent' }, { tool: 'WebSearch' }],
    ])
  })

  it('falls back to estimated when no cost is recorded', () => {
    const records: CodeWhaleSessionRecords[] = [
      session({
        metadata: { id: 'session-b', total_tokens: 1000, cost: undefined },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ]

    const { calls } = decodeCodeWhale({ records, context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.measuredCostUSD).toBeUndefined()
  })

  it('skips zero-token sessions with no exact cost', () => {
    const records: CodeWhaleSessionRecords[] = [
      session({
        metadata: { id: 'session-c', total_tokens: 0, cost: { session_cost_usd: 0, subagent_cost_usd: 0 } },
        messages: [],
      }),
    ]

    expect(decodeCodeWhale({ records, context }).calls).toEqual([])
  })

  it('deduplicates by session id using the live seenKeys set', () => {
    const records: CodeWhaleSessionRecords[] = [session()]
    const seen = new Set<string>()
    expect(decodeCodeWhale({ records, context, seenKeys: seen }).calls).toHaveLength(1)
    expect(decodeCodeWhale({ records, context, seenKeys: seen }).calls).toEqual([])
  })

  it('toObservations produces a schema-valid envelope with fingerprinted file refs', () => {
    const records: CodeWhaleSessionRecords[] = [
      session({
        messages: [
          { role: 'user', content: 'Implement the parser' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 't1', name: 'read_file', input: { file_path: 'src/app.ts' } },
              { type: 'tool_use', id: 't2', name: 'edit_file', input: { path: 'src/app.ts' } },
            ] as any,
          },
        ],
      }),
    ]

    const { calls } = decodeCodeWhale({ records, context })
    const { sessions } = toObservations(
      { sessionId: 'session-a', projectPath: '/Users/alice/codewhale-demo', calls },
      { privacyKey: 'test-privacy-key', provider: 'codewhale' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    const reads = sessions.flatMap(s => s.calls.flatMap(c => c.resourceReads ?? []))
    const edits = sessions.flatMap(s => s.calls.flatMap(c => c.resourceEdits ?? []))
    expect(reads.length).toBeGreaterThan(0)
    expect(edits.length).toBeGreaterThan(0)
    for (const ref of [...reads, ...edits]) expect(ref.resourceId).toMatch(/^[0-9a-f]{32}$/)
  })
})
