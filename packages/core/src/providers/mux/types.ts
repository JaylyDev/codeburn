// Raw record + rich-decode types for the Mux provider.

export type MuxPart = {
  type?: string
  text?: string
  toolName?: string
  input?: unknown
}

export type MuxMessage = {
  id?: string
  role?: string
  parts?: MuxPart[]
  createdAt?: string
  metadata?: {
    model?: string
    timestamp?: number
    historySequence?: number
    usage?: unknown
    providerMetadata?: Record<string, unknown>
  }
}

// The rich decode of one Mux assistant message.
export type MuxDecodedCall = {
  provider: 'mux'
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
}
