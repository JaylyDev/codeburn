import { calculateCost } from './models.js'
import type { ParsedProviderCall } from './providers/types.js'

// Host-side pricing pass (Phase 0 of the @codeburn/core extraction).
//
// Converted decoders emit token counts plus a `costBasis` marker instead of
// pricing calls themselves; this pass turns that into the final `costUSD`,
// byte-identical to the in-decoder computation it replaces:
//
//   'estimated' : cost is computed from the call's token buckets via the
//                 pricing table — the SAME formula cachedCallToApiCall already
//                 applies when repricing a cached non-metered call, so a cache
//                 round-trip is a no-op and the value matches today's decoder.
//   'measured'  : the decoder already carries a provider-reported dollar figure
//                 in `costUSD`; the pass passes it through untouched.
//
// A call with no `costBasis` comes from a not-yet-converted decoder that still
// priced itself; the pass leaves it exactly as-is, so converted and unconverted
// providers coexist during the fan-out.
export function priceProviderCall(call: ParsedProviderCall): ParsedProviderCall {
  if (call.costBasis !== 'estimated') return call

  // Mirror cachedCallToApiCall's non-claude branch: reasoning tokens are billed
  // at the output rate. Provider calls never carry 1-hour cache tokens (the
  // cache write path hardcodes them to 0), so the default 0 is correct here.
  const outputForCost = call.outputTokens + call.reasoningTokens
  // Seam extension: price `pricingModel` when the decoder supplied one (its
  // display `model` differs from the model the price table is keyed by, e.g.
  // antigravity's suffix-stripped / aliased id). Falls back to `model` for
  // every provider whose display model is already its pricing model.
  let costUSD = calculateCost(
    call.pricingModel ?? call.model,
    call.inputTokens,
    outputForCost,
    call.cacheCreationInputTokens,
    call.cacheReadInputTokens,
    call.webSearchRequests,
    call.speed,
  )
  // Seam extension: some decoders prefer the table price but fall back to a
  // provider-reported dollar/credit figure when the model is unpriced (cost is
  // 0). This preserves codebuff's credit fallback and OpenCode/Cline's
  // session-cost fallback exactly — the inverse of `measured`, which always wins.
  if (costUSD === 0 && call.fallbackCostUSD !== undefined && call.fallbackCostUSD > 0) {
    costUSD = call.fallbackCostUSD
  }
  return { ...call, costUSD }
}
