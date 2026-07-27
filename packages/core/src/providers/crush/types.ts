// Raw record + rich-decode types for the Crush provider.
//
// Crush stores per-project SQLite databases; the sqlite driver and SQL queries
// stay CLI-side (Category B). The host runs both the session-row query and the
// dominant-model query (a GROUP BY over messages) and hands the decoder one
// combined record per session — this decoder performs no further DB access.

/** The `sessions` row Crush records, moved verbatim from the CLI. */
export type CrushSessionRow = {
  id: string
  prompt_tokens: number | null
  completion_tokens: number | null
  cost: number | null
  created_at: number | null
  updated_at: number | null
  message_count: number | null
}

/**
 * The record the host hands to the core decoder: the session row plus the
 * dominant model resolved by the host's second query (unchanged from the
 * pre-migration decode, which ran `dominantModel()` inline).
 */
export type CrushRawRecord = CrushSessionRow & { model: string }

/** The rich decode of one Crush session, pre-pricing. */
export type CrushDecodedCall = {
  provider: 'crush'
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  /** Crush already records cost in dollars; present only when the row's cost > 0. */
  measuredCostUSD?: number
  tools: string[]
  rawBashCommands: string[]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  sessionId: string
}
