import { describe, expect, it } from 'vitest'

import { decodeZcode, toObservations } from '../../src/providers/zcode/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { ZcodeSessionRecords } from '../../src/providers/zcode/index.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'zcode', sourceRef: 'ref' }

function records(): ZcodeSessionRecords {
  return {
    sessionId: 'sess-1',
    usageRows: [
      { id: 'mu-1', turn_id: 'turn-1', model_id: 'GLM-5.2', input_tokens: 9125, output_tokens: 27, reasoning_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 8064, started_at: 1781981181862, completed_at: 1781981202412 },
      { id: 'mu-2', turn_id: 'turn-1', model_id: 'GLM-5.2', input_tokens: 200, output_tokens: 40, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, started_at: 1781981210000, completed_at: 1781981220000 },
      // Zero-token row: skipped.
      { id: 'mu-zero', turn_id: 'turn-2', model_id: 'GLM-5.2', input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, started_at: 1781981230000, completed_at: 1781981231000 },
      // No turn_id: no tools attached.
      { id: 'mu-3', turn_id: null, model_id: 'GLM-5.2', input_tokens: 500, output_tokens: 60, reasoning_tokens: 0, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, started_at: 1781981240000, completed_at: null },
    ],
    toolRows: [
      { turn_id: 'turn-1', tool_name: 'Bash' },
      { turn_id: 'turn-1', tool_name: 'Read' },
    ],
  }
}

describe('zcode rich decode (moved to @codeburn/core)', () => {
  it('decodes usage rows, splitting cached tokens and skipping zero-token rows', () => {
    const { calls } = decodeZcode({ records: [records()], context })
    expect(calls).toHaveLength(3)

    const [first, second, third] = calls
    expect(first).not.toHaveProperty('costUSD')
    expect(first).not.toHaveProperty('costBasis')
    expect(first!.inputTokens).toBe(1061) // 9125 - 8064 cached
    expect(first!.cacheReadInputTokens).toBe(8064)
    expect(first!.reasoningTokens).toBe(12)
    expect(first!.tools).toEqual(['Bash', 'Read'])
    expect(first!.turnId).toBe('turn-1')
    expect(first!.deduplicationKey).toBe('zcode:mu-1')

    // Same turn's second row gets no tools (already attached to the first).
    expect(second!.tools).toEqual([])
    expect(second!.turnId).toBe('turn-1')

    // No turn_id -> no tools, turnId undefined.
    expect(third!.tools).toEqual([])
    expect(third!.turnId).toBeUndefined()
    expect(third!.cacheCreationInputTokens).toBe(100)
  })

  it('threads a live seenKeys set so a repeated row id across passes drops', () => {
    const seen = new Set<string>()
    const first = decodeZcode({ records: [records()], context, seenKeys: seen }).calls
    expect(first).toHaveLength(3)
    const again = decodeZcode({ records: [records()], context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const { calls } = decodeZcode({ records: [records()], context })
    const { sessions } = toObservations(
      { sessionId: 'sess-1', projectPath: '/Users/me/proj', calls },
      { privacyKey: 'test-privacy-key', provider: 'zcode' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    expect(sessions[0]?.calls.every(c => c.costBasis === 'estimated')).toBe(true)
  })
})
