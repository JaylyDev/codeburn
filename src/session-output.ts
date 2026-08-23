import { billableOutputTokens } from './models.js'
import type { SessionSummary } from './types.js'

/** First on-call provider, then a model-name fallback. Sessions are usually one provider. */
export function inferSessionProvider(session: SessionSummary): string {
  for (const turn of session.turns) {
    const provider = turn.assistantCalls[0]?.provider
    if (provider) return provider
  }

  const models = Object.keys(session.modelBreakdown)
  const model = models[0]?.toLowerCase() ?? ''
  if (model.startsWith('claude')) return 'claude'
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'codex'
  if (model.startsWith('gemini')) return 'gemini'
  if (model.includes('/')) return model.split('/', 1)[0] || 'unknown'
  return 'unknown'
}

/** Display/report output: exclusive providers add reasoning; inclusive ones do not. */
export function sessionBillableOutputTokens(session: SessionSummary): number {
  let fromCalls = 0
  let sawCall = false
  for (const turn of session.turns) {
    for (const call of turn.assistantCalls) {
      sawCall = true
      fromCalls += billableOutputTokens(
        call.provider,
        call.usage.outputTokens,
        call.usage.reasoningTokens,
      )
    }
  }
  if (sawCall) return fromCalls
  return billableOutputTokens(
    inferSessionProvider(session),
    session.totalOutputTokens,
    session.totalReasoningTokens,
  )
}
