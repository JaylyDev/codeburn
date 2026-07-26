// Raw record + rich-decode types for the Open Design provider.

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
}

export type OpenDesignEntry = {
  id?: unknown
  event?: unknown
  data?: unknown
  timestamp?: unknown
}

// The rich decode of one Open Design usage event.
export type OpenDesignDecodedCall = {
  provider: 'open-design'
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
  // Discovered source project, carried through so the bridge reproduces the
  // pre-migration ParsedProviderCall byte-for-byte. Omitted when not supplied.
  project?: string
}
