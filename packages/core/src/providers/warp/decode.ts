// @codeburn/core Warp decoder: pure decode over host-supplied sqlite rows.
// The host opens warp.sqlite, runs the SQL, textualizes the stylized_command
// BLOB, and hands the conversation + exchanges + blocks straight through. This
// decoder is pure: no fs / env / clock / sqlite / pricing / strip-ansi. It emits
// raw command strings; bash base-name extraction stays host-side.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type {
  WarpBlockRow,
  WarpConversationData,
  WarpConversationRow,
  WarpDecodedCall,
  WarpExchangeToolInfo,
  WarpParsedExchange,
  WarpQueryRow,
  WarpTokenUsageEntry,
} from './types.js'

const PRIMARY_AGENT_CATEGORY = 'primary_agent'

const modelAliases: Record<string, string> = {
  'Claude Sonnet 4.6': 'claude-sonnet-4-6',
  'Claude Sonnet 4.5': 'claude-sonnet-4-5',
  'Claude Haiku 4.5': 'claude-haiku-4-5',
  'Claude Opus 4.6': 'claude-opus-4-6',
  'GPT-5.3 Codex (low reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (medium reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (high reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (extra high reasoning)': 'gpt-5.3-codex',
  'auto-efficient': 'warp-auto-efficient',
  'auto-powerful': 'warp-auto-powerful',
}

function normalizeModel(rawModel: string): string {
  const model = rawModel.trim()
  if (!model) return model
  return modelAliases[model] ?? model
}

function parseTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withT = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
  const lastPlus = withT.lastIndexOf('+')
  const lastMinus = withT.lastIndexOf('-')
  const hasOffset = lastPlus > 9 || lastMinus > 9
  const hasTimezone = withT.endsWith('Z') || hasOffset
  const normalized = hasTimezone ? withT : `${withT}Z`
  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? null : ms
}

function parseJsonString(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'string' ? parsed : raw
  } catch {
    return raw
  }
}

function isFinalStatus(rawStatus: string): boolean {
  const status = parseJsonString(rawStatus)
  return status === 'Completed' || status === 'Cancelled' || status === 'Failed'
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function extractCategoryTokens(categories: Record<string, unknown> | undefined, key: string): number {
  if (!categories) return 0
  return safeNumber(categories[key])
}

function estimateTokensFromChars(charCount: number): number {
  // Mirror the host's token-estimate heuristic exactly (CHARS_PER_TOKEN = 4).
  return Math.ceil(charCount / 4)
}

function extractTokenBudget(rawConversationData: string): { tokenBudget: number; dominantModel: string } {
  let conversationData: WarpConversationData
  try {
    conversationData = JSON.parse(rawConversationData) as WarpConversationData
  } catch {
    return { tokenBudget: 0, dominantModel: '' }
  }

  const entries = conversationData.conversation_usage_metadata?.token_usage ?? []
  let primaryTotal = 0
  let fallbackTotal = 0
  let dominantPrimaryTokens = 0
  let dominantFallbackTokens = 0
  let dominantModel = ''

  for (const entry of entries) {
    const primaryTokens =
      extractCategoryTokens(entry.warp_token_usage_by_category, PRIMARY_AGENT_CATEGORY) +
      extractCategoryTokens(entry.byok_token_usage_by_category, PRIMARY_AGENT_CATEGORY)
    const entryTotal = safeNumber(entry.warp_tokens) + safeNumber(entry.byok_tokens)

    primaryTotal += primaryTokens
    fallbackTotal += entryTotal

    if (primaryTokens > dominantPrimaryTokens) {
      dominantPrimaryTokens = primaryTokens
      dominantModel = typeof entry.model_id === 'string' ? entry.model_id : dominantModel
    }

    if (dominantPrimaryTokens === 0 && entryTotal > dominantFallbackTokens) {
      dominantFallbackTokens = entryTotal
      dominantModel = typeof entry.model_id === 'string' ? entry.model_id : dominantModel
    }
  }

  const tokenBudget = primaryTotal > 0 ? primaryTotal : fallbackTotal
  return { tokenBudget: Math.max(0, Math.round(tokenBudget)), dominantModel: normalizeModel(dominantModel) }
}

function extractUserMessage(rawInput: string): string {
  try {
    const parsed = JSON.parse(rawInput) as unknown
    if (!Array.isArray(parsed)) return ''
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const query = (item as { Query?: { text?: unknown } }).Query
      if (!query || typeof query !== 'object') continue
      if (typeof query.text === 'string' && query.text.trim()) return query.text
    }
    return ''
  } catch {
    return ''
  }
}

