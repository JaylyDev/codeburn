// @codeburn/core Forge provider.
//
// Two layers:
//  - Rich pure decode (`decodeForge`): host-facing, NOT part of the stable
//    minimized surface. Pure over the host-supplied `conversations` row (the
//    sqlite driver and SQL query stay CLI-side, Category B); parses the
//    `context` JSON blob itself.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeForge,
  type ForgeDecodeInput,
  type ForgeDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichForgeSessionDecode,
  type ForgeToObservationsContext,
} from './observations.js'

export type {
  ForgeConversationRow,
  ForgeContextMessage,
  ForgeDecodedCall,
} from './types.js'
