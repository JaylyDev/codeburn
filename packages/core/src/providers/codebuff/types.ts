// Raw record + rich-decode types for the Codebuff provider.
//
// The record types describe the shape of Codebuff's chat-messages.json. The
// Decoded* types are the rich decode layer's output: pure over supplied records,
// carrying content in-memory but NO pricing (the host prices them) and NO bash
// base-name extraction (the host runs that).

export type CodebuffUsage = {
  inputTokens?: number
  input_tokens?: number
  promptTokens?: number
  prompt_tokens?: number
  outputTokens?: number
  output_tokens?: number
  completionTokens?: number
  completion_tokens?: number
  cacheCreationInputTokens?: number
  cache_creation_input_tokens?: number
  cacheReadInputTokens?: number
  cache_read_input_tokens?: number
  promptTokensDetails?: { cachedTokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
}

export type CodebuffBlock = {
  type?: string
  content?: string
  toolName?: string
  input?: Record<string, unknown>
  output?: string
  agentName?: string
  agentType?: string
  status?: string
  blocks?: CodebuffBlock[]
}

export type CodebuffHistoryMessage = {
  role?: string
  providerOptions?: {
    codebuff?: { model?: string; usage?: CodebuffUsage }
    usage?: CodebuffUsage
  }
}

export type CodebuffMetadata = {
  model?: string
  modelId?: string
  timestamp?: string | number
  usage?: CodebuffUsage
  codebuff?: { model?: string; usage?: CodebuffUsage }
  runState?: {
    cwd?: string
    sessionState?: {
      cwd?: string
      projectContext?: { cwd?: string }
      fileContext?: { cwd?: string }
      mainAgentState?: {
        agentType?: string
        messageHistory?: CodebuffHistoryMessage[]
      }
    }
  }
}

export type CodebuffChatMessage = {
  id?: string
  variant?: string
  role?: string
  content?: string
  timestamp?: string | number
  credits?: number
  blocks?: CodebuffBlock[]
  metadata?: CodebuffMetadata
}

// The rich decode of one Codebuff call (one assistant message with usage/credits),
// pre-pricing. Mirrors the host's ParsedProviderCall minus cost fields.
export type CodebuffDecodedCall = {
  provider: 'codebuff'
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
  speed: 'standard'
  deduplicationKey: string
  userMessage: string
  sessionId: string
  /** Credits attached to the assistant message; used host-side to compute
   * fallbackCostUSD when the pricing table cannot price the model. */
  credits: number
}
