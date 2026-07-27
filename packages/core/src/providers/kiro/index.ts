// @codeburn/core Kiro provider.
//
// Two layers:
//  - Rich pure decode (`decodeKiroChatFile`, `decodeKiroModernExecution`,
//    `decodeKiroIdeFile`, `prepareKiroWorkspaceSession`,
//    `finishKiroWorkspaceSession`, `decodeKiroCliSession`, `decodeKiroV2Session`):
//    host-facing, NOT part of the stable minimized surface. Pure over supplied
//    records; carries content in-memory but no pricing and no fs/clock/env.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeKiroChatFile,
  decodeKiroModernExecution,
  decodeKiroIdeFile,
  prepareKiroWorkspaceSession,
  finishKiroWorkspaceSession,
  decodeKiroCliSession,
  decodeKiroV2Session,
  kiroToolNameMap,
  stringField,
  parseKiroTimestamp,
  extractText,
  extractToolNames,
  extractStructuredToolNames,
  type KiroDecodeResult,
  type KiroWorkspaceSessionPrepared,
} from './decode.js'

export {
  toObservations,
  type RichKiroSessionDecode,
  type KiroToObservationsContext,
} from './observations.js'

export type {
  KiroDecodedCall,
  KiroArm,
  KiroToolCall,
  KiroChatMessage,
  KiroChatFile,
  KiroModernExecution,
  KiroCliEntry,
  KiroCliSessionMeta,
  KiroV2SessionMeta,
  KiroWorkspaceSessionDraft,
} from './types.js'
