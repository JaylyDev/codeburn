/**
 * Kimicode session record types (moved from CLI, verbatim) + rich decoded call.
 */

export type JsonObject = Record<string, unknown>

export type SessionState = {
  createdAt?: string
  updatedAt?: string
  workDir?: string
}

export type RequestContext = {
  model: string
  modelAlias: string
  turnId: string
  timestamp: string
}

/**
 * Rich decoded call: token buckets + tool list + raw bash commands, no pricing,
 * no bash base-name extraction (that's host-side).
 */
export type KimicodeDecodedCall = {
  provider: 'kimicode'
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
  userMessage: string
  sessionId: string
  project?: string
  projectPath?: string
}
