import { beforeAll, describe, expect, it, vi } from 'vitest'

import { buildMenubarPayloadForRange } from '../src/usage-aggregator.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'

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
    ensureCacheHydrated: vi.fn(async () => mod.emptyCache()),
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
})
