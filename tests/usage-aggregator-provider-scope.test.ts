import { beforeAll, describe, expect, it, vi } from 'vitest'

import { buildMenubarPayloadForRange, overlayProviderDaySlices } from '../src/usage-aggregator.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'
import type { DailyEntry, ProviderDaySlice } from '../src/daily-cache.js'

const parseAllSessions = vi.hoisted(() => vi.fn(async () => []))

vi.mock('../src/parser.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/parser.js')>()
  return {
    ...mod,
    parseAllSessions,
    isSessionHydrationComplete: vi.fn(() => true),
    sessionHydrationSnapshot: vi.fn(() => ({
      complete: true,
      deferredForFirstPaint: false,
      indexedFiles: 0,
      pendingFiles: 0,
    })),
  }
})

vi.mock('../src/daily-cache.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/daily-cache.js')>()
  return {
    ...mod,
    ensureCacheHydrated: vi.fn(async (parseSessions: (range: { start: Date; end: Date }) => Promise<unknown>) => {
      await parseSessions({ start: new Date(0), end: new Date() })
      return mod.emptyCache()
    }),
    loadDailyCache: vi.fn(async () => mod.emptyCache()),
  }
})

describe('provider-scoped menubar aggregation', () => {
  beforeAll(async () => {
    await loadPricing()
  })

  it('never scans unrelated providers to render one selected provider', async () => {
    parseAllSessions.mockClear()

    await buildMenubarPayloadForRange(getDateRange('today'), {
      provider: 'hermes',
      optimize: false,
      timeline: false,
    })

    expect(parseAllSessions.mock.calls.map(([, provider]) => provider))
      .toEqual(['hermes'])
  })

  it('overlays a corrected live provider slice without losing expired-source history', () => {
    const slice = (cost: number, calls: number): ProviderDaySlice => ({ cost, calls, savingsUSD: 0, sessions: calls })
    const day = (date: string, providers: Record<string, ProviderDaySlice>): DailyEntry => ({
      date,
      cost: Object.values(providers).reduce((sum, provider) => sum + provider.cost, 0),
      calls: Object.values(providers).reduce((sum, provider) => sum + provider.calls, 0),
      sessions: Object.values(providers).reduce((sum, provider) => sum + (provider.sessions ?? 0), 0),
      savingsUSD: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      editTurns: 0,
      oneShotTurns: 0,
      models: {},
      categories: {},
      providers,
    })

    const result = overlayProviderDaySlices(
      [
        day('2026-08-31', { hermes: slice(1.25, 2) }),
        day('2026-09-01', { hermes: slice(4603, 6764), claude: slice(2, 3) }),
      ],
      [day('2026-09-01', { hermes: slice(0.438, 6) })],
      'hermes',
    )

    expect(result.map(entry => ({ date: entry.date, cost: entry.cost, calls: entry.calls }))).toEqual([
      { date: '2026-08-31', cost: 1.25, calls: 2 },
      { date: '2026-09-01', cost: 0.438, calls: 6 },
    ])
    expect(result[1]!.providers).toEqual({ hermes: slice(0.438, 6) })
  })
})
