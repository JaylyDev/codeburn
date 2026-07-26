// Raw record + rich-decode types for the Zerostack provider.

export type ZerostackMessage = {
  role?: string
  content?: string | Array<{ text?: string }>
}

export type ZerostackSession = {
  id?: string
  messages?: ZerostackMessage[]
  created_at?: string
  updated_at?: string
  total_input_tokens?: number
  total_output_tokens?: number
  model?: string
  provider?: string
  working_dir?: string
}

// The rich decode of one Zerostack session (one cumulative call).
// Mirrors the host's ParsedProviderCall minus cost fields.
export type ZerostackDecodedCall = {
  provider: 'zerostack'
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
  // Host-derived, carried through so the bridge can reproduce the pre-migration
  // ParsedProviderCall byte-for-byte. `project` is the discovered source project;
  // `projectPath` is the session's recorded working_dir. Both omitted when absent.
  project?: string
  projectPath?: string
}
