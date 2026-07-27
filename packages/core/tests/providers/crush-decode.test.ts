import { describe, expect, it } from 'vitest'

import { decodeCrush, toObservations } from '../../src/providers/crush/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { CrushRawRecord } from '../../src/providers/crush/index.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'crush', sourceRef: 'ref' }

function record(overrides: Partial<CrushRawRecord> = {}): CrushRawRecord {
  return {
    id: 'sess-a',
    prompt_tokens: 1234,
    completion_tokens: 567,
    cost: 0.0789,
    created_at: 1_700_000_010,
    updated_at: 1_700_000_999,
    message_count: 3,
    model: 'claude-sonnet-4-6',
    ...overrides,
  }
}

describe('crush rich decode (moved to @codeburn/core)', () => {
  it('decodes a session row with a real cost into a measured, cost-free rich call', () => {
    const { calls } = decodeCrush({ records: [record()], context })
    expect(calls).toHaveLength(1)
    const call = calls[0]!

    // No pricing crosses into the decode layer as a costBasis marker; the
    // dollar figure is carried as `measuredCostUSD` only, for the host to map.
    expect(call).not.toHaveProperty('costBasis')
    expect(call.measuredCostUSD).toBeCloseTo(0.0789, 6)
    expect(call.model).toBe('claude-sonnet-4-6')
    expect(call.inputTokens).toBe(1234)
    expect(call.outputTokens).toBe(567)
    expect(call.deduplicationKey).toBe('crush:sess-a')
    expect(call.sessionId).toBe('sess-a')
    // Crush stores epoch seconds; 1_700_000_999 sec -> 2023-11-14T22:29:59.000Z.
    expect(call.timestamp).toBe(new Date(1_700_000_999 * 1000).toISOString())
  })

  it('omits measuredCostUSD when cost is zero (estimated fallback)', () => {
    const { calls } = decodeCrush({ records: [record({ cost: 0, prompt_tokens: 5, completion_tokens: 5 })], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toHaveProperty('measuredCostUSD')
  })

  it('skips a session with zero tokens and zero cost', () => {
    const { calls } = decodeCrush({ records: [record({ prompt_tokens: 0, completion_tokens: 0, cost: 0 })], context })
    expect(calls).toEqual([])
  })

  it('threads a live seenKeys set so a repeated session id across passes drops', () => {
    const seen = new Set<string>()
    const first = decodeCrush({ records: [record()], context, seenKeys: seen }).calls
    expect(first).toHaveLength(1)
    const again = decodeCrush({ records: [record()], context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const { calls } = decodeCrush({ records: [record()], context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/t/alpha', calls },
      { privacyKey: 'test-privacy-key', provider: 'crush' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    expect(sessions[0]?.calls[0]?.costBasis).toBe('measured')
    expect(sessions[0]?.calls[0]?.measuredCostUSD).toBeCloseTo(0.0789, 6)
  })
})
