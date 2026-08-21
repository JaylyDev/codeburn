// @codeburn/core Codex provider.
//
// Two layers:
//  - Rich pure decode (`decodeCodex`): host-facing, NOT part of the stable
//    minimized surface. Pure over supplied records with EXPLICIT serializable
//    state; carries content in-memory but no pricing (cost leaves the decoder).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeCodex,
  freshCodexState,
  parseCodexLine,
  countUnifiedDiffLoc,
  mcpToolFromShellCommand,
  codexToolNameMap,
  type CodexDecodeInput,
  type CodexDecodeResult,
  type CodexResumeCheckpoint,
} from './decode.js'

export {
  toObservations,
  type RichCodexSessionDecode,
  type CodexToObservationsContext,
} from './observations.js'

export type {
  CodexDecodedCall,
  CodexDecodeState,
  CodexEntry,
  CodexToolCall,
  CodexTokenUsage,
} from './types.js'
