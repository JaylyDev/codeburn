// @codeburn/core CodeWhale provider.
//
// Two layers:
//  - Rich pure decode (`decodeCodeWhale`): host-facing, NOT part of the stable
//    minimized surface. Pure over the host-supplied parsed session; carries
//    content in-memory but performs no pricing and no bash base-name extraction.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeCodeWhale,
  codeWhaleToolNameMap,
  mapCodeWhaleToolName,
  type CodeWhaleDecodeInput,
  type CodeWhaleDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichCodeWhaleSessionDecode,
  type CodeWhaleToObservationsContext,
} from './observations.js'

export type {
  CodeWhaleDecodedCall,
  CodeWhaleSessionRecords,
  CodeWhaleMetadata,
  CodeWhaleMessage,
  CodeWhaleToolCall,
} from './types.js'
