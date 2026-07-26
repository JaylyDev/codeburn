// Raw record + rich-decode types for the Claude provider.
//
// The record types (JournalEntry, ContentBlock, ...) describe the shape of a
// Claude Code JSONL transcript. The Decoded* types are the rich decode layer's
// output: pure over the supplied records, carrying content in-memory but no
// pricing (the host prices them) — the CLI maps these into its own
// ParsedApiCall / ParsedTurn structures.

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | ToolUseBlock
  | { type: string; [key: string]: unknown }

export type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  cache_read_input_tokens?: number
  server_tool_use?: {
    web_search_requests?: number
    web_fetch_requests?: number
  }
  speed?: 'standard' | 'fast'
  // Claude Code advisor tool (/advisor): per-turn sub-usage records. A record
  // with type 'advisor_message' carries the advisor model's own tokens and is
  // NOT included in the top-level totals above; type 'message' records mirror
  // the main model and are already covered by the top-level totals.
  iterations?: ApiUsageIteration[]
}

export type ApiUsageIteration = {
  type?: string
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  cache_read_input_tokens?: number
  server_tool_use?: {
    web_search_requests?: number
    web_fetch_requests?: number
  }
  speed?: 'standard' | 'fast'
}

export type AssistantMessageContent = {
  model: string
  id?: string
  type: 'message'
  role: 'assistant'
  content: ContentBlock[]
  usage: ApiUsage
  stop_reason?: string
}

export type JournalEntry = {
  type: string
  uuid?: string
  parentUuid?: string | null
  timestamp?: string
  sessionId?: string
  cwd?: string
  version?: string
  gitBranch?: string
  promptId?: string
  message?: AssistantMessageContent | { role: 'user'; content: string | ContentBlock[] }
  isSidechain?: boolean
  [key: string]: unknown
}

export type ToolCall = {
  tool: string
  file?: string
  command?: string
}

// ── Rich decode output ─────────────────────────────────────────────────

export type ToolResultMeta = {
  locAdded: number
  locRemoved: number
  interrupted: boolean
  userModified: boolean
  isError: boolean
}

// Session-level accumulator: last `ai-title` wins, `pr-link` URLs accumulate,
// and any sidechain entry flips `isSidechain`. parentUuid is deliberately not
// captured as a session link — it references an intra-file entry uuid, not
// another session's id, so it cannot reliably connect two sessions.
export type SessionMeta = {
  title?: string
  prLinks: string[]
  isSidechain: boolean
  // Sidechain side: the parent session id (a sidechain entry's internal
  // `sessionId`, which is the spawning session). First non-empty value wins.
  parentSessionId?: string
  // Parent side: agentId -> the `tool_use` id of the `Agent`/`Task` block that
  // spawned it, read from the spawn result's `toolUseResult.agentId`. First value
  // per agentId wins. Empty for sessions that spawned no completed subagent.
  agentSpawnLinks: Record<string, string>
  // Parent side: agent ids whose spawn result named them but whose exact launching
  // tool_use could not be paired (an ambiguous multi-result record). Drives the
  // grace-window fallback for a late child. Deduped.
  ambiguousSpawnAgentIds: string[]
}

// The rich decode of one Claude assistant message (or one advisor iteration),
// pre-pricing. Mirrors the host's ParsedApiCall minus every priced field: no
// costUSD, no local-savings, and bash commands kept as their RAW input strings
// (`rawBashCommands`) so the host can normalize them with its own ANSI-aware
// splitter. The CLI adapter maps this into ParsedApiCall by pricing and
// splitting.
export type DecodedCall = {
  provider: 'claude'
  model: string
  usage: TokenUsage
  tools: string[]
  mcpTools: string[]
  skills: string[]
  subagentTypes: string[]
  hasAgentSpawn: boolean
  hasPlanMode: boolean
  speed: 'standard' | 'fast'
  timestamp: string
  // Raw `command` strings from this call's bash-family tool_use blocks, in order.
  // The host splits each into individual commands; kept raw here to stay free of
  // the CLI's strip-ansi dependency.
  rawBashCommands: string[]
  deduplicationKey: string
  cacheCreationOneHourTokens?: number
  toolSequence?: ToolCall[][]
  spawnToolUseIds?: string[]
  locAdded?: number
  locRemoved?: number
  interrupted?: boolean
  userModified?: boolean
  toolErrors?: number
}

// The rich decode of one turn: a user message and the assistant calls it
// prompted, with per-turn git branch / PR refs / subagent spawn ids.
export type DecodedTurn = {
  userMessage: string
  assistantCalls: DecodedCall[]
  timestamp: string
  sessionId: string
  gitBranch?: string
  prRefs?: string[]
  spawnToolUseIds?: string[]
}
