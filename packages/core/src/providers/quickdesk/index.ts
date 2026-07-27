// @codeburn/core Quickdesk provider.
//
// Two layers:
//  - Rich pure decode (`decodeQuickdesk`): host-facing, NOT part of the stable
//    minimized surface. Pure over host-supplied records; carries content in-memory
//    but no pricing (cost leaves the decoder) and no bash base-name extraction.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export { decodeQuickdesk, quickdeskToolNameMap } from './decode.js'
export type { QuickdeskDecodeInput, QuickdeskDecodeResult } from './decode.js'
export { toObservations } from './observations.js'
export type { RichQuickdeskSessionDecode, QuickdeskToObservationsContext } from './observations.js'
export type {
  QuickdeskDecodedCall,
  QuickdeskDatabaseInput,
  QuickdeskMetricsInput,
  QuickdeskMetricsRecord,
  QuickdeskSessionMetadata,
} from './types.js'
