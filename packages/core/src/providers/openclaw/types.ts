// Raw record + rich-decode types for the OpenClaw provider.
//
// OpenClaw sessions are JSONL files. The host reads the file and hands the lines
// straight through. The Decoded* types are the rich decode layer's output: pure
// over supplied records, carrying content in-memory but NO computed pricing (the
// host may add its own estimated-cost seam). Bash base-name extraction stays
// host-side.

export type OpenClawUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens?: number
  cost?: {
    total?: number
  }
}

export type OpenClawEntry = {
  type: string
  customType?: string
  id?: string
  timestamp?: string
  provider?: string
  modelId?: string
  data?: {
    provider?: string
    modelId?: string
  }
  message?: {
    role?: string
    content?: Array<{ type?: string; text?: string; name?: string; arguments?: Record<string, unknown> }>
    model?: string
    provider?: string
    usage?: OpenClawUsage
  }
}

// The rich decode of one OpenClaw call (one assistant message with usage),
// pre-pricing. Mirrors the host's ParsedProviderCall minus the host-side
// estimated-cost seam. Provider-reported cost is preserved when present.
export type OpenClawDecodedCall = {
  provider: 'openclaw'
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  costUSD?: number
  costBasis: 'estimated' | 'measured'
  tools: string[]
  rawBashCommands: string[]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  userMessage: string
  sessionId: string
}
