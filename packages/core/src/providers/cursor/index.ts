// @codeburn/core Cursor provider.
//
// Two layers:
//  - Rich pure decode (`decodeCursor`): host-facing, NOT part of the stable
//    minimized surface. Pure over the five row sets the host hands it; carries
//    content in-memory but no pricing and no bash base-name extraction.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export { decodeCursor, parseComposerIdFromKey, extractLanguages, contentTextLength } from './decode.js'
export type { CursorDecodeInput, CursorDecodeResult } from './decode.js'
export { toObservations } from './observations.js'
export type {
  RichCursorSessionDecode,
  CursorToObservationsContext,
} from './observations.js'
export type {
  CursorDecodedCall,
  CursorBubbleRow,
  CursorAgentKvRow,
  CursorUserMessageRow,
  CursorComposerMetaRow,
  CursorComposerMeta,
  CursorUserMessageQueue,
  CursorAgentStream,
  CursorInputSource,
  CursorComposerScan,
} from './types.js'
