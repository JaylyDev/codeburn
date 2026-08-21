// @codeburn/core Copilot provider.
//
// Two layers:
//  - Rich pure decode (`decodeCopilot`): host-facing, NOT part of the stable
//    minimized surface. Pure over the host-supplied records envelope (the sqlite
//    driver, filesystem, and SQL queries stay CLI-side, Category B).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  collectJetBrainsRepoDirCandidates,
  copilotJetBrainsCacheIdentityKey,
  copilotJetBrainsDeduplicationKey,
  copilotToolNameMap,
  decodeCopilot,
  normalizeCopilotTool,
  type CopilotDecodeInput,
  type CopilotDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichCopilotSessionDecode,
  type CopilotToObservationsContext,
} from './observations.js'

export type {
  CopilotDecodedCall,
  CopilotOtelConversationRecord,
  CopilotOtelSpanRecord,
  CopilotRecordEnvelope,
  SpanAttributes,
} from './types.js'
