// Raw record + rich-decode types for the CodeWhale provider.
//
// CodeWhale stores one whole JSON file per session. The host reads the file (and
// falls back to a fast prefix read for oversized transcripts); the decoder is
// pure over the parsed metadata + messages and carries no computed pricing.

export type CodeWhaleMetadata = {
  id: string
  created_at?: string
  updated_at?: string
  total_tokens?: number
  model?: string
  model_provider?: string
  workspace?: string
  cost?: {
    session_cost_usd?: number
    subagent_cost_usd?: number
  }
}

export type CodeWhaleContentBlock = {
  type?: string
  text?: string
  name?: string
  input?: unknown
}

export type CodeWhaleMessage = {
  role?: string
  content?: string | CodeWhaleContentBlock[]
}

/** One tool invocation as captured from a CodeWhale transcript. */
export type CodeWhaleToolCall = {
  tool: string
  file?: string
  command?: string
}

/** The composite record the host hands to the core decoder for one session. */
export type CodeWhaleSessionRecords = {
  metadata: CodeWhaleMetadata
  messages: CodeWhaleMessage[]
  /** File mtime as an ISO fallback when metadata timestamps are missing/invalid. */
  fileMtime: string
}

/** The rich decode of one CodeWhale session, pre-pricing. */
export type CodeWhaleDecodedCall = {
  provider: 'codewhale'
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  /** Provider-reported dollar cost, present only when the file carried one. */
  measuredCostUSD?: number
  tools: string[]
  rawBashCommands: string[]
  skills: string[]
  subagentTypes: string[]
  toolSequence?: CodeWhaleToolCall[][]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  turnId: string
  userMessage: string
  sessionId: string
  project: string
  projectPath: string
}
