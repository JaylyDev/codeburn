import { describe, expect, it } from 'vitest'

import { planBudgetHeadline, planStatusText } from '../src/dashboard.js'
import type { PlanUsage } from '../src/plan-usage.js'

function usage(overrides: Partial<PlanUsage> = {}): PlanUsage {
  return {
    plan: {
      id: 'supergrok-heavy',
      monthlyUsd: 300,
      provider: 'grok',
      resetDay: 1,
      setAt: '2026-08-01T00:00:00.000Z',
    },
    periodStart: new Date('2026-08-01T00:00:00'),
    periodEnd: new Date('2026-09-01T00:00:00'),
    spentApiEquivalentUsd: 33.82,
    budgetUsd: 300,
    percentUsed: 11.273,
    status: 'under',
    projectedMonthUsd: 40,
    daysUntilReset: 13,
    ...overrides,
  }
}

describe('plan budget copy', () => {
  it('labels SuperGrok as a calendar-month budget, not a live window', () => {
    const text = planBudgetHeadline(usage())
    expect(text).toContain('/mo budget')
    expect(text).not.toMatch(/\bplan\b/)
    const status = planStatusText(usage())
    expect(status).toContain('not a live provider window')
    expect(status).toContain('Calendar-month budget')
    expect(status).not.toMatch(/Well within plan/)
  })

  it('uses the same budget language for every preset, not only Grok', () => {
    const cursor = usage({
      plan: {
        id: 'cursor-pro',
        monthlyUsd: 20,
        provider: 'cursor',
        resetDay: 1,
        setAt: '2026-08-01T00:00:00.000Z',
      },
      budgetUsd: 20,
      spentApiEquivalentUsd: 8.2,
      status: 'near',
    })
    expect(planBudgetHeadline(cursor)).toContain('/mo budget')
    expect(planStatusText(cursor)).toContain('Approaching budget')
  })
})
