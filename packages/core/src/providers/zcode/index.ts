// @codeburn/core ZCode provider.
//
// Two layers:
//  - Rich pure decode (`decodeZcode`): host-facing, NOT part of the stable
//    minimized surface. Pure over the host-supplied model_usage/tool_usage row
//    bundle (the sqlite driver and SQL queries stay CLI-side, Category B).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeZcode,
  type ZcodeDecodeInput,
  type ZcodeDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichZcodeSessionDecode,
  type ZcodeToObservationsContext,
} from './observations.js'

export type {
  ZcodeDecodedCall,
  ZcodeSessionRecords,
  ZcodeToolRow,
  ZcodeUsageRow,
} from './types.js'
