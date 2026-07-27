// @codeburn/core Devin provider.
//
// Two layers:
//  - Rich pure decode (`decodeDevin`): host-facing, NOT part of the stable
//    minimized surface. Pure over host-supplied transcript + sessions.db row;
//    carries content in-memory but no pricing (cost leaves the decoder).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export { decodeDevin } from './decode.js'
export type { DevinDecodeInput, DevinDecodeResult } from './decode.js'
export { toObservations } from './observations.js'
export type { RichDevinSessionDecode, DevinToObservationsContext } from './observations.js'
export type {
  DevinAgentTrajectory,
  DevinDecodedCall,
  DevinDecodeRecord,
  DevinSessionMetadata,
  DevinStep,
  ToolCall,
} from './types.js'
