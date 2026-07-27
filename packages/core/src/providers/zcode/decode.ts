// @codeburn/core ZCode decoder: pure decode over a host-supplied composite
// session record (model_usage rows + tool_usage rows). No fs/env/sqlite/pricing
// here — the host runs both queries and hands the rows straight through.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { ZcodeDecodedCall, ZcodeSessionRecords, ZcodeToolRow, ZcodeUsageRow } from './types.js'

function epochMsToIso(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return new Date(0).toISOString()
  return new Date(ms).toISOString()
}

function isZcodeSessionRecords(value: unknown): value is ZcodeSessionRecords {
  return value !== null && typeof value === 'object' && 'usageRows' in (value as object) && 'toolRows' in (value as object)
}

export type ZcodeDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type ZcodeDecodeResult = {
  calls: ZcodeDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode one ZCode session's composite record (model_usage rows joined with
 * tool_usage rows by turn) into rich, cost-free calls. model_usage rows don't
 * link to individual tool calls, only to a turn, so each turn's tools attach to
 * the FIRST usage row of that turn only, to avoid double-counting across a
 * turn's multiple requests — matching the pre-migration decode exactly.
 */
export function decodeZcode({ records, seenKeys: liveSeen }: ZcodeDecodeInput): ZcodeDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: ZcodeDecodedCall[] = []

  const session = records.find(isZcodeSessionRecords)
  if (!session) return { calls, diagnostics: [] }

  const { sessionId, usageRows, toolRows }: { sessionId: string; usageRows: ZcodeUsageRow[]; toolRows: ZcodeToolRow[] } = session

  const toolsByTurn = new Map<string, string[]>()
  for (const tool of toolRows) {
    if (!tool.turn_id) continue
    const list = toolsByTurn.get(tool.turn_id) ?? []
    list.push(tool.tool_name)
    toolsByTurn.set(tool.turn_id, list)
  }

  const turnsWithToolsEmitted = new Set<string>()

  for (const row of usageRows) {
    const cacheRead = row.cache_read_input_tokens ?? 0
    const cacheCreation = row.cache_creation_input_tokens ?? 0
    const output = row.output_tokens ?? 0
    const reasoning = row.reasoning_tokens ?? 0
    // ZCode folds cached tokens into input_tokens (OpenAI-style). Split them
    // back out so fresh input bills at the input rate and cached at the
    // cache-read rate, matching the pricing table's Anthropic-style semantics.
    const freshInput = Math.max(0, (row.input_tokens ?? 0) - cacheRead - cacheCreation)

    if (freshInput === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheCreation === 0) {
      continue
    }

    const dedupKey = `zcode:${row.id}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    let tools: string[] = []
    if (row.turn_id && !turnsWithToolsEmitted.has(row.turn_id)) {
      const turnTools = toolsByTurn.get(row.turn_id)
      if (turnTools && turnTools.length > 0) {
        tools = turnTools
        turnsWithToolsEmitted.add(row.turn_id)
      }
    }

    calls.push({
      provider: 'zcode',
      model: row.model_id,
      inputTokens: freshInput,
      outputTokens: output,
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
      cachedInputTokens: 0,
      reasoningTokens: reasoning,
      webSearchRequests: 0,
      tools,
      rawBashCommands: [],
      timestamp: epochMsToIso(row.completed_at ?? row.started_at),
      speed: 'standard',
      deduplicationKey: dedupKey,
      turnId: row.turn_id ?? undefined,
      sessionId,
    })
  }

  return { calls, diagnostics: [] }
}
