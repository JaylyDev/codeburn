// Raw record + rich-decode types for the Mistral Vibe provider.
//
// Mistral Vibe stores one session per directory: `meta.json` (session metadata +
// cumulative stats) plus `messages.jsonl` (one JSON object per message). The host
// reads both files and hands the decoder a single record array whose first entry
// is `{ metadata, sessionCost }` and whose remaining entries are the parsed
// messages. This decoder is pure over those records: no fs, env, clock, or
// pricing-table lookups.

export type VibeStats = {
  session_prompt_tokens?: number
  session_completion_tokens?: number
  session_cost?: number
  input_price_per_million?: number
  output_price_per_million?: number
  tokens_per_second?: number
}

export type VibeModelConfig = {
  name?: string
  alias?: string
  input_price?: number
  output_price?: number
}

export type VibeMetadata = {
  session_id?: string
  start_time?: string
  end_time?: string | null
  environment?: {
    working_directory?: string | null
  }
  stats?: VibeStats
  config?: {
    active_model?: string
    models?: VibeModelConfig[]
  }
  title?: string | null
}

export type VibeToolCall = {
  function?: {
    name?: string
    arguments?: string | Record<string, unknown> | null
  }
}

export type VibeMessage = {
  role?: string
  content?: unknown
  message_id?: string
  timestamp?: string
  tool_calls?: VibeToolCall[] | null
}

/**
 * The first record the host hands to the core decoder: the parsed `meta.json`
 * plus the session-level cost the host resolved from the metadata (provider-
 * reported `session_cost`, Vibe's per-million prices, or the generic price table
 * fallback). The decoder allocates this cost evenly across assistant messages.
 *
 * `sessionIdFallback` is the host's path-derived id used when `meta.json` omits
 * `session_id` (the pre-migration decode used the session directory's basename);
 * deriving it needs the source path, which core never sees.
 */
export type MistralVibeSessionRecord = {
  metadata: VibeMetadata
  sessionCost: number
  sessionIdFallback?: string
}

/** The rich decode of one Mistral Vibe call (one assistant message), pre-pricing. */
export type MistralVibeDecodedCall = {
  provider: 'mistral-vibe'
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  /** Allocated from the host-resolved session cost; always present for Vibe. */
  measuredCostUSD: number
  tools: string[]
  rawBashCommands: string[]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  turnId?: string
  userMessage: string
  sessionId: string
}
