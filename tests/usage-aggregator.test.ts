import { describe, expect, it, beforeAll } from 'vitest'
import { buildMenubarPayloadForRange, mergeDayModelsByDisplayName, providerSliceHasUsage } from '../src/usage-aggregator.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'
import type { ModelDayStats } from '../src/daily-cache.js'

function modelStats(overrides: Partial<ModelDayStats>): ModelDayStats {
  return { calls: 0, cost: 0, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...overrides }
}

describe('buildMenubarPayloadForRange', () => {
  beforeAll(async () => {
    await loadPricing()
  })

  it('treats token-only provider slices as usage', () => {
    expect(providerSliceHasUsage({
      calls: 0,
      cost: 0,
      savingsUSD: 0,
      inputTokens: 1,
    })).toBe(true)
    expect(providerSliceHasUsage({ calls: 0, cost: 0, savingsUSD: 0 })).toBe(false)
  })

  it('returns a valid payload and skips optimize findings when optimize:false', async () => {
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), { provider: 'all', optimize: false })
    expect(typeof payload.current.label).toBe('string')
    expect(payload.current.cost).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(payload.current.topProjects)).toBe(true)
    expect(Array.isArray(payload.current.topModels)).toBe(true)
    expect(Array.isArray(payload.history.daily)).toBe(true)
    expect(payload.history.timeline?.bucketMinutes).toBe(15)
    expect(Array.isArray(payload.history.timeline?.points)).toBe(true)
    expect(payload.current.retryTax.totalUSD).toBeGreaterThanOrEqual(0)
    // Codex credits are always present in the payload (display gates them); 0 with no data.
    expect(typeof payload.current.codexCredits).toBe('number')
    expect(payload.current.codexCredits).toBeGreaterThanOrEqual(0)
    // optimize:false => scanAndDetect skipped => empty optimize block regardless of data
    expect(payload.optimize).toEqual({ findingCount: 0, savingsUSD: 0, topFindings: [] })
    expect(payload.stale).toBeUndefined()
  })
})

describe('mergeDayModelsByDisplayName', () => {
  it('collapses two raw MiniMax routes into one display-name row and keeps both raw ids (#1239)', () => {
    const merged = mergeDayModelsByDisplayName({
      'minimax/MiniMax-M3': modelStats({ calls: 355, cost: 6.99, inputTokens: 500, outputTokens: 100 }),
      'MiniMaxAI/MiniMax-M3': modelStats({ calls: 60, cost: 0.37, inputTokens: 200, outputTokens: 50 }),
    })

    expect(merged).toHaveLength(1)
    expect(merged[0]!.name).toBe('MiniMax M3')
    expect(merged[0]!.rawModels).toEqual(['minimax/MiniMax-M3', 'MiniMaxAI/MiniMax-M3'])
    expect(merged[0]!.calls).toBe(415)
    expect(merged[0]!.cost).toBeCloseTo(7.36, 6)
    expect(merged[0]!.inputTokens).toBe(700)
    expect(merged[0]!.outputTokens).toBe(150)
  })

  it('keeps distinct models on separate rows with a single-entry rawModels', () => {
    const merged = mergeDayModelsByDisplayName({
      'claude-sonnet-4-6': modelStats({ calls: 1, cost: 1 }),
      'gpt-5': modelStats({ calls: 2, cost: 2 }),
    })
    expect(merged.map(m => m.name).sort()).toEqual(['GPT-5', 'Sonnet 4.6'])
    for (const row of merged) expect(row.rawModels).toHaveLength(1)
  })
})
