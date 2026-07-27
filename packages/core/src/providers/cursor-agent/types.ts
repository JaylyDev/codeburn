// Raw record + rich-decode types for the Cursor Agent provider.
//
// The record types describe the shape of the host-supplied row objects: the
// conversation summary row read from the sqlite ai-code-tracking.db plus the
// transcript text and file metadata. The Decoded* types are the rich decode
// layer's output: pure over supplied records, carrying content in-memory but NO
// pricing (the host prices them). The CLI adapter maps CursorAgentDecodedCall
// into its own ParsedProviderCall by adding `costBasis: 'estimated'` and
// extracting bash base commands.

/** One row from the Cursor Agent `conversation_summaries` sqlite table. */
export type ConversationSummaryRow = {
  conversationId: string
  model: string | null
  title: string | null
  updatedAt: string | null
}

/** One assistant turn after transcript parsing. */
export type AssistantTurn = {
  body: string
  reasoning: string
  tools: string[]
}

/** One user/assistant pair after transcript parsing. */
export type ParsedTurn = {
  userMessage: string
  assistant: AssistantTurn
}

/** The composite record the host hands to the core decoder for one source. */
export type CursorAgentRecord = {
  /** Summary from ai-code-tracking.db, or null when the DB is missing/empty. */
  summary: ConversationSummaryRow | null
  /** Raw transcript text (.txt or .jsonl). */
  transcript: string
  /** Path to the transcript file (only its `.jsonl` suffix selects the parser). */
  transcriptPath: string
  /** ISO timestamp of the transcript file's mtime (host-side I/O metadata). */
  fileMtime: string
  /** Stable session id the host derived from the transcript path. */
  conversationId: string
}

/** Rich decode of one Cursor Agent call, pre-pricing. */
export type CursorAgentDecodedCall = {
  provider: 'cursor-agent'
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
