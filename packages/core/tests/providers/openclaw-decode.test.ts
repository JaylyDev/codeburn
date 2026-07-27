import { describe, expect, it } from 'vitest'

import { decodeOpenClaw, toObservations } from '../../src/providers/openclaw/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'openclaw', sourceRef: '/data/agents/myagent/sessions/test-sess-1.jsonl' }

const RECORDS: string[] = [
  JSON.stringify({ type: 'session', version: 3, id: 'test-sess-1', timestamp: '2026-04-20T10:00:00.000Z', cwd: '/tmp' }),
  JSON.stringify({ type: 'model_change', id: 'mc1', timestamp: '2026-04-20T10:00:01.000Z', provider: 'anthropic', modelId: 'claude-sonnet-4-6' }),
  JSON.stringify({
    type: 'message', id: 'u1', timestamp: '2026-04-20T10:00:02.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
  }),
  JSON.stringify({
    type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:03.000Z',
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Hi!' }],
      usage: { input: 500, output: 100, cacheRead: 200, cacheWrite: 50, totalTokens: 850 },
    },
  }),
  JSON.stringify({
    type: 'message', id: 'a2', timestamp: '2026-04-20T10:00:05.000Z',
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'Running command' },
        { type: 'toolCall', name: 'exec', arguments: { command: 'ls -la' } },
        { type: 'tool_use', name: 'write', arguments: { path: '/tmp/y' } },
      ],
      usage: { input: 600, output: 200, cacheRead: 100, cacheWrite: 0, totalTokens: 900, cost: { total: 0.05 } },
    },
  }),
  // Duplicate id -> must drop.
  JSON.stringify({
    type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:06.000Z',
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Duplicate' }],
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
    },
  }),
]

describe('openclaw rich decode (moved to @codeburn/core)', () => {
  it('decodes assistant calls into cost-free rich calls, preserving provider-reported cost', () => {
    const { calls } = decodeOpenClaw({ records: RECORDS, context })
    expect(calls).toHaveLength(2)

    const [first, second] = calls
    expect(first!.model).toBe('claude-sonnet-4-6')
    expect(first!.inputTokens).toBe(500)
    expect(first!.outputTokens).toBe(100)
    expect(first!.cacheReadInputTokens).toBe(200)
    expect(first!.cacheCreationInputTokens).toBe(50)
    expect(first!.costBasis).toBe('estimated')
    expect(first).not.toHaveProperty('costUSD')
    expect(first!.userMessage).toBe('hello world')
    expect(first!.deduplicationKey).toBe('openclaw:test-sess-1:a1')

    expect(second!.model).toBe('claude-sonnet-4-6')
    expect(second!.inputTokens).toBe(600)
    expect(second!.outputTokens).toBe(200)
    expect(second!.costBasis).toBe('measured')
    expect(second!.costUSD).toBe(0.05)
    expect(second!.tools).toEqual(['Bash', 'Write'])
    expect(second!.rawBashCommands).toEqual(['ls -la'])
    expect(second!.userMessage).toBe('')
  })

  it('threads a live seenKeys set so a repeated id across passes drops', () => {
    const seen = new Set<string>()
    const first = decodeOpenClaw({ records: RECORDS.slice(0, 4), context, seenKeys: seen }).calls
    expect(first).toHaveLength(1)
    const again = decodeOpenClaw({ records: RECORDS.slice(0, 4), context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const { calls } = decodeOpenClaw({ records: RECORDS, context })
    const { sessions } = toObservations(
      { sessionId: 'test-sess-1', projectPath: '/tmp', calls },
      { privacyKey: 'test-privacy-key', provider: 'openclaw' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    const toolNames = sessions.flatMap(s => s.calls.flatMap(c => c.toolNames))
    expect(toolNames).toContain('Bash')
    expect(toolNames).toContain('Write')
  })
})
