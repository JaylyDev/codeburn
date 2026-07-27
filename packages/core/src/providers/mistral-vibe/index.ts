// @codeburn/core Mistral Vibe provider.
//
// Two layers:
//  - Rich pure decode (`decodeMistralVibe`): host-facing, NOT part of the stable
//    minimized surface. Pure over host-supplied records; the host resolves the
//    session-level dollar figure (including any price-table fallback) and this
//    decoder only allocates it across assistant messages.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeMistralVibe,
  mistralVibeToolNameMap,
  type MistralVibeDecodeInput,
  type MistralVibeDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichMistralVibeSessionDecode,
  type MistralVibeToObservationsContext,
} from './observations.js'

export type {
  MistralVibeDecodedCall,
  MistralVibeSessionRecord,
  VibeMessage,
  VibeMetadata,
  VibeStats,
  VibeModelConfig,
  VibeToolCall,
} from './types.js'
