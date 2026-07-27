// @codeburn/core OpenCode-session provider.
//
// Two layers:
//  - Rich pure decode (`decodeOpenCodeSession`): host-facing, NOT part of the stable
//    minimized surface. Pure over host-supplied session records; all I/O and
//    query strings stay CLI-side, per the Category B recipe.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeOpenCodeSession,
  type OpenCodeSessionDecodeInput,
  type OpenCodeSessionDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichOpenCodeSessionDecode,
  type OpenCodeSessionToObservationsContext,
} from './observations.js'

export type {
  OpenCodeSessionDecodedCall,
  OpenCodeSessionEnvelope,
  OpenCodeSessionTokens,
  MessageData,
  PartData,
  SessionMeta,
  FileMessageData,
} from './types.js'
