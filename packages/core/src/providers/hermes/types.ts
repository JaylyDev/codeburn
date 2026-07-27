// Raw sqlite-row + rich-decode types for the Hermes provider.
//
// The record types (HermesSessionRow, HermesMessageRow) describe the shape of the
// rows the host reads from Hermes's state.db. The Decoded* types are the rich
// decode layer's output: pure over supplied records, carrying content in-memory
// but NO host-side pricing (the host prices them). The CLI adapter maps
// HermesDecodedCall into its own ParsedProviderCall by adding costBasis / costUSD
// from the provider-recorded cost, extracting bash base commands, and running the
// pricing pass.

export type HermesSessionRow = {
  id: string
  source: string | null
  model: string | null
  cwd: string | null
  billing_provider: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
  estimated_cost_usd: number | null
  actual_cost_usd: number | null
  api_call_count: number | null
  tool_call_count: number | null
  started_at: number | null
  ended_at: number | null
  title: string | null
}

export type HermesMessageRow = {
  id: number | null
  role: string
  content: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number | null
}

export type HermesToolCall = {
  function?: {
    name?: string
    arguments?: string
  }
}

/** One tool invocation captured in a turn's tool sequence. */
export type HermesToolSequenceEntry = {
  tool: string
  file?: string
  command?: string
}

/**
 * Rich decode of one Hermes session (one row from sessions + its messages),
 * pre-pricing. Mirrors the host's ParsedProviderCall minus cost fields (the host
 * adds those). `rawBashCommands` are the un-split shell command strings from
 * Bash-mapped tool calls; the CLI adapter runs its own base-name extraction on
 * them to build the `bashCommands` field (that extraction, and its `strip-ansi`
 * dependency, stay CLI-side). `toolSequence` carries raw file paths host-side so
 * the observation transform can fingerprint them; it never leaves the host as-is.
 */
export type HermesDecodedCall = {
  provider: 'hermes'
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
  turnId?: string
  toolSequence?: HermesToolSequenceEntry[][]
  /** Provider-recorded cost (actual_cost_usd or estimated_cost_usd), when present.
   * The host converts this into `costUSD` + `costBasis: 'measured'`. */
  recordedCost?: number
  /** Absolute project path (the session cwd or a path scraped from the transcript);
   * fingerprinted by toObservations, never emitted raw. */
  projectPath?: string
  /** Sanitized project name derived from cwd, transcript, or profile; host-only. */
  project?: string
}
