// Raw record + rich-decode types for the Kimi provider.
//
// Kimi writes one JSONL wire log per session. The host reads the log lines and
// the configured model fallback from config.toml; the decoder is pure over that
// composite record and carries no pricing.

export type JsonObject = Record<string, unknown>

export type KimiSessionRecords = {
  /** Raw JSONL lines from the wire log. */
  lines: string[]
  /** Model string to fall back to when no model is named on a usage record. */
  configuredModel: string
  /** Basename of the session directory, used as the session id. */
  sessionName: string
}

/** The rich decode of one Kimi call, pre-pricing. */
export type KimiDecodedCall = {
  provider: 'kimi'
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
  /** Kimi does not record a project path; observations fingerprint an empty path. */
  projectPath: string
}
