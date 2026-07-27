// @codeburn/core Crush decoder: pure decode over host-supplied session records.
// The host runs the sqlite queries (session row + dominant model) and hands
// this decoder one combined record per session; no fs/env/sqlite/pricing here.
// Crush already stores cost in dollars, so a row with cost > 0 carries
// `measuredCostUSD` instead of estimated token pricing (Phase 0 pattern B).

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CrushDecodedCall, CrushRawRecord } from './types.js'

function epochSecondsToIso(epochSeconds: number | null): string {
  if (epochSeconds === null || !Number.isFinite(epochSeconds)) {
    return new Date(0).toISOString()
  }
  return new Date(epochSeconds * 1000).toISOString()
}

export type CrushDecodeInput = {
  records: unknown[]
  context: DecodeContext
  // Optional live dedup set the host mutates in place. Threaded exactly like
  // codex/qwen; Crush never persists resume state.
  seenKeys?: Set<string>
}

export type CrushDecodeResult = {
  calls: CrushDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode Crush session records (one per source) into rich, cost-free-or-measured
 * calls. A session with zero tokens and zero cost is skipped; dedup is keyed on
 * `crush:<sessionId>` against the live `seenKeys` set (host-owned).
 */
export function decodeCrush({ records, seenKeys: liveSeen }: CrushDecodeInput): CrushDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: CrushDecodedCall[] = []

  for (const raw of records) {
    const session = raw as CrushRawRecord

    const inputTokens = session.prompt_tokens ?? 0
    const outputTokens = session.completion_tokens ?? 0
    const cost = session.cost ?? 0
    if (inputTokens === 0 && outputTokens === 0 && cost === 0) continue

    const dedupKey = `crush:${session.id}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    calls.push({
      provider: 'crush',
      model: session.model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      ...(cost > 0 ? { measuredCostUSD: cost } : {}),
      tools: [],
      rawBashCommands: [],
      timestamp: epochSecondsToIso(session.updated_at ?? session.created_at),
      speed: 'standard',
      deduplicationKey: dedupKey,
      sessionId: session.id,
    })
  }

  return { calls, diagnostics: [] }
}
