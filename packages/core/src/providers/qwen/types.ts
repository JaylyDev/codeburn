// Raw record + rich-decode types for the Qwen provider.
//
// The record types (QwenPart, QwenEntry) describe the shape of a Qwen Code CLI
// chat JSONL line. The Decoded* types are the rich decode layer's output: pure
// over supplied records, carrying content in-memory but NO pricing (the host
// prices them). The CLI adapter maps QwenDecodedCall into its own
// ParsedProviderCall by adding `costBasis: 'estimated'`, extracting bash base
// commands, and running the pricing pass.

export type QwenPart = {
  text?: string
  thought?: boolean
  functionCall?: { name?: string; args?: Record<string, unknown> }
  functionResponse?: unknown
}

export type QwenEntry = {
  uuid?: string
  sessionId?: string
  timestamp?: string
  type?: string
  subtype?: string
  cwd?: string
  model?: string
  message?: {
    role?: string
    parts?: QwenPart[]
  }
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
  }
}

// A single tool invocation captured in a turn's tool sequence. Mirrors the
// CLI's ToolCall so the host can consume it without a shape conversion; `file`
// is host-side only (fingerprinted before it can reach an observation).
export type QwenToolCall = {
  tool: string
  file?: string
  command?: string
}

// The rich decode of one Qwen call (one assistant message with usage), pre-
// pricing. Mirrors the host's ParsedProviderCall minus cost fields (the host
// adds those). `rawBashCommands` are the un-split shell command strings from
// Bash-mapped tool calls; the CLI adapter runs its own base-name extraction on
// them to build the `bashCommands` field (that extraction, and its `strip-ansi`
// dependency, stay CLI-side). `toolSequence` carries raw file paths host-side
// so the observation transform can fingerprint them; it never leaves the host
// as-is.
export type QwenDecodedCall = {
  provider: 'qwen'
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
  speed: 'standard' | 'fast'
  deduplicationKey: string
  userMessage: string
  sessionId: string
  toolSequence?: QwenToolCall[][]
}
