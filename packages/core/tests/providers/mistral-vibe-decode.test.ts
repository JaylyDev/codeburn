import { describe, expect, it } from 'vitest'

import {
  decodeMistralVibe,
  toObservations,
  type MistralVibeSessionRecord,
  type VibeMessage,
} from '../../src/providers/mistral-vibe/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'mistral-vibe', sourceRef: 'ref' }

function metadata(opts: {
  sessionId?: string
  input?: number
  output?: number
  sessionCost?: number
  inputPrice?: number
  outputPrice?: number
  activeModel?: string
  modelName?: string
  configInputPrice?: number
  configOutputPrice?: number
  endTime?: string | null
  title?: string
} = {}): MistralVibeSessionRecord {
  const activeModel = opts.activeModel ?? 'mistral-medium-3.5'
  return {
    metadata: {
      session_id: opts.sessionId ?? 'session-abc123',
      start_time: '2026-05-11T10:00:00+00:00',
      end_time: Object.hasOwn(opts, 'endTime') ? opts.endTime : '2026-05-11T10:05:00+00:00',
      stats: {
        session_prompt_tokens: opts.input ?? 2000,
        session_completion_tokens: opts.output ?? 3000,
        session_cost: opts.sessionCost,
        input_price_per_million: opts.inputPrice ?? 1.5,
        output_price_per_million: opts.outputPrice ?? 7.5,
      },
      config: {
        active_model: activeModel,
        models: [
          {
            alias: activeModel,
            name: opts.modelName ?? 'mistral-vibe-cli-latest',
            input_price: opts.configInputPrice ?? 1.5,
            output_price: opts.configOutputPrice ?? 7.5,
          },
        ],
      },
      title: opts.title ?? 'implement mistral support',
    },
    sessionCost: opts.sessionCost ?? 0,
  }
}

function userMessage(content: unknown = 'implement mistral support', messageId = 'msg-user-1'): VibeMessage {
  return {
    role: 'user',
    content,
    message_id: messageId,
  }
}

function assistantMessage(
  content = 'Done',
  messageId = 'msg-assistant-1',
  toolCalls: Array<{ name: string; args?: Record<string, unknown> | string }> = [],
): VibeMessage {
  return {
    role: 'assistant',
    content,
    message_id: messageId,
    tool_calls: toolCalls.map((call, idx) => ({
      id: `tool-${idx}`,
      type: 'function',
      function: {
        name: call.name,
        arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
      },
    })),
  }
}