function estimateWeight(rawInput: string): number {
  const userMessage = extractUserMessage(rawInput)
  const source = userMessage || rawInput
  const tokens = estimateTokensFromChars(source.length)
  return Math.max(1, tokens)
}

function allocateTokens(weights: number[], tokenBudget: number): number[] {
  if (weights.length === 0) return []
  const normalizedWeights = weights.map(w => Math.max(0, Math.round(w)))
  const totalWeight = normalizedWeights.reduce((sum, weight) => sum + weight, 0)
  const budget = Math.max(0, Math.round(tokenBudget))

  if (budget === 0) return normalizedWeights.map(() => 0)
  if (totalWeight === 0) {
    const even = Math.floor(budget / normalizedWeights.length)
    const allocated = normalizedWeights.map(() => even)
    let remainder = budget - even * normalizedWeights.length
    let index = 0
    while (remainder > 0) {
      allocated[index] = (allocated[index] ?? 0) + 1
      remainder--
      index = (index + 1) % normalizedWeights.length
    }
    return allocated
  }

  const rawAllocation = normalizedWeights.map(weight => (budget * weight) / totalWeight)
  const allocated = rawAllocation.map(value => Math.floor(value))
  let remainder = budget - allocated.reduce((sum, value) => sum + value, 0)

  const byLargestFraction = rawAllocation
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction)

  let pointer = 0
  while (remainder > 0 && byLargestFraction.length > 0) {
    const index = byLargestFraction[pointer]!.index
    allocated[index] = (allocated[index] ?? 0) + 1
    remainder--
    pointer = (pointer + 1) % byLargestFraction.length
  }

  return allocated
}

function resolveModelForExchange(exchange: WarpQueryRow, dominantModel: string): string {
  const candidate =
    exchange.model_id.trim() ||
    exchange.coding_model_id.trim() ||
    exchange.planning_model_id.trim() ||
    dominantModel ||
    'warp-auto-efficient'
  const normalized = normalizeModel(candidate)
  if ((normalized === 'warp-auto-efficient' || normalized === 'warp-auto-powerful') && dominantModel) {
    return dominantModel
  }
  return normalized
}

