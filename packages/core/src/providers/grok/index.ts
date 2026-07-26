// @codeburn/core Grok provider.
//
// Two layers:
//  - Rich pure decode (`decodeGrok`): host-facing, NOT part of the stable
//    minimized surface. Pure over the host-supplied composite record; carries
//    content in-memory but no pricing and no bash base-name extraction.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeGrok,
  grokToolNameMap,
  type GrokDecodeInput,
  type GrokDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichGrokSessionDecode,
  type GrokToObservationsContext,
} from './observations.js'

export type {
  GrokDecodedCall,
  GrokSessionRecords,
  GrokSummary,
  GrokSignals,
  GrokUpdate,
} from './types.js'
