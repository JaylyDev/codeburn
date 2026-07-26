/**
 * Gemini session record types (moved from CLI, verbatim) + rich decoded call.
 */

export type GeminiTokens = {
  input?: number
  output?: number
  cached?: number
  thoughts?: number
  tool?: number
  total?: number
}

export type GeminiToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
  status?: string
  displayName?: string
}

export type GeminiMessage = {
  id: string
  timestamp: string
  type: 'user' | 'gemini' | 'info'
  content: string | Array<{ text: string }>
  tokens?: GeminiTokens
  model?: string
  toolCalls?: GeminiToolCall[]
  thoughts?: unknown[]
}

export type GeminiSession = {
  sessionId: string
  projectHash?: string
  startTime: string
  lastUpdated?: string
  messages: GeminiMessage[]
  kind?: string
}

/**
 * Rich decoded call: token buckets + tool list + raw bash commands, no pricing,
 * no bash base-name extraction (that's host-side).
 */
export type GeminiDecodedCall = {
  provider: 'gemini'
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
}
