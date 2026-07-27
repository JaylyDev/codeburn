// Raw record + rich-decode types for the Cursor provider.
//
// Cursor is a Category D stateful multi-store provider. The host keeps all I/O,
// discovery, durable caching, project attribution, and pricing; core owns only
// the pure decode of the five row sets the host hands it.

/** One row from the host's BUBBLE_QUERY_SINCE / BUBBLE_QUERY_PAGE fetch. */
export type CursorBubbleRow = {
  bubble_key: string
  input_tokens: number | null
  output_tokens: number | null
  model: string | null
  created_at: string | null
  request_id: string | null
  /** Raw BLOB/TEXT from CAST(substr(text,1,500) AS BLOB). */
  user_text: Uint8Array | string | null
  text_length: number | null
  /** 1 = user, otherwise assistant. */
  bubble_type: number | null
  /** Raw JSON BLOB/TEXT from CAST(codeBlocks AS BLOB). */
  code_blocks: Uint8Array | string | null
  /** Only populated on the paged scan path. */
  rid?: number
}

/** One row from the host's AGENTKV_QUERY. */
export type CursorAgentKvRow = {
  role: string | null
  /** Raw BLOB/TEXT content; kept as the raw union so empty-blob handling is preserved. */
  content: Uint8Array | string | null
  request_id: string | null
  model: string | null
}

/** One row from the host's USER_MESSAGES_QUERY. */
export type CursorUserMessageRow = {
  bubble_key: string
  created_at: string
  /** Raw BLOB/TEXT text; kept as the raw union so empty-blob handling is preserved. */
  text: Uint8Array | string
}

/** One row from the host's COMPOSER_META_QUERY. */
export type CursorComposerMetaRow = {
  composer_id: string
  used: number | null
  ctx: number | null
  created_at: number | null
}

/** Per-conversation metadata folded from CursorComposerMetaRow. */
export type CursorComposerMeta = {
  tokens: number
  createdAt: number | null
}

/// Per-conversation user-message buffer. We pop messages in arrival order via
/// the `pos` cursor — a previous implementation called Array.shift() which is
/// O(n) per call on large conversations and pinned multi-GB Cursor DBs at
/// minutes-of-parse for power users. The cursor walk is O(1).
export type CursorUserMessageQueue = {
  messages: string[]
  pos: number
}

/** Accumulated agent-stream state for one conversation or unjoined request. */
export type CursorAgentStream = {
  tools: string[]
  /** Raw command strings; bash base-name extraction stays host-side. */
  bash: string[]
  userChars: number
  contextChars: number
  assistantChars: number
  model: string | null
}

/** What drives a conversation's input figure, decided per conversation. */
export type CursorInputSource = 'bubbleTokens' | 'meter' | 'stream' | 'text'

/** Per-conversation facts gathered in the pre-pass over bubble rows. */
export type CursorComposerScan = {
  hasRealTokens: boolean
  firstBubbleTs: string | null
  assistantTextChars: number
  model: string | null
}

/**
 * Rich decode of one Cursor call, pre-pricing. Mirrors the host's
 * ParsedProviderCall minus the host-owned cost fields (costBasis,
 * costIsEstimated, pricingModel) and minus bash base-name extraction.
 *
 * `rawModel` is the effective model before the 'cursor-auto' display fallback so
 * the host can compute its pricing model.
 */
export type CursorDecodedCall = {
  provider: 'cursor'
  model: string
  rawModel: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  speed: 'standard'
  tools: string[]
  rawBashCommands: string[]
  timestamp: string
  deduplicationKey: string
  userMessage: string
  sessionId: string
}
