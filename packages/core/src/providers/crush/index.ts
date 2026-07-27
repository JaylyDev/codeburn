// @codeburn/core Crush provider.
//
// Two layers:
//  - Rich pure decode (`decodeCrush`): host-facing, NOT part of the stable
//    minimized surface. Pure over host-supplied session records (the sqlite
//    driver and SQL queries stay CLI-side, per the Category B recipe).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeCrush,
  type CrushDecodeInput,
  type CrushDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichCrushSessionDecode,
  type CrushToObservationsContext,
} from './observations.js'

export type {
  CrushDecodedCall,
  CrushRawRecord,
  CrushSessionRow,
} from './types.js'
