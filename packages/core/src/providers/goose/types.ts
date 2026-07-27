// Raw record + rich-decode types for the Goose provider.
//
// Goose stores one row per session plus a `messages` table with a per-message
// `content_json` BLOB column. The sqlite driver and SQL queries stay CLI-side
// (Category B); the host runs the session query, the assistant tool-message
// query, and the first-user-message query, converts each BLOB column to text
// (`blobToText`, the same charset-safe conversion `fs-utils` performs for file
// reads), and hands this decoder one composite record bundling all three —
// JSON parsing and per-message decode are pure and happen here.

/** The `sessions` row Goose records, pre-resolved to text columns by the host. */
export type GooseSessionRow = {
  id: string
  workingDir: string | null
  createdAt: string | null
  updatedAt: string | null
  accumulatedInputTokens: number | null
  accumulatedOutputTokens: number | null
  /** `model_config_json`, already converted from BLOB to text host-side. */
  modelConfigJson: string | null
}

export type GooseModelConfig = {
  model_name?: string
  reasoning?: boolean
}

/** One `messages` row, `content_json` already converted from BLOB to text host-side. */
export type GooseMessageRow = {
  contentJson: string
}

export type GooseContentItem = {
  type: string
  text?: string
  toolCall?: { value?: { name?: string; arguments?: Record<string, unknown> } }
}

/** One tool invocation as captured from a Goose transcript. */
export type GooseToolCall = {
  tool: string
  file?: string
  command?: string
}

/** The composite record the host hands to the core decoder for one session. */
export type GooseSessionRecords = {
  sessionId: string
  session: GooseSessionRow
  /** Assistant messages whose content_json contains a toolRequest, ordered by created_timestamp ASC. */
  assistantToolMessages: GooseMessageRow[]
  /** The first user message (by created_timestamp ASC), if any. */
  firstUserMessage: GooseMessageRow | null
}

/** The rich decode of one Goose session, pre-pricing. */
export type GooseDecodedCall = {
  provider: 'goose'
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
  toolSequence?: GooseToolCall[][]
  /** Resolved from updated_at/created_at; empty when neither parses (the host
   * falls back to the current time, matching the pre-migration decode — that
   * clock read must stay host-side, so this decode never touches it). */
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  userMessage: string
  sessionId: string
}
