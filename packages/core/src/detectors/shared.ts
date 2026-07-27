// Shared, pure helpers for the fingerprint-based detectors. A detector sees ONLY
// an ObservationEnvelope — no fs, no env, no clock — and returns Finding[]. Any
// value it emits is a number, an enum, or a 16-hex fingerprint (never a path).

import type { Finding } from '../contracts.js'
import type { ResourceClassName } from '../schema.js'
import type { CallObservation, ObservationEnvelope, SessionObservation } from '../observations.js'

/**
 * The token cost ASSUMED for one file read.
 *
 * Renamed from `AVG_TOKENS_PER_READ`, which implied a measurement. Nothing here
 * measured anything: 600 is a fixed heuristic applied to every read regardless
 * of file size, language, or provider, and a real corpus spans orders of
 * magnitude around it. Findings that use it carry `methodId` /`methodVersion`
 * so a consumer can tell an estimate produced under this assumption from one
 * produced under a future, better-grounded model.
 */
export const ASSUMED_TOKENS_PER_READ = 600

/** Identifies the estimation model above on every finding that applies it. */
export const FIXED_READ_TOKEN_METHOD_ID = 'fixed-read-token-assumption'
export const FIXED_READ_TOKEN_METHOD_VERSION = '1.0.0'

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

/**
 * Run a per-session rule over the envelope and collect whatever it emits.
 *
 * Detectors evaluate ONE session at a time. Aggregating across sessions
 * produced a single finding whose evidence spanned many subjects, which a host
 * could not attribute to anything without guessing. Project-level rollups are
 * a host concern: it already knows each session's `projectRef`.
 */
export function perSession(
  envelope: ObservationEnvelope,
  rule: (session: SessionObservation) => Finding | null,
): Finding[] {
  const findings: Finding[] = []
  for (const session of envelope.sessions) {
    const finding = rule(session)
    if (finding) findings.push(finding)
  }
  return findings
}
