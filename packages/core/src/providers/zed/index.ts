// @codeburn/core Zed provider.
//
// Two layers:
//  - Rich pure decode (`decodeZed`): host-facing, NOT part of the stable
//    minimized surface. Pure over the host-supplied `threads` rows (the sqlite
//    driver and SQL query stay CLI-side, Category B); decompresses and parses
//    the zstd/json blob itself.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeZed,
  type ZedDecodeInput,
  type ZedDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichZedSessionDecode,
  type ZedToObservationsContext,
} from './observations.js'

export type {
  ZedDecodedCall,
  ZedThreadJson,
  ZedThreadRow,
  ZedTokenUsage,
} from './types.js'
