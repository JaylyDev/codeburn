// @codeburn/core Goose provider.
//
// Two layers:
//  - Rich pure decode (`decodeGoose`): host-facing, NOT part of the stable
//    minimized surface. Pure over the host-supplied session/message row bundle
//    (the sqlite driver and SQL queries stay CLI-side, Category B).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeGoose,
  gooseToolNameMap,
  type GooseDecodeInput,
  type GooseDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichGooseSessionDecode,
  type GooseToObservationsContext,
} from './observations.js'

export type {
  GooseContentItem,
  GooseDecodedCall,
  GooseMessageRow,
  GooseModelConfig,
  GooseSessionRecords,
  GooseSessionRow,
  GooseToolCall,
} from './types.js'
