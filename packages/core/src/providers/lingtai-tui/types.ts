// Raw record + rich-decode types for the LingTai TUI provider.

export type JsonObject = Record<string, unknown>

export type LingTaiAgentManifest = {
  agent_id?: string
  agent_name?: string
  address?: string
  nickname?: string | null
  llm?: {
    model?: string
    base_url?: string
  }
}

export type LingTaiLedgerEntry = {
  source?: string
  em_id?: string
  run_id?: string
  ts?: string | number
  input?: number | string
  output?: number | string
  thinking?: number | string
  cached?: number | string
  model?: string
  endpoint?: string
}

// The rich decode of one LingTai TUI ledger entry.
export type LingTaiTuiDecodedCall = {
  provider: 'lingtai-tui'
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
  subagentTypes: string[]
  turnId: string
  projectPath: string
  // Discovered/manifest-derived source project, carried through so the bridge
  // reproduces the pre-migration ParsedProviderCall byte-for-byte.
  project?: string
}
