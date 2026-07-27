// @codeburn/core Warp provider.
//
// Two layers:
//  - Rich pure decode (`decodeWarp`): host-facing, NOT part of the stable
//    minimized surface. Pure over host-supplied sqlite rows; carries content
//    in-memory but no pricing (cost leaves the decoder) and no bash base-name
//    extraction (that stays host-side with its `strip-ansi` dependency).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export { decodeWarp } from './decode.js'
export type { WarpDecodeInput, WarpDecodeResult } from './decode.js'
export { toObservations } from './observations.js'
export type { RichWarpSessionDecode, WarpToObservationsContext } from './observations.js'
export type {
  WarpBlockRow,
  WarpConversationData,
  WarpConversationRow,
  WarpDecodedCall,
  WarpExchangeToolInfo,
  WarpParsedExchange,
  WarpQueryRow,
  WarpTokenUsageEntry,
} from './types.js'
