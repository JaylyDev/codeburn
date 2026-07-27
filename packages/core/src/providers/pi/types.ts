/**
 * Pi/OMP session record types (moved from CLI, verbatim) + rich decoded call.
 * Pi and OMP share the same session format (JSONL with message entries).
 */

export type PiEntry = {
  type: string
  id?: string
  timestamp?: string
  cwd?: string
  message?: {
    role?: string
    content?: Array<{ type?: string; text?: string; name?: string; arguments?: Record<string, unknown> }> | string
    model?: string
    responseId?: string
    usage?: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }
  }
}

export type PiToolCall = {
  type: 'toolCall'
  name?: string
  arguments?: Record<string, unknown>
}

/**
 * Rich decoded call: token buckets + tool list + raw bash commands + skills,
 * no pricing, no bash base-name extraction (that's host-side).
 */
export type PiDecodedCall = {
  provider: 'pi' | 'omp'
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
  skills?: string[]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  userMessage: string
  sessionId: string
}
