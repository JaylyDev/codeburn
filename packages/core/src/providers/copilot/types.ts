// Types for Copilot record decoding. These types are shared between the
// CLI-side I/O adapter and the core decoder.

export type ToolRequest = {
  toolName?: string  // older format
  name?: string      // newer format (copilot-agent)
  arguments?: Record<string, unknown>
}

export type SessionStartData = {
  selectedModel?: string
}

export type ModelChangeData = {
  newModel: string
  previousModel?: string
}

export type UserMessageData = {
  content: string
  interactionId?: string
}

export type AssistantMessageData = {
  messageId: string
  model?: string       // present in newer copilot-agent format
  outputTokens: number
  interactionId?: string
  toolRequests?: ToolRequest[]
}

export type SubagentSelectedData = {
  agentName: string
  agentDisplayName?: string
  tools?: string[]
}

// Per-model usage rollup the CLI writes into session.shutdown. inputTokens is
// cache-INCLUSIVE (input + cache_read + cache_write); see the shutdown handler.
export type ShutdownModelUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export type SessionShutdownData = {
  modelMetrics?: Record<string, { usage?: ShutdownModelUsage }>
  sessionStartTime?: number
}

export type CopilotEvent =
  | { type: 'session.start'; data: SessionStartData; timestamp?: string }
  | { type: 'session.model_change'; data: ModelChangeData; timestamp?: string }
  | { type: 'user.message'; data: UserMessageData; timestamp?: string }
  | { type: 'assistant.message'; data: AssistantMessageData; timestamp?: string }
  | { type: 'subagent.selected'; data: SubagentSelectedData; timestamp?: string }
  | { type: 'session.shutdown'; data: SessionShutdownData; timestamp?: string }

export type ChatJournalPathSegment = string | number
export type ChatSessionRequest = Record<string, unknown>

// Parsed attribute bag from a span
export interface SpanAttributes {
  'gen_ai.operation.name'?: string
  'gen_ai.response.model'?: string
  'gen_ai.request.model'?: string
  'gen_ai.usage.input_tokens'?: number
  'gen_ai.usage.output_tokens'?: number
  'gen_ai.usage.cache_read.input_tokens'?: number
  'gen_ai.usage.cache_creation.input_tokens'?: number
  'gen_ai.conversation.id'?: string
  'gen_ai.agent.name'?: string
  'gen_ai.tool.name'?: string
  'gen_ai.tool.call.arguments'?: string
  'copilot_chat.parent_chat_session_id'?: string
  'github.copilot.chat.turn.id'?: string
  [key: string]: unknown
}

// One assistant turn recovered from a .db.
export type JBDbTurn = {
  replyText: string
  model: string
  errored: boolean
  // The owning conversation (chat tab): its internal GUID and title. One .db
  // holds many conversations; turns are grouped back to their tab by this id.
  conversationId: string
  conversationTitle: string
  // The file path this conversation referenced (home-relative common dir), or
  // '' if the chat touched no files. Used as the project label.
  conversationProject: string
}

// A conversation (chat tab) recovered from a .db: internal GUID → title.
export type JBConversation = { id: string; title: string }

/** One OTel span row + its already-loaded attribute bag (host runs the sqlite). */
export interface CopilotOtelSpanRecord {
  spanId: string
  traceId: string
  operationName: string          // '' when the column was null
  startTimeMs: number
  responseModel: string | null
  attrs: SpanAttributes | null   // null for spans whose attrs the host did not load
}

export interface CopilotOtelConversationRecord {
  conversationId: string
  project: string                // already normalized host-side
  spans: CopilotOtelSpanRecord[] // ALL spans of this conversation's traces, query order
}

export type CopilotRecordEnvelope =
  | { kind: 'jsonl'; sessionId: string; lines: string[] }
  | { kind: 'chatsession'; fallbackSessionId: string; project: string; content: string }
  | { kind: 'jetbrains'; sessionId: string; mtime: string; projectName?: string
      raw: string; repoRootByDir: ReadonlyMap<string, string> }
  | { kind: 'otel'; conversations: CopilotOtelConversationRecord[] }

export type CopilotCallArm =
  | 'jsonl-turn' | 'jsonl-shutdown' | 'chatsession' | 'jetbrains' | 'otel'

export interface CopilotDecodedCall {
  /** Which parse arm produced this call. The host switches on it in toProviderCall. */
  arm: CopilotCallArm
  provider: 'copilot'
  sessionId: string
  /** Present only for arms that set it today (chatsession / jetbrains / otel). */
  project?: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  tools: string[]
  /** RAW command strings, in emission order. The host reduces them. */
  rawBashCommands: string[]
  skills?: string[]
  subagentTypes?: string[]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  userMessage: string
}
