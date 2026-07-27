// @codeburn/core OpenClaw provider.
//
// Two layers:
//  - Rich pure decode (`decodeOpenClaw`): host-facing, NOT part of the stable
//    minimized surface. Pure over supplied records; carries content in-memory
//    but no host-computed pricing and no bash base-name extraction.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeOpenClaw,
  openclawToolNameMap,
  type OpenClawDecodeInput,
  type OpenClawDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichOpenClawSessionDecode,
  type OpenClawToObservationsContext,
} from './observations.js'

export type {
  OpenClawDecodedCall,
  OpenClawEntry,
  OpenClawUsage,
} from './types.js'
