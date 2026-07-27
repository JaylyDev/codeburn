// @codeburn/core Codebuff provider.
//
// Two layers:
//  - Rich pure decode (`decodeCodebuff`): host-facing, NOT part of the stable
//    minimized surface. Pure over supplied records; carries content in-memory
//    but no pricing and no bash base-name extraction.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeCodebuff,
  codebuffToolNameMap,
  type CodebuffDecodeInput,
  type CodebuffDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichCodebuffSessionDecode,
  type CodebuffToObservationsContext,
} from './observations.js'

export type {
  CodebuffDecodedCall,
  CodebuffChatMessage,
  CodebuffMetadata,
  CodebuffUsage,
  CodebuffBlock,
  CodebuffHistoryMessage,
} from './types.js'
