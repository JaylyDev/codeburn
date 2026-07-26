// Raw record + rich-decode types for the Droid provider.

export type DroidSettings = {
  model?: string
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    cacheCreationTokens: number
    cacheReadTokens: number
    thinkingTokens: number
  }
}

export type DroidContent = {
  type: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

export type DroidMessage = {
  role: string
  content?: DroidContent[]
}

export type DroidJsonlEntry = {
  type: string
  id?: string
  timestamp?: string
  message?: DroidMessage
  title?: string
  cwd?: string
}

// The rich decode of one Droid assistant message.
// Mirrors the host's ParsedProviderCall minus cost fields.
export type DroidDecodedCall = {
  provider: 'droid'
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
