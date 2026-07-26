// @codeburn/core Kimi provider.
//
// Two layers:
//  - Rich pure decode (`decodeKimi`): host-facing, NOT part of the stable
//    minimized surface. Pure over the host-supplied JSONL lines; carries
//    content in-memory but no pricing and no bash base-name extraction.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeKimi,
  kimiToolNameMap,
  type KimiDecodeInput,
  type KimiDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichKimiSessionDecode,
  type KimiToObservationsContext,
} from './observations.js'

export type {
  KimiDecodedCall,
  KimiSessionRecords,
} from './types.js'
