// @codeburn/core Cursor Agent provider.
//
// Two layers:
//  - Rich pure decode (`decodeCursorAgent`): host-facing, NOT part of the stable
//    minimized surface. Pure over host-supplied records; carries content
//    in-memory but no pricing (cost leaves the decoder) and no bash base-name
//    extraction (that stays host-side with its `strip-ansi` dependency).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export { decodeCursorAgent } from './decode.js'
export type { CursorAgentDecodeInput, CursorAgentDecodeResult } from './decode.js'
export { toObservations } from './observations.js'
export type {
  RichCursorAgentSessionDecode,
  CursorAgentToObservationsContext,
} from './observations.js'
export type {
  CursorAgentDecodedCall,
  CursorAgentRecord,
  ConversationSummaryRow,
  AssistantTurn,
  ParsedTurn,
} from './types.js'