function sanitizeProject(path: string): string {
  return path.replace(/^\/+/, '').replace(/\//g, '-')
}

function assignCommandBlocksToExchanges(
  blocks: WarpBlockRow[],
  exchanges: WarpParsedExchange[],
): Map<string, WarpExchangeToolInfo> {
  const toolsByExchange = new Map<string, WarpExchangeToolInfo>()

  function getOrCreate(exchangeId: string): WarpExchangeToolInfo {
    const existing = toolsByExchange.get(exchangeId)
    if (existing) return existing
    const created: WarpExchangeToolInfo = { tools: [], rawBashCommands: [] }
    toolsByExchange.set(exchangeId, created)
    return created
  }

  for (const block of blocks) {
    const blockStartMs = parseTimestamp(block.start_ts)
    if (blockStartMs === null) continue

    let targetExchange: WarpParsedExchange | null = null
    for (const exchange of exchanges) {
      if (exchange.startMs > blockStartMs) break
      targetExchange = exchange
    }
    if (!targetExchange) continue

    const info = getOrCreate(targetExchange.exchange_id)
    if (!info.tools.includes('Bash')) info.tools.push('Bash')

    const commandText = block.stylized_command ?? ''
    // The host textualizes the BLOB before handing rows to the decoder, so
    // commandText is already a plain string here.
    if (commandText && !info.rawBashCommands.includes(commandText)) {
      info.rawBashCommands.push(commandText)
    }
  }

  return toolsByExchange
}

export type WarpDecodeInput = {
  records: unknown[]
  context: DecodeContext
  // Optional live dedup set the host mutates in place (its shared cross-file
  // seenKeys). Simple sqlite providers never persist resume state, so there is
  // no serialized `seenKeys` fallback.
  seenKeys?: Set<string>
}

export type WarpDecodeResult = {
  calls: WarpDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode one Warp conversation (host-supplied conversation row + exchanges +
 * textualized blocks + source project) into rich, cost-free calls. Dedup is
 * keyed on `warp:<conversationId>:<exchangeId>` against the live `seenKeys` set
 * (host-owned).
 */
export function decodeWarp({ records, seenKeys: liveSeen }: WarpDecodeInput): WarpDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: WarpDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  const composite = records[0] as
    | {
        conversationId: string
        conversation: WarpConversationRow
        exchanges: WarpQueryRow[]
        blocks: WarpBlockRow[]
        sourceProject: string
      }
    | undefined
  if (!composite || typeof composite !== 'object') return { calls, diagnostics }

  const { conversationId, conversation, exchanges, blocks, sourceProject } = composite
  if (!conversationId || !conversation) return { calls, diagnostics }

  const parsedExchanges: WarpParsedExchange[] = []
  for (const exchange of exchanges) {
    if (!isFinalStatus(exchange.output_status)) continue
    const startMs = parseTimestamp(exchange.start_ts)
    if (startMs === null) continue
    parsedExchanges.push({ ...exchange, startMs })
  }
  if (parsedExchanges.length === 0) return { calls, diagnostics }

  const { tokenBudget, dominantModel } = extractTokenBudget(conversation.conversation_data)
  const weights = parsedExchanges.map(exchange => estimateWeight(exchange.input))
  const fallbackBudget = weights.reduce((sum, weight) => sum + weight, 0)
  const allocatedTokens = allocateTokens(weights, tokenBudget > 0 ? tokenBudget : fallbackBudget)
  const toolsByExchange = assignCommandBlocksToExchanges(blocks, parsedExchanges)

  for (let index = 0; index < parsedExchanges.length; index++) {
    const exchange = parsedExchanges[index]!
    const deduplicationKey = `warp:${conversationId}:${exchange.exchange_id}`
    if (seen.has(deduplicationKey)) continue

    const timestamp = new Date(exchange.startMs).toISOString()
    const model = resolveModelForExchange(exchange, dominantModel)
    const inputTokens = allocatedTokens[index] ?? 0
    const exchangeTools = toolsByExchange.get(exchange.exchange_id) ?? { tools: [], rawBashCommands: [] }
    const userMessage = extractUserMessage(exchange.input).slice(0, 500)
    const projectPath = exchange.working_directory?.trim() || undefined
    const project = projectPath ? sanitizeProject(projectPath) : sourceProject

    seen.add(deduplicationKey)
    calls.push({
      provider: 'warp',
      model,
      inputTokens,
      // Warp exposes only conversation-level usage totals in these tables,
      // so we cannot reliably split per-exchange input vs output tokens.
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      tools: exchangeTools.tools,
      rawBashCommands: exchangeTools.rawBashCommands,
      timestamp,
      speed: 'standard',
      deduplicationKey,
      userMessage,
      sessionId: conversationId,
      project,
      ...(projectPath ? { projectPath } : {}),
    })
  }

  return { calls, diagnostics }
}
