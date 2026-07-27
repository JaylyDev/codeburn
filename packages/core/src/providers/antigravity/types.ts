// Raw record + rich-decode types for the Antigravity provider.
//
// Antigravity is a Category D stateful multi-store provider. The host keeps all
// I/O, discovery, durable caching, and project attribution; core owns only the
// pure decode of the three record shapes the host hands it: sqlite gen_metadata
// rows, RPC generatorMetadata entries, and statusline JSONL events.

export type AntigravityUsageEntry = {
  model: string
  inputTokens: string
  outputTokens: string
  thinkingOutputTokens?: string
  responseOutputTokens?: string
  apiProvider: string
  responseId?: string
}

export type AntigravityGeneratorMetadata = {
  stepIndices?: number[]
  chatModel?: {
    model: string
    usage: AntigravityUsageEntry
    chatStartMetadata?: {
      createdAt?: string
    }
  }
}

export type AntigravityModelMapResponse = {
  models?: Record<string, { model?: string; displayName?: string }>
  response?: {
    models?: Record<string, { model?: string; displayName?: string }>
  }
}

export type AntigravityGeneratorMetadataResponse = {
  generatorMetadata?: AntigravityGeneratorMetadata[]
  response?: {
    generatorMetadata?: AntigravityGeneratorMetadata[]
  }
}

export type AntigravityModelMap = Record<string, string>

export type AntigravityStatusLineCurrentUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type AntigravityStatusLinePayload = {
  conversation_id?: string
  session_id?: string
  model?: string | {
    id?: string
    display_name?: string
  }
  context_window?: {
    current_usage?: AntigravityStatusLineCurrentUsage | null
  }
}

export type AntigravityStatusLineEvent = {
  at: string
  conversationId: string
  sessionId?: string
  model: string
  usage: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
  }
}

export type AntigravityGenMetadataRow = {
  idx: number
  data: Uint8Array | string
}

export type ProtoField = {
  number: number
  wireType: number
  value?: bigint
  bytes?: Uint8Array
}

export type ProtoVarint = {
  value: bigint
  offset: number
}

// The rich decode of one Antigravity call, pre-pricing. Mirrors the host's
// ParsedProviderCall minus everything the host owns: cost (costUSD/costBasis/
// pricingModel), project attribution, and the always-empty tools/bashCommands
// plus the host-supplied empty text field. Antigravity records carry no tool
// calls and no user text at all.
export type AntigravityDecodedCall = {
  provider: 'antigravity'
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  sessionId: string
}
