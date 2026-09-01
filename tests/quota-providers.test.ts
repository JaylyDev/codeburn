import { describe, expect, it, vi } from 'vitest'

import { fetchAntigravityQuota, decodeAntigravitySummary } from '../src/quota/antigravity.js'
import { decodeClaudeUsage, fetchClaudeQuota } from '../src/quota/claude.js'
import { decodeCodexUsage, fetchCodexQuota } from '../src/quota/codex.js'
import { decodeCopilotUsage, fetchCopilotQuota } from '../src/quota/copilot.js'
import { decodeGeminiUsage, fetchGeminiQuota } from '../src/quota/gemini.js'
import { collectQuota, renderQuotaTable } from '../src/quota/index.js'
import { decodeKimiUsage, fetchKimiQuota } from '../src/quota/kimi.js'
import type { QuotaProvider } from '../src/quota/types.js'

const noFile = vi.fn(async () => null)
const neverFetch = () => { throw new Error('the test must not reach the network') }

describe('Claude quota', () => {
  it('decodes the five-hour and weekly windows with the credential tier', () => {
    const quota = decodeClaudeUsage({
      five_hour: { utilization: 25, resets_at: '2026-07-12T12:00:00Z' },
      seven_day: { utilization: 50, resets_at: '2026-07-19T12:00:00Z' },
    }, { accessToken: 'hidden', rateLimitTier: 'max_20x' })
    expect(quota.connection).toBe('connected')
    expect(quota.planLabel).toBe('Max 20x')
    expect(quota.details.map(row => row.label)).toEqual(['5-hour', 'Weekly'])
    expect(quota.primary).toEqual({ label: 'Weekly', percent: 0.5, resetsAt: '2026-07-19T12:00:00.000Z' })
  })

  it('reports disconnected without a credential and never fetches', async () => {
    const result = await fetchClaudeQuota({ fetch: neverFetch as unknown as typeof fetch, readFile: noFile })
    expect(result.quota.connection).toBe('disconnected')
  })
})

describe('Codex quota', () => {
  it('decodes the primary and secondary rate-limit windows with the plan label', () => {
    const quota = decodeCodexUsage({
      plan_type: 'enterprise_cbp_usage_based',
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_760_000_000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604_800 },
      },
    })
    expect(quota.planLabel).toBe('Enterprise')
    expect(quota.details.map(row => row.label)).toEqual(['5-hour', 'Weekly'])
    expect(quota.primary?.percent).toBe(0.12)
    expect(quota.primary?.resetsAt).toBe('2025-10-09T08:53:20.000Z')
  })

  it('reports disconnected when no auth file exists', async () => {
    const result = await fetchCodexQuota({
      fetch: neverFetch as unknown as typeof fetch,
      readFile: noFile,
      keychain: async () => ({ status: 'notFound' }),
    })
    expect(result.quota.connection).toBe('disconnected')
  })
})

describe('Copilot quota', () => {
  it('turns remaining-percent snapshots into used windows', () => {
    const quota = decodeCopilotUsage({
      copilot_plan: 'individual',
      quota_snapshots: { premium_interactions: { percent_remaining: 70 }, chat: { percent_remaining: 100 } },
    })
    expect(quota.planLabel).toBe('Individual')
    expect(quota.primary).toEqual({ label: 'Premium requests', percent: 0.3, resetsAt: null })
    expect(quota.details.map(row => row.label)).toEqual(['Premium requests', 'Chat'])
  })

  it('reports disconnected when no plugin token is on disk', async () => {
    const result = await fetchCopilotQuota({ fetch: neverFetch as unknown as typeof fetch, readFile: noFile })
    expect(result.quota.connection).toBe('disconnected')
  })
})

