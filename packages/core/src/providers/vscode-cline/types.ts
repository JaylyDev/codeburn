// Raw record + rich-decode types for the vscode-cline family (Cline, Roo Code,
// Kilo Code, IBM Bob). The host reads the task directory and hands core a single
// envelope per task; no fs/env/clock here.

/** One ui_messages.json entry. */
export type ClineUiMessage = {
  type?: string
  say?: string
  text?: string
  ts?: number
}

/** One api_conversation_history.json message. */
export type ClineHistoryMessage = {
  role?: string
  content?: Array<{ text?: string }>
}

/** The single record the host hands to the core decoder. */
export type ClineRecordEnvelope = {
  kind: 'cline-task'
  /** basename(taskDir) — the host resolves it; core never touches paths. */
  taskId: string
  /** Raw contents of ui_messages.json. Parsed in core. */
  uiRaw: string
  /** Raw contents of api_conversation_history.json, or null when unreadable. */
  historyRaw: string | null
}

/** The rich decode of one vscode-cline api_req_started entry, pre-pricing. */
export interface VscodeClineDecodedCall {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  /** Provider-reported dollars from the api_req_started payload; host maps to costBasis 'measured'. */
  measuredCostUSD?: number
  tools: string[]
  rawBashCommands: string[]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  userMessage: string
  sessionId: string
  project?: string
  projectPath?: string
}
