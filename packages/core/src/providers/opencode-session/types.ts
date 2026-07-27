// OpenCode-session shared decode types.
//
// This module is the core home of the OpenCode-style session decode family
// (OpenCode SQLite, OpenCode file-based JSON, and Kilo Code SQLite). The
// message/part shape is identical across all three stores; only the I/O
// envelope differs.

/** The message blob shared by SQLite and file-based OpenCode stores. */
export type MessageData = {
  role: string
  modelID?: string
  model?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

/** One part of an assistant/user message. */
export type PartData = {
  type: string
  text?: string
  tool?: string
  state?: { input?: { command?: string; name?: string; subagent_type?: string } }
}

/** Session metadata from the file-based JSON layout. */
export type SessionMeta = {
  id?: string
  directory?: string
  title?: string
  time?: { created?: number }
}

/** Message file payload in the file-based JSON layout. */
export type FileMessageData = MessageData & {
  id?: string
  time?: { created?: number }
}

/**
 * Tagged input envelope. The CLI reads the raw bytes / rows and core does the
 * decode, so the SQLite driver and SQL queries stay CLI-side.
 */
export type OpenCodeSessionEnvelope =
  | {
      kind: 'sqlite'
      /** The ROOT session id from the source path; every call is attributed to it. */
      sessionId: string
      /** Rows from the message query, in query order. `data` is blob-decoded text. */
      messages: Array<{ session_id: string; id: string; time_created: number; data: string }>
      /** Rows from the part query, in query order. `data` is blob-decoded text. */
      parts: Array<{ message_id: string; data: string }>
      /** Pre-fetched session-row rollup for the zero-yield fallback; null when unavailable. */
      sessionTokens: OpenCodeSessionTokens | null
    }
  | {
      kind: 'file'
      sessionId: string
      /** Parsed message files; ordering is decided in core, not here. */
      messages: Array<{ id: string; data: FileMessageData }>
      /** messageId -> raw JSON strings of its part files, in sorted filename order. */
      partsRawByMessageId: ReadonlyMap<string, string[]>
      /** meta.time.created, for the timeCreatedMs fallback chain. */
      metaTimeCreatedMs: number | undefined
    }

/** Pre-fetched session-row token rollup for the SQLite session-level fallback. */
export type OpenCodeSessionTokens = {
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  model: string | undefined
}

/** A decoded, cost-free call from an OpenCode-style session. */
export interface OpenCodeSessionDecodedCall {
  /** Which arm produced this call. The host switches on it only if it ever needs to. */
  arm: 'message' | 'session-level'
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  /** Provider-reported dollars used ONLY as an estimated-path fallback. Never 'measured'. */
  fallbackCostUSD?: number
  tools: string[]
  /** RAW command strings; the host reduces these. */
  rawBashCommands: string[]
  skills: string[]
  subagentTypes: string[]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  userMessage: string
  sessionId: string
}
