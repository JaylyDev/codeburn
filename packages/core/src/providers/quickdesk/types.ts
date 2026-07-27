// Raw record + rich-decode types for the Quickdesk provider.
//
// The CLI reads Quickdesk's metrics JSONL and sqlite sessions.db host-side and
// hands plain row/composite objects to the core decoder. The Decoded* types are
// the rich decode layer's output: pure over supplied records, carrying content
// in-memory but NO pricing (the host prices them).

export type QuickdeskMetricsRecord = {
  record: Record<string, unknown>
}

export type QuickdeskSessionMetadata = {
  id: string
  title: string
  agentMode: string
  createdAt?: number
  deleted: boolean
  firstUserMessage: string
  inputChars: number
  outputChars: number
  tools: string[]
}

export type QuickdeskMetricsInput = {
  variant: 'metrics'
  records: QuickdeskMetricsRecord[]
  sessions: Map<string, QuickdeskSessionMetadata>
  project: string
  projectPath: string
  fileId: string
}

export type QuickdeskDatabaseInput = {
  variant: 'database'
  sessions: QuickdeskSessionMetadata[]
  meteredSessionIds: Set<string>
  project: string
  projectPath: string
}

/**
 * Rich decode of one Quickdesk call (from metrics or database estimate),
 * pre-pricing. Mirrors the host's ParsedProviderCall minus cost fields (the host
 * adds those). `rawBashCommands` is always empty for this provider; the field is
 * kept so the host-side map is uniform. `recordedCost` carries the provider-
 * reported dollar figure when present; the host converts it into `costUSD` +
 * `costBasis: 'measured'`.
 */
export type QuickdeskDecodedCall = {
  provider: 'quickdesk'
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
  project: string
  projectPath: string
  /** Provider-reported cost, when present. The host converts this into `costUSD` + `costBasis: 'measured'`. */
  recordedCost?: number
}