describe('mistral-vibe rich decode (moved to @codeburn/core)', () => {
  it('allocates integer token totals with remainder distributed to early messages', () => {
    const records: unknown[] = [
      metadata({ sessionId: 'session-remainder', input: 100, output: 100, sessionCost: 0.1 }),
      userMessage('first turn', 'msg-user-1'),
      assistantMessage('a1', 'msg-assistant-1'),
      userMessage('second turn', 'msg-user-2'),
      assistantMessage('a2', 'msg-assistant-2'),
      userMessage('third turn', 'msg-user-3'),
      assistantMessage('a3', 'msg-assistant-3'),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    expect(calls).toHaveLength(3)
    // 100 / 3 = 33 remainder 1 -> first message gets 34, rest get 33.
    expect(calls[0]!.inputTokens).toBe(34)
    expect(calls[0]!.outputTokens).toBe(34)
    expect(calls[1]!.inputTokens).toBe(33)
    expect(calls[1]!.outputTokens).toBe(33)
    expect(calls[2]!.inputTokens).toBe(33)
    expect(calls[2]!.outputTokens).toBe(33)

    // 0.10 / 3 = 0.03333333333333333 for every message.
    expect(calls[0]!.measuredCostUSD).toBe(0.03333333333333333)
    expect(calls[1]!.measuredCostUSD).toBe(0.03333333333333333)
    expect(calls[2]!.measuredCostUSD).toBe(0.03333333333333333)
    expect(calls[0]!.measuredCostUSD + calls[1]!.measuredCostUSD + calls[2]!.measuredCostUSD).toBeCloseTo(0.1, 10)
  })

  it('handles the session_cost = 0 arm by using the host-resolved session cost', () => {
    // Host resolves the cost from Vibe's per-million prices: (1000/1e6)*1.5 + (1000/1e6)*7.5 = 0.009.
    const records: unknown[] = [
      metadata({ sessionId: 'session-zero', input: 1000, output: 1000, sessionCost: 0.009 }),
      userMessage('zero cost turn'),
      assistantMessage('z1'),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(1000)
    expect(calls[0]!.outputTokens).toBe(1000)
    expect(calls[0]!.measuredCostUSD).toBe(0.009)
  })

  it('passes a single-assistant session through unchanged (count <= 1 path)', () => {
    const records: unknown[] = [
      metadata({ sessionId: 'session-single', input: 2000, output: 3000, sessionCost: 0.0255 }),
      userMessage('single turn'),
      assistantMessage('s1'),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(2000)
    expect(calls[0]!.outputTokens).toBe(3000)
    expect(calls[0]!.measuredCostUSD).toBe(0.0255)
    expect(calls[0]!.deduplicationKey).toBe('mistral-vibe:session-single:msg-assistant-1')
    expect(calls[0]!.turnId).toBe('session-single:turn-0')
    expect(calls[0]!.userMessage).toBe('single turn')
  })

  it('threads user messages across turns and stamps turnId on each assistant call', () => {
    const records: unknown[] = [
      metadata({ sessionId: 'session-turns', input: 300, output: 300, sessionCost: 0 }),
      userMessage('turn one', 'msg-user-1'),
      assistantMessage('a1', 'msg-assistant-1'),
      userMessage('turn two', 'msg-user-2'),
      assistantMessage('a2', 'msg-assistant-2'),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    expect(calls).toHaveLength(2)
    expect(calls[0]!.userMessage).toBe('turn one')
    expect(calls[0]!.turnId).toBe('session-turns:turn-0')
    expect(calls[1]!.userMessage).toBe('turn two')
    expect(calls[1]!.turnId).toBe('session-turns:turn-1')
  })

  it('deduplicates by session id when no assistant messages are present', () => {
    const records: unknown[] = [
      metadata({ sessionId: 'session-no-assistant', input: 100, output: 100, sessionCost: 0.001 }),
      userMessage('lonely user'),
    ]

    const seen = new Set<string>()
    const first = decodeMistralVibe({ records, context, seenKeys: seen }).calls
    expect(first).toHaveLength(1)
    expect(first[0]!.deduplicationKey).toBe('mistral-vibe:session-no-assistant')

    const again = decodeMistralVibe({ records, context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('threads a live seenKeys set so repeated assistant messages drop', () => {
    const records: unknown[] = [
      metadata({ sessionId: 'session-dedup', input: 100, output: 100, sessionCost: 0.001 }),
      userMessage('dedup turn'),
      assistantMessage('a1', 'msg-assistant-1'),
    ]

    const seen = new Set<string>()
    const first = decodeMistralVibe({ records, context, seenKeys: seen }).calls
    expect(first).toHaveLength(1)

    const again = decodeMistralVibe({ records, context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('skips sessions without cumulative token usage', () => {
    const records: unknown[] = [
      metadata({ input: 0, output: 0 }),
      userMessage(),
      assistantMessage(),
    ]

    const { calls } = decodeMistralVibe({ records, context })
    expect(calls).toEqual([])
  })

  it('maps tool names and extracts raw bash commands', () => {
    const records: unknown[] = [
      metadata({ input: 100, output: 100, sessionCost: 0.001 }),
      userMessage(),
      assistantMessage('Done', 'msg-assistant-1', [
        { name: 'read_file', args: { path: 'src/index.ts' } },
        { name: 'search_replace', args: { file_path: 'src/index.ts', content: 'patch' } },
        { name: 'bash', args: { command: 'npm test && git status' } },
      ]),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['Read', 'Edit', 'Bash'])
    expect(calls[0]!.rawBashCommands).toEqual(['npm test && git status'])
  })

  it('preserves unknown tool names in the rich decode; observations filter them', () => {
    const records: unknown[] = [
      metadata({ input: 100, output: 100, sessionCost: 0.001 }),
      userMessage(),
      assistantMessage('Done', 'msg-assistant-1', [
        { name: 'bash', args: { command: 'echo ok' } },
        { name: 'not a valid tool name!', args: {} },
      ]),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    // Rich decode mirrors the original provider behavior: unknown names pass through.
    expect(calls[0]!.tools).toEqual(['Bash', 'not a valid tool name!'])

    const { sessions } = toObservations(
      { sessionId: 'session-tools', projectPath: '/Users/test/mistral-project', calls },
      { privacyKey: 'test-privacy-key', provider: 'mistral-vibe' },
    )
    expect(sessions[0]!.calls[0]!.toolNames).toEqual(['Bash'])
  })

  // Every expectation below was captured by running the pre-migration in-CLI
  // decode over the equivalent fixtures.
  it('distributes an integer remainder to the FIRST messages (7 over 3, 2 over 3)', () => {
    const records: unknown[] = [
      metadata({ sessionId: 'alloc-7-over-3', input: 7, output: 2, sessionCost: 1 }),
      userMessage('u', 'msg-user-1'),
      assistantMessage('a1', 'a1'),
      assistantMessage('a2', 'a2'),
      assistantMessage('a3', 'a3'),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    expect(calls.map(c => [c.inputTokens, c.outputTokens])).toEqual([[3, 1], [2, 1], [2, 0]])
    expect(calls.map(c => c.measuredCostUSD)).toEqual([
      0.3333333333333333, 0.3333333333333333, 0.3333333333333333,
    ])
  })

  it('handles a total smaller than the message count (1 over 3, 0 over 3)', () => {
    const records: unknown[] = [
      metadata({ sessionId: 'alloc-1-over-3', input: 1, output: 0, sessionCost: 0.1 }),
      userMessage('u', 'msg-user-1'),
      assistantMessage('a1', 'a1'),
      assistantMessage('a2', 'a2'),
      assistantMessage('a3', 'a3'),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    expect(calls.map(c => [c.inputTokens, c.outputTokens])).toEqual([[1, 0], [0, 0], [0, 0]])
    expect(calls.map(c => c.measuredCostUSD)).toEqual([
      0.03333333333333333, 0.03333333333333333, 0.03333333333333333,
    ])
  })

  it('divides the session cost rather than multiplying by the reciprocal', () => {
    // 0.005 / 3 and 0.005 * (1 / 3) differ in the last bit; the original divided.
    const records: unknown[] = [
      metadata({ sessionId: 'alloc-float-order', input: 30, output: 30, sessionCost: 0.005 }),
      userMessage('f', 'msg-user-1'),
      assistantMessage('a1', 'a1'),
      assistantMessage('a2', 'a2'),
      assistantMessage('a3', 'a3'),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    expect(calls.map(c => c.measuredCostUSD)).toEqual([
      0.0016666666666666668, 0.0016666666666666668, 0.0016666666666666668,
    ])
  })

  it('carries measuredCostUSD 0 on the terminal arm where nothing resolved a cost', () => {
    const records: unknown[] = [
      metadata({ sessionId: 'alloc-zero-cost', input: 1000, output: 1000, sessionCost: 0 }),
      userMessage('zero', 'msg-user-1'),
      assistantMessage('a1', 'a1'),
      assistantMessage('a2', 'a2'),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    for (const call of calls) {
      expect(Object.hasOwn(call, 'measuredCostUSD')).toBe(true)
      expect(call.measuredCostUSD).toBe(0)
    }
  })

  it('uses the host sessionIdFallback only when meta.json omits session_id', () => {
    const withFallback = metadata({ input: 10, output: 10, sessionCost: 0.02 })
    delete withFallback.metadata.session_id
    withFallback.sessionIdFallback = 'b4_no_session_id'

    const { calls } = decodeMistralVibe({
      records: [withFallback, userMessage('no id', 'msg-user-1'), assistantMessage('a1', 'a1')],
      context,
    })
    expect(calls[0]!.sessionId).toBe('b4_no_session_id')
    expect(calls[0]!.deduplicationKey).toBe('mistral-vibe:b4_no_session_id:a1')
    expect(calls[0]!.turnId).toBe('b4_no_session_id:turn-0')

    const both: MistralVibeSessionRecord = { ...metadata({ sessionId: 'from-meta', input: 10, output: 10, sessionCost: 0.02 }), sessionIdFallback: 'from-path' }
    const second = decodeMistralVibe({ records: [both, assistantMessage('a1', 'a1')], context })
    expect(second.calls[0]!.sessionId).toBe('from-meta')
  })

  it('keys assistant messages without a message_id by ordinal (idx-N)', () => {
    const anonymous = (): VibeMessage => ({ role: 'assistant', content: 'ok', tool_calls: [] })
    const records: unknown[] = [
      metadata({ sessionId: 'alloc-idx-keys', input: 5, output: 5, sessionCost: 0.3 }),
      userMessage('x', 'msg-user-1'),
      anonymous(),
      anonymous(),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    expect(calls.map(c => c.deduplicationKey)).toEqual([
      'mistral-vibe:alloc-idx-keys:idx-0',
      'mistral-vibe:alloc-idx-keys:idx-1',
    ])
    expect(calls.map(c => [c.inputTokens, c.outputTokens])).toEqual([[3, 3], [2, 2]])
  })

  it('omits turnId entirely on the no-assistant session-level arm', () => {
    const records: unknown[] = [
      metadata({ sessionId: 'alloc-no-assistant', input: 55, output: 55, sessionCost: 0.004 }),
      userMessage('only user text', 'msg-user-1'),
    ]

    const { calls } = decodeMistralVibe({ records, context })

    expect(Object.hasOwn(calls[0]!, 'turnId')).toBe(false)
    expect(calls[0]!.inputTokens).toBe(55)
    expect(calls[0]!.measuredCostUSD).toBe(0.004)
  })

  it('toObservations produces a schema-valid, secret-free envelope', () => {
    const records: unknown[] = [
      metadata({ sessionId: 'session-obs', input: 100, output: 100, sessionCost: 0.001 }),
      userMessage('plain user prompt'),
      assistantMessage('Done', 'msg-assistant-1', [
        { name: 'bash', args: { command: 'npm test' } },
      ]),
    ]

    const { calls } = decodeMistralVibe({ records, context })
    const { sessions } = toObservations(
      { sessionId: 'session-obs', projectPath: '/Users/test/mistral-project', calls },
      { privacyKey: 'test-privacy-key', provider: 'mistral-vibe' },
    )

    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
      sessions,
    }

    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    expect(sessions[0]!.calls[0]!.costBasis).toBe('measured')
    expect(sessions[0]!.calls[0]!.measuredCostUSD).toBe(0.001)
    expect(sessions[0]!.calls[0]!.toolNames).toEqual(['Bash'])
  })
})
