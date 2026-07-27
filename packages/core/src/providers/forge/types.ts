// Raw record + rich-decode types for the Forge provider.
//
// Forge stores one row per conversation in a single SQLite database; the
// `context` column is a JSON blob carrying the full message list (including
// per-message token usage and tool calls). The sqlite driver and SQL query stay
// CLI-side (Category B); the host hands this decoder the raw conversation row
// (with the still-serialized `context` string) — JSON parsing and per-message
// decode are pure and happen here.

/** The `conversations` row Forge records, moved verbatim from the CLI. */
export type ForgeConversationRow = {
  conversation_id: string
  title: string | null
  workspace_id: number | string
  context: string | null
  created_at: string | null
  updated_at: string | null
}

export type ForgeContextMessage = {
  message?: {
    text?: {
      role?: unknown
      content?: unknown
      model?: unknown
      tool_calls?: unknown
    }
  }
  usage?: unknown
}

/** The rich decode of one Forge assistant message, pre-pricing. */
export type ForgeDecodedCall = {
  provider: 'forge'
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
