// @codeburn/core Hermes provider.
//
// Two layers:
//  - Rich pure decode (`decodeHermes`): host-facing, NOT part of the stable
//    minimized surface. Pure over host-supplied sqlite rows; carries content
//    in-memory but no pricing (cost leaves the decoder) and no bash base-name
//    extraction (that stays host-side with its `strip-ansi` dependency).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export { decodeHermes, hermesToolNameMap, mapToolName } from './decode.js'
export type { HermesDecodeInput, HermesDecodeResult } from './decode.js'
export { toObservations } from './observations.js'
export type { RichHermesSessionDecode, HermesToObservationsContext } from './observations.js'
export type {
  HermesDecodedCall,
  HermesMessageRow,
  HermesSessionRow,
  HermesToolCall,
  HermesToolSequenceEntry,
} from './types.js'
