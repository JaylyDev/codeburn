// @codeburn/core Antigravity provider.
//
// Two layers:
//  - Rich pure decode (`decodeAntigravityGenMetadata`,
//    `decodeAntigravityGeneratorMetadata`, `decodeAntigravityStatusLine`,
//    `parseAntigravityStatusLinePayload`): host-facing, NOT part of the stable
//    minimized surface. Pure over supplied records; carries token buckets but no
//    pricing (cost leaves the decoder).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeAntigravityGenMetadata,
  decodeAntigravityGeneratorMetadata,
  decodeAntigravityStatusLine,
  parseAntigravityStatusLinePayload,
  extractAntigravityModelMap,
  extractAntigravityGeneratorMetadata,
  type AntigravityGenMetadataDecodeInput,
  type AntigravityGeneratorMetadataDecodeInput,
  type AntigravityStatusLineDecodeInput,
  type AntigravityDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichAntigravitySessionDecode,
  type AntigravityToObservationsContext,
} from './observations.js'

export type {
  AntigravityDecodedCall,
  AntigravityGeneratorMetadata,
  AntigravityGeneratorMetadataResponse,
  AntigravityGenMetadataRow,
  AntigravityModelMap,
  AntigravityModelMapResponse,
  AntigravityStatusLineCurrentUsage,
  AntigravityStatusLineEvent,
  AntigravityStatusLinePayload,
  AntigravityUsageEntry,
  ProtoField,
  ProtoVarint,
} from './types.js'
