// @codeburn/core vscode-cline provider.
//
// Two layers:
//  - Rich pure decode (`decodeVscodeCline`): host-facing, NOT part of the stable
//    minimized surface. Pure over host-supplied task envelopes.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeVscodeCline,
  type VscodeClineDecodeInput,
  type VscodeClineDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichVscodeClineSessionDecode,
  type VscodeClineToObservationsContext,
} from './observations.js'

export type {
  ClineRecordEnvelope,
  ClineUiMessage,
  ClineHistoryMessage,
  VscodeClineDecodedCall,
} from './types.js'
