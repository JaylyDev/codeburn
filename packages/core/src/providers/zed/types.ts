// Raw record + rich-decode types for the Zed provider.
//
// Zed's built-in agent stores one row per thread in a single SQLite database;
// the `data` blob is zstd-compressed JSON carrying `request_token_usage`
// (per-request Anthropic-shaped token counts) and the thread's model. The
// sqlite driver and SQL query stay CLI-side (Category B); the host hands this
// decoder the raw `threads` rows, blob and all — decompression + JSON parsing
// are pure and happen here. Format documented in issue #480.

/** One `threads` row, moved verbatim from the CLI. */
export type ZedThreadRow = {
  id: string
  summary: string | null
  updated_at: string | null
  data_type: string | null
  data: Uint8Array | null
}

export type ZedTokenUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type ZedThreadJson = {
  model?: { provider?: string; model?: string }
  request_token_usage?: Record<string, ZedTokenUsage>
  cumulative_token_usage?: ZedTokenUsage
}

/** The rich decode of one Zed request (per-request or cumulative-remainder), pre-pricing. */
export type ZedDecodedCall = {
  provider: 'zed'
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
  userMessage: string
  sessionId: string
}
