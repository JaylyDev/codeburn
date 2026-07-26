// @codeburn/core Qwen provider.
//
// Two layers:
//  - Rich pure decode (`decodeQwen`): host-facing, NOT part of the stable
//    minimized surface. Pure over supplied records; carries content in-memory
//    but no pricing (cost leaves the decoder) and no bash base-name extraction
//    (that stays host-side with its `strip-ansi` dependency).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeQwen,
  parseQwenLine,
  qwenToolNameMap,
  type QwenDecodeInput,
  type QwenDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichQwenSessionDecode,
  type QwenToObservationsContext,
} from './observations.js'

export type {
  QwenDecodedCall,
  QwenEntry,
  QwenPart,
  QwenToolCall,
} from './types.js'
