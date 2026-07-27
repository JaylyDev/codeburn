// Raw record + rich-decode types for the ZCode provider.
//
// ZCode (CLI v0.14.x) records usage in a single SQLite database. The sqlite
// driver and SQL queries stay CLI-side (Category B); the host runs both the
// model_usage query and the tool_usage query for one session and hands the
// decoder a single composite record bundling both row sets.

/** One `model_usage` row, moved verbatim from the CLI. */
export type ZcodeUsageRow = {
  id: string
  turn_id: string | null
  model_id: string
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  started_at: number
  completed_at: number | null
}

/** One `tool_usage` row, moved verbatim from the CLI. */
export type ZcodeToolRow = {
  turn_id: string | null
  tool_name: string
}

/** The composite record the host hands to the core decoder for one session. */
export type ZcodeSessionRecords = {
  sessionId: string
  usageRows: ZcodeUsageRow[]
  toolRows: ZcodeToolRow[]
}

/** The rich decode of one ZCode model_usage row, pre-pricing. */
export type ZcodeDecodedCall = {
  provider: 'zcode'
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  tools: string[]
  rawBashCommands: string[]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  turnId?: string
  sessionId: string
}
