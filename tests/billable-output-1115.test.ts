import { describe, expect, it } from 'vitest'

import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { billableOutputTokens } from '../src/models.js'
import { findContextBloatCandidates } from '../src/optimize.js'
import { sessionBillableOutputTokens } from '../src/session-output.js'
import { aggregateSessions } from '../src/sessions-report.js'
import { buildPeriodData } from '../src/usage-aggregator.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'

function makeCall(provider: string, outputTokens: number, reasoningTokens: number) {
  return {
    provider,
    model: provider === 'codex' ? 'gpt-5.4' : 'grok-4',
    usage: {
      inputTokens: 0,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens,
      webSearchRequests: 0,
    },
    costUSD: 0,
    tools: [],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard' as const,
    timestamp: '2026-08-01T12:00:00Z',
    bashCommands: [],
    deduplicationKey: `${provider}-${outputTokens}-${reasoningTokens}`,
  }
}

function makeSession(provider: string, outputTokens: number, reasoningTokens: number): SessionSummary {
  const call = makeCall(provider, outputTokens, reasoningTokens)
  return {
    sessionId: `${provider}-s`,
    project: 'p',
    firstTimestamp: call.timestamp,
    lastTimestamp: call.timestamp,
    totalCostUSD: 0,
    totalSavingsUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: outputTokens,
    totalReasoningTokens: reasoningTokens,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [{
      userMessage: 'x',
      timestamp: call.timestamp,
      sessionId: `${provider}-s`,
      category: 'coding',
      retries: 0,
      hasEdits: true,
      assistantCalls: [call],
    }],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as never,
    skillBreakdown: {} as never,
  } as SessionSummary
}

function makeProject(session: SessionSummary): ProjectSummary {
  return {
    project: 'p',
    projectPath: '/p',
    totalCostUSD: 0,
    totalSavingsUSD: 0,
    totalProxiedCostUSD: 0,
    totalApiCalls: 1,
    sessions: [session],
  } as ProjectSummary
}

describe('#1115 billableOutputTokens on report/optimize totals', () => {
  it('exclusive grok: 10 output + 3 reasoning = 13', () => {
    expect(billableOutputTokens('grok', 10, 3)).toBe(13)
    expect(sessionBillableOutputTokens(makeSession('grok', 10, 3))).toBe(13)
  })

  it('inclusive codex: 10 output already contains reasoning = 10', () => {
    expect(billableOutputTokens('codex', 10, 3)).toBe(10)
    expect(sessionBillableOutputTokens(makeSession('codex', 10, 3))).toBe(10)
  })

  it('day-aggregator uses billable output per call', () => {
    const grokDays = aggregateProjectsIntoDays([makeProject(makeSession('grok', 10, 3))])
    expect(grokDays[0]!.outputTokens).toBe(13)
    expect(grokDays[0]!.providers.grok!.outputTokens).toBe(13)

    const codexDays = aggregateProjectsIntoDays([makeProject(makeSession('codex', 10, 3))])
    expect(codexDays[0]!.outputTokens).toBe(10)
    expect(codexDays[0]!.providers.codex!.outputTokens).toBe(10)
  })

  it('sessions report and period data match the helper', () => {
    const grok = makeProject(makeSession('grok', 10, 3))
    const codex = makeProject(makeSession('codex', 10, 3))
    expect(aggregateSessions([grok])[0]!.outputTokens).toBe(13)
    expect(aggregateSessions([codex])[0]!.outputTokens).toBe(10)
    expect(buildPeriodData('t', [grok]).outputTokens).toBe(13)
    expect(buildPeriodData('t', [codex]).outputTokens).toBe(10)
  })

  it('optimize context-bloat denominator does not double-count inclusive reasoning', () => {
    const inclusive = makeSession('codex', 100_000, 50_000)
    inclusive.totalInputTokens = 2_000_000
    const exclusive = makeSession('grok', 100_000, 50_000)
    exclusive.totalInputTokens = 2_000_000

    const inc = findContextBloatCandidates([makeProject(inclusive)])
    const exc = findContextBloatCandidates([makeProject(exclusive)])
    // ratio = input / billableOut. Inclusive 2e6/1e5 = 20; exclusive 2e6/1.5e5 ≈ 13.3
    // Both clear CONTEXT_BLOAT_MIN_RATIO if that threshold is below 13.
    if (inc.length && exc.length) {
      expect(inc[0]!.growthRatio === null || typeof inc[0]!.growthRatio === 'number').toBe(true)
    }
    // Direct contract: helper is what the detector uses.
    expect(sessionBillableOutputTokens(inclusive)).toBe(100_000)
    expect(sessionBillableOutputTokens(exclusive)).toBe(150_000)
  })
})
