// Raw sqlite-row + rich-decode types for the Warp provider.
//
// The record types describe the shape of the rows the host reads from Warp's
// warp.sqlite. The CLI textualizes the `stylized_command` BLOB before handing
// rows to the core decoder (blobToText is I/O-adjacent and stays host-side).
// The Decoded* types are the rich decode layer's output: pure over supplied
// records, carrying content in-memory but NO host-side pricing. The CLI adapter
// maps WarpDecodedCall into its own ParsedProviderCall by adding costBasis,
// extracting bash base commands, and running the pricing pass.

export type WarpConversationRow = {
  conversation_id: string
  conversation_data: string
  last_modified_at: string | null
}

export type WarpQueryRow = {
  exchange_id: string
  conversation_id: string
  start_ts: string
  input: string
  working_directory: string | null
  output_status: string
  model_id: string
  planning_model_id: string
  coding_model_id: string
}

/** Block row after the host has textualized `stylized_command`. */
export type WarpBlockRow = {
  block_id: string
  start_ts: string | null
  stylized_command: string | null
}

export type WarpTokenUsageEntry = {
  model_id?: string
  warp_tokens?: number
  byok_tokens?: number
  warp_token_usage_by_category?: Record<string, unknown>
  byok_token_usage_by_category?: Record<string, unknown>
}

export type WarpConversationData = {
  conversation_usage_metadata?: {
    token_usage?: WarpTokenUsageEntry[]
  }
}

export type WarpParsedExchange = WarpQueryRow & {
  startMs: number
}

export type WarpExchangeToolInfo = {
  tools: string[]
  rawBashCommands: string[]
}

/**
 * Rich decode of one Warp exchange, pre-pricing. Mirrors the host's
 * ParsedProviderCall minus cost fields. `rawBashCommands` are the un-split shell
 * command strings from command blocks; the CLI adapter runs its own base-name
 * extraction on them.
 */
export type WarpDecodedCall = {
  provider: 'warp'
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
  project: string
  projectPath?: string
}
