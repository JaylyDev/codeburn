// @codeburn/core Claude provider.
//
// Two layers:
//  - Rich pure decode (this file's re-exports of scanner/decode): host-facing,
//    NOT part of the stable minimized surface. Pure over supplied records/lines,
//    may carry content in-memory.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; content-smuggling guarantees bind here.

export {
  BASH_TOOLS,
  EDIT_TOOLS,
} from './tool-vocab.js'

export {
  LARGE_JSONL_LINE_BYTES,
  RAW_HEAD_BYTES,
  parseLargeJsonl,
  getTopLevelRawJsonStringField,
} from './scanner.js'

export {
  parseJsonlLine,
  shouldSkipLine,
  compactEntry,
  safeNumber,
  isPositiveNumber,
  countStructuredPatchLoc,
  emptySessionMeta,
  collectToolResultMeta,
  collectSessionMeta,
  decodeAssistantCall,
  decodeAdvisorCalls,
  getMessageId,
  dedupeStreamingMessageIds,
  groupIntoTurns,
  buildSpawnPrSets,
  extractMcpInventory,
  extractPrUrlsFromText,
} from './decode.js'

export {
  toObservations,
  type RichSessionDecode,
  type ToObservationsContext,
} from './observations.js'

export type {
  ApiUsage,
  ApiUsageIteration,
  AssistantMessageContent,
  ContentBlock,
  DecodedCall,
  DecodedTurn,
  JournalEntry,
  SessionMeta,
  TokenUsage,
  ToolCall,
  ToolResultMeta,
  ToolUseBlock,
} from './types.js'
