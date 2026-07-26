// Shared, pure helpers for the fingerprint-based detectors. A detector sees ONLY
// an ObservationEnvelope — no fs, no env, no clock — and returns Finding[]. Any
// value it emits is a number, an enum, or a 16-hex fingerprint (never a path).

import type { ResourceClassName } from '../schema.js'
import type { CallObservation, ObservationEnvelope, SessionObservation } from '../observations.js'

/** One read/edit charged at this many tokens — mirrors the host's AVG_TOKENS_PER_READ. */
export const AVG_TOKENS_PER_READ = 600

/**
 * Resource classes treated as "junk" (generated or third-party): a read into one
 * is not a read of the user's own code. This is the redesigned, path-free basis
 * for what the host CLI historically matched with a JUNK_DIRS regex. See the
 * junk-reads detector for the identity-semantics note on where the two differ.
 */
export const JUNK_RESOURCE_CLASSES: ReadonlySet<ResourceClassName> = new Set<ResourceClassName>([
  'dependency',
  'build',
  'vcs',
])

/**
 * Tool names counted as reads / edits for the read-to-edit ratio. Kept in
 * lockstep with the host CLI's READ_TOOL_NAMES / EDIT_TOOL_NAMES. Pattern search
 * tools (Grep/Glob) count as reads here even though they target no single file,
 * so they contribute to the ratio without ever producing a resource ref.
 */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read', 'Grep', 'Glob', 'FileReadTool', 'GrepTool', 'GlobTool',
])
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit', 'Write', 'FileEditTool', 'FileWriteTool', 'NotebookEdit',
])

export function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** Every (session, call) pair in the envelope, in order. */
export function forEachCall(
  envelope: ObservationEnvelope,
  fn: (call: CallObservation, session: SessionObservation) => void,
): void {
  for (const session of envelope.sessions) {
    for (const call of session.calls) fn(call, session)
  }
}