describe('Gemini quota', () => {
  it('decodes per-model buckets into used windows ordered by pressure', () => {
    const quota = decodeGeminiUsage({
      buckets: [
        { modelId: 'gemini-2.5-flash', remainingFraction: 0.9 },
        { modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2026-09-02T00:00:00Z' },
      ],
    })
    expect(quota.details.map(row => row.label)).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash'])
    expect(quota.primary?.percent).toBeCloseTo(0.75, 6)
    expect(quota.primary?.resetsAt).toBe('2026-09-02T00:00:00.000Z')
  })

  it('reports disconnected without the CLI oauth credential', async () => {
    const result = await fetchGeminiQuota({ fetch: neverFetch as unknown as typeof fetch, readFile: noFile })
    expect(result.quota.connection).toBe('disconnected')
  })
})

describe('Kimi quota', () => {
  it('decodes the weekly envelope plus the rate-limit windows', () => {
    const quota = decodeKimiUsage({
      usage: { limit: 100, used: 30 },
      limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 50, remaining: 10 } }],
      user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
      parallel: { limit: 3 },
    })
    expect(quota?.planLabel).toBe('Intermediate')
    expect(quota?.details.map(row => row.label)).toEqual(['Weekly', '5-hour'])
    expect(quota?.details.map(row => row.percent)).toEqual([0.3, 0.8])
    expect(quota?.footerLines).toEqual(['Parallel sessions: 3'])
  })

  it('reports disconnected without the Kimi CLI credential', async () => {
    const result = await fetchKimiQuota({ fetch: neverFetch as unknown as typeof fetch, readFile: noFile })
    expect(result.quota.connection).toBe('disconnected')
  })
})

describe('Antigravity quota', () => {
  it('decodes grouped model buckets into used windows', () => {
    const windows = decodeAntigravitySummary({
      groups: [{ displayName: 'Weekly', buckets: [{ displayName: 'Claude Sonnet 4.5', remaining: { remainingFraction: 0.4 } }] }],
    })
    expect(windows).toEqual([{ label: 'Weekly · Claude Sonnet 4.5', percent: 0.6, resetsAt: null }])
  })

  it('reports disconnected when no local language server is running', async () => {
    const quota = await fetchAntigravityQuota({
      execFile: async () => ({ stdout: '  501 /usr/bin/unrelated --flag\n' }),
      request: async () => { throw new Error('the test must not probe a port') },
    })
    expect(quota.connection).toBe('disconnected')
  })
})

describe('quota command envelope', () => {
  const connected: QuotaProvider = {
    provider: 'claude', connection: 'connected', planLabel: 'Max 20x', footerLines: [],
    primary: { label: 'Weekly', percent: 0.5, resetsAt: '2026-07-19T12:00:00.000Z' },
    details: [
      { label: '5-hour', percent: 0.255, resetsAt: null },
      { label: 'Weekly', percent: 0.5, resetsAt: '2026-07-19T12:00:00.000Z' },
    ],
  }
  const missing: QuotaProvider = {
    provider: 'kimi', connection: 'disconnected', primary: null, details: [], planLabel: null, footerLines: [],
  }

  it('renders providers, windows and the omitted-error contract', async () => {
    const report = await collectQuota({
      readers: [
        { id: 'claude', name: 'Claude', read: async () => connected },
        { id: 'kimi', name: 'Kimi', read: async () => missing },
      ],
    })
    expect(report).toEqual({
      providers: [
        {
          id: 'claude', name: 'Claude', available: true, plan: 'Max 20x',
          windows: [
            { label: '5-hour', usedPct: 25.5 },
            { label: 'Weekly', usedPct: 50, resetsAt: '2026-07-19T12:00:00.000Z' },
          ],
        },
        { id: 'kimi', name: 'Kimi', available: false, windows: [] },
      ],
    })
    expect(renderQuotaTable(report, { color: false })).toContain('Claude (Max 20x)')
  })

  it('gives up on a provider that outlives its timeout', async () => {
    const report = await collectQuota({
      timeoutMs: 5,
      readers: [{ id: 'gemini', name: 'Gemini', read: () => new Promise<QuotaProvider>(() => {}) }],
    })
    expect(report.providers).toEqual([{ id: 'gemini', name: 'Gemini', available: false, windows: [], error: 'Timed out.' }])
  })
})
