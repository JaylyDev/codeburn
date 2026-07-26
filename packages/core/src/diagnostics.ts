import { z } from 'zod'

import type { SessionObservation } from './observations.js'

/** Maximum length of a diagnostic detail message. */
export const DIAGNOSTIC_DETAIL_MAX = 200

/**
 * A bounded, sanitized diagnostic message.
 *
 * The rule is deliberately crude but *structural*: reject any string containing
 * a path separator ('/' or '\\'), and cap the length at 200 chars. A decoder
 * cannot smuggle an absolute path (or most of a command line) through a
 * diagnostic detail, because a path without separators is not a path.
 */
export const DiagnosticDetail = z
  .string()
  .max(DIAGNOSTIC_DETAIL_MAX)
  .refine((s) => !s.includes('/') && !s.includes('\\'), {
    message: 'diagnostic detail must not contain path separators ("/" or "\\\\")',
  })

/** Classification of why a record could not be turned into an observation. */
export const DiagnosticCode = z.enum([
  'malformed-json',
  'unknown-shape',
  'missing-required',
  'invalid-value',
  'other',
])
export type DiagnosticCode = z.infer<typeof DiagnosticCode>

export const RecordDiagnostic = z
  .object({
    /** Index of the offending record within the input batch, when known. */
    index: z.number().int().nonnegative().optional(),
    code: DiagnosticCode,
    detail: DiagnosticDetail.optional(),
  })
  .strict()
export type RecordDiagnostic = z.infer<typeof RecordDiagnostic>

/**
 * The result of decoding a batch. Poison records must never throw or drop their
 * siblings; instead they surface as diagnostics. `state` is opaque and lets a
 * streaming decoder thread its carry-over between batches.
 */
export interface DecodeResult<TState = unknown> {
  observations: SessionObservation[]
  diagnostics: RecordDiagnostic[]
  state?: TState
}

/**
 * Coerce an arbitrary caught value into a detail string that satisfies
 * {@link DiagnosticDetail}: strip path separators and cap the length. Used so a
 * thrown error whose message embeds a path cannot leak that path verbatim.
 */
export function sanitizeDetail(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value)
  return raw.replace(/[\\/]+/g, ' ').slice(0, DIAGNOSTIC_DETAIL_MAX)
}

/** The per-record outcome a caller's `decodeOne` may return. */
export interface RecordOutcome {
  observations?: SessionObservation[]
  diagnostics?: RecordDiagnostic[]
}

/**
 * Generic poison-isolation loop. Runs `decodeOne` against each record; a record
 * that throws becomes an 'other' diagnostic (with a sanitized message) and the
 * loop continues, so one bad record never drops its siblings. This is the
 * pattern every concrete decoder is expected to use.
 */
export function isolateRecords(
  records: readonly unknown[],
  decodeOne: (record: unknown, index: number) => RecordOutcome,
): { observations: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const observations: SessionObservation[] = []
  const diagnostics: RecordDiagnostic[] = []

  records.forEach((record, index) => {
    try {
      const outcome = decodeOne(record, index)
      if (outcome.observations) observations.push(...outcome.observations)
      if (outcome.diagnostics) diagnostics.push(...outcome.diagnostics)
    } catch (err) {
      diagnostics.push({ index, code: 'other', detail: sanitizeDetail(err) })
    }
  })

  return { observations, diagnostics }
}
