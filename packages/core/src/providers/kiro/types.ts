// Raw record + rich-decode types for the Kiro provider.
//
// Kiro is a Category D stateful multi-store provider. The host keeps all I/O,
// discovery, durable caching, project attribution, and pricing; core owns only
// the pure decode of the five record shapes the host hands it: legacy .chat
// files, v1 modern executions, workspace-session files, CLI sessions, and v2
// IDE sessions.

export type KiroToolCall = { tool: string }

export type KiroArm = 'chat' | 'modern' | 'ws-session' | 'cli' | 'v2'

export type KiroChatMessage = {
  role: 'human' | 'bot' | 'tool'
  content: string
}

export type KiroChatFile = {
  executionId: string
  actionId: string
  chat: KiroChatMessage[]
  metadata: {
    modelId: string
    modelProvider: string
    workflow: string
    workflowId: string
    startTime: number
    endTime: number
  }
}

export type KiroModernExecution = Record<string, unknown>

export type KiroCliEntry = {
  version: string
  kind: 'Prompt' | 'AssistantMessage' | 'ToolResults' | 'Clear'
  data: Record<string, unknown>
}

export type KiroCliSessionMeta = {
  session_id: string
  cwd: string
  created_at: string
  updated_at: string
  title?: string
  session_state?: {
    rts_model_state?: { model_info?: { model_id?: string } }
    conversation_metadata?: {
      user_turn_metadatas?: Array<{
        end_timestamp?: string
        builtin_tool_uses?: number
        metering_usage?: Array<{ value: number; unit: string }>
        total_request_count?: number
      }>
    }
  }
}

export type KiroV2SessionMeta = {
  id?: string
  title?: string
  modelId?: string
  workspacePaths?: string[]
  createdAt?: string
  lastModifiedAt?: string
}

export type KiroWorkspaceSessionDraft = {
  sessionId: string
  modelId: string
  inputChars: number
  outputChars: number
  pendingUserMessage: string
  allTools: string[]
}

export type KiroDecodedCall = {
  provider: 'kiro'
  arm: KiroArm
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  /** Metered Kiro credits for this call; 0 when unmetered. The HOST prices them. */
  credits: number
  tools: string[]
  bashCommands: string[]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  userMessage: string
  sessionId: string
  /** Present ONLY for arms 'cli' and 'v2' (host-supplied attribution). */
  project?: string
  /** Present ONLY for arm 'chat'; may be undefined, mirroring the host's shape. */
  toolSequence?: KiroToolCall[][]
}
