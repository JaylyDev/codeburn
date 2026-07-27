import { describe, expect, it } from 'vitest'

import { decodeZerostack, toObservations } from '../../src/providers/zerostack/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'zerostack', sourceRef: 'ref' }

describe('zerostack rich decode (moved to @codeburn/core)', () => {
  it('decodes one session per JSON file into a cost-free rich call', () => {
    const records = [
      {
        id: 'sess-1',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
        ],
        total_input_tokens: 100,
        total_output_tokens: 50,
        model: 'deepseek/deepseek-v4-pro',
        created_at: '2026-06-01T10:00:00Z',
        updated_at: '2026-06-01T10:01:00Z',
      },
    ]

    const { calls } = decodeZerostack({ records, context })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.model).toBe('deepseek/deepseek-v4-pro')
    expect(call.inputTokens).toBe(100)
    expect(call.outputTokens).toBe(50)
    expect(call.userMessage).toBe('hello')
    expect(call.deduplicationKey).toContain('zerostack:')
  })

  it('skips sessions with zero tokens', () => {
    const records = [
      {
        id: 'empty',
        total_input_tokens: 0,
        total_output_tokens: 0,
        model: 'unknown',
      },
    ]

    const { calls } = decodeZerostack({ records, context })
    expect(calls).toHaveLength(0)
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const records = [
      {
        id: 'sess-a',
        messages: [{ role: 'user', content: 'test' }],
        total_input_tokens: 10,
        total_output_tokens: 5,
        model: 'test-model',
        created_at: '2026-06-01T10:00:00Z',
        working_dir: '/Users/t/project',
      },
    ]
    const { calls } = decodeZerostack({ records, context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/t/project', calls },
      { privacyKey: 'test-key', provider: 'zerostack' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
  })
})
