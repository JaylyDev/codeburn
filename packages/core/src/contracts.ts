import { z } from 'zod'

import type { RecordDiagnostic } from './diagnostics.js'
import { FingerprintHex } from './schema.js'
import type { ObservationEnvelope, SessionObservation } from './observations.js'

/**
 * Finding schema version. 0.x per decision D8: pre-stability, minor bumps may
 * break consumers.
 *
 * 0.2.0 tracks the observation layer's move to 128-bit fingerprints: findings
 * carry refs drawn straight from observations, so widening those refs changes
 * this wire format too. Re-emitting under the old version would silently
 * redefine what `finding-0.1.0` means for anyone already validating against it.
 */
export const FINDING_SCHEMA_VERSION = '0.2.0'

// ---------------------------------------------------------------------------
// Decoder contract (types only — implementations live in per-provider packages)
// ---------------------------------------------------------------------------

/** Context a decoder needs, but that must never appear in its output. */
export interface DecodeContext {
  /** Caller-supplied HMAC key for all fingerprints (decision D1). */
  privacyKey: string
  /** The provider whose records these are. */
  providerId: string
  /** An opaque fingerprint of the source (file/stream) being decoded. */
  sourceRef: string
}

/**
 * @deprecated No shipped provider implements this shape, and none ever has.
 *
 * It describes a single step from raw records straight to observations. Every
 * real provider runs TWO steps: a provider-specific rich decode
 * (`decodeClaude`, `decodeCodex`, …) that returns a provider-shaped result,
 * then an observation adapter (`toObservations`) that minimizes it. A consumer
 * who typed against `Decoder` and reached for a provider function got a
 * compile error and no explanation.
 *
 * Kept as an alias for one release so existing imports still resolve. Type
 * against `RichDecoder` and `ObservationAdapter` instead, or — better — import
 * the provider's own exported function types, which are precise.
 */
export type Decoder<TState = unknown> = (input: {
  records: unknown[]
  context: DecodeContext
  state?: TState
}) => {
  observations: SessionObservation[]
  diagnostics: RecordDiagnostic[]
  state?: TState
}

/**
 * Stage 1 output: a provider-shaped rich decode plus per-record diagnostics.
 *
 * The rich value is deliberately unconstrained — it holds the provider's own
 * vocabulary (user messages, paths, tool arguments) and is HOST-SIDE ONLY. It
 * must never be serialized onto the wire; that is what stage 2 is for.
 */
export interface RichDecodeResult<TRich> {
  value: TRich
  diagnostics: RecordDiagnostic[]
}

/**
 * Stage 1: raw provider records -> rich, provider-shaped decode.
 *
 * `TInput` is per-provider (each declares its own `*DecodeInput`), which is why
 * this is a two-parameter type rather than one fixed signature. Providers whose
 * descriptor reports `supportsIncrementalState` accept a caller-owned dedup set
 * on that input so an incremental scan does not re-emit known calls.
 */
export type RichDecoder<TInput, TRich> = (input: TInput) => RichDecodeResult<TRich>

/**
 * Stage 2: rich decode -> minimized observations. This is the boundary the
 * content-smuggling suite guards; nothing but fingerprints, enums, numbers,
 * timestamps, and canonical labels may cross it.
 */
export type ObservationAdapter<TRich, TOptions> = (
  rich: TRich,
  options: TOptions,
) => { sessions: SessionObservation[] }

/** A detector inspects a full envelope and emits findings. */
export type Detector = (envelope: ObservationEnvelope) => Finding[]

// ---------------------------------------------------------------------------
// Finding contract (zod validators — this is a wire schema)
// ---------------------------------------------------------------------------

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * A single machine-readable piece of evidence. `refs`/`sessionRefs` may hold
 * ONLY fingerprints (16-char hex) — never raw ids — so a finding cannot smuggle
 * identifying data. `.strict()` blocks unknown fields.
 */
export const Evidence = z
  .object({
    kind: z.string().min(1).max(64),
    count: z.number().int().nonnegative().optional(),
    refs: z.array(FingerprintHex).optional(),
    sessionRefs: z.array(FingerprintHex).optional(),
  })
  .strict()
export type Evidence = z.infer<typeof Evidence>

export const Confidence = z
  .object({
    score: z.number().min(0).max(1),
    /** A short, algorithm-authored rationale (bounded to keep it non-narrative). */
    basis: z.string().min(1).max(200),
  })
  .strict()
export type Confidence = z.infer<typeof Confidence>

export const Finding = z
  .object({
    detectorId: z.string().min(1).max(128),
    algorithmVersion: z.string().regex(SEMVER, 'must be a semver string'),
    confidence: Confidence,
    evidence: z.array(Evidence),
    impactUSD: z.number().optional(),
  })
  .strict()
export type Finding = z.infer<typeof Finding>
