import { z } from 'zod'

import type { RecordDiagnostic } from './diagnostics.js'
import { FingerprintHex } from './schema.js'
import type { ObservationEnvelope, SessionObservation } from './observations.js'

/**
 * Finding schema version. 0.x per decision D8: pre-stability, minor bumps may
 * break consumers.
 *
 * 0.2.0 tracked the observation layer's move to 128-bit fingerprints: findings
 * carry refs drawn straight from observations, so widening those refs changed
 * this wire format too. Re-emitting under the old version would silently
 * redefine what `finding-0.1.0` means for anyone already validating against it.
 *
 * 0.3.0 replaces the wire contract outright:
 *   - `impactUSD` is removed — core has no pricing and never measured cash;
 *   - every finding names one `subject`, so a host can attribute it;
 *   - free-text confidence rationale becomes controlled codes;
 *   - evidence kinds become a closed enum;
 *   - token effects move into an explicit, method-versioned `estimate` that
 *     cannot claim to be cash.
 */
export const FINDING_SCHEMA_VERSION = '0.3.0'

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
 * The kinds of evidence the shipped detectors emit. A closed enum rather than a
 * bounded string: `kind` is a key consumers branch on, and a free-text kind both
 * invites drift and is one more place prose could appear.
 *
 * `tokens-saved` is deliberately absent. It claimed an observed outcome the
 * detectors never observed; token effects now live in `estimate`, which is
 * explicitly labelled as an estimate.
 */
export const EvidenceKind = z.enum([
  'duplicate-reads',
  'junk-reads',
  'reads',
  'edits',
  'read-to-edit-ratio',
])
export type EvidenceKind = z.infer<typeof EvidenceKind>

/**
 * A single machine-readable piece of evidence. `refs`/`sessionRefs` may hold
 * ONLY fingerprints — never raw ids — so a finding cannot smuggle identifying
 * data. `.strict()` blocks unknown fields.
 */
export const Evidence = z
  .object({
    kind: EvidenceKind,
    count: z.number().int().nonnegative().optional(),
    /** Permits a ratio; counts use `count`. */
    value: z.number().nonnegative().optional(),
    refs: z.array(FingerprintHex).optional(),
    sessionRefs: z.array(FingerprintHex).optional(),
  })
  .strict()
export type Evidence = z.infer<typeof Evidence>

/**
 * Why the detector is as confident as it is, as codes rather than prose.
 *
 * The old free-text `basis` was an algorithm-authored sentence — a narrative
 * field on a wire format that otherwise admits none, and unusable for anything
 * but display. Codes can be branched on and translated.
 */
export const ConfidenceBasis = z.enum([
  /** The threshold was crossed; nothing more is claimed. */
  'threshold-only',
  /** Confidence scales with how far past the threshold the count sits. */
  'count-strength',
  /** The same signal recurs across multiple resources or calls. */
  'repeated-evidence',
])
export type ConfidenceBasis = z.infer<typeof ConfidenceBasis>

export const Confidence = z
  .object({
    score: z.number().min(0).max(1),
    basis: z.array(ConfidenceBasis).min(1),
  })
  .strict()
export type Confidence = z.infer<typeof Confidence>

/**
 * What a finding is ABOUT. Previously a finding could aggregate many sessions
 * with no single subject, so a host could not attribute it to anything without
 * guessing. Every finding now names exactly one subject, and the host joins
 * `sessionRef` to `projectRef` itself for rollups.
 */
export const FindingSubject = z
  .object({
    kind: z.enum(['session', 'project']),
    ref: FingerprintHex,
  })
  .strict()
export type FindingSubject = z.infer<typeof FindingSubject>

/**
 * A modelled quantity, never a measurement and never money.
 *
 * `impactUSD` is gone. Core has no pricing and never did; a dollar figure on a
 * finding invited hosts to render "you wasted $X" from an assumption. Even the
 * token figure is modelled — `methodId`/`methodVersion` name the model so a
 * consumer can tell when the number changed because the method changed.
 *
 * `nonCash: true` is a required literal. It cannot be set to false, so no
 * serialized finding can ever assert that its value is realized cash.
 */
export const Estimate = z
  .object({
    metric: z.enum(['avoidable-tokens', 'additional-context-tokens']),
    value: z.number().nonnegative(),
    unit: z.literal('tokens'),
    methodId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
    methodVersion: z.string().regex(SEMVER, 'must be a semver string'),
    nonCash: z.literal(true),
  })
  .strict()
export type Estimate = z.infer<typeof Estimate>

export const Finding = z
  .object({
    schemaVersion: z.literal(FINDING_SCHEMA_VERSION),
    detector: z
      .object({
        id: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/),
        algorithmVersion: z.string().regex(SEMVER, 'must be a semver string'),
      })
      .strict(),
    subject: FindingSubject,
    confidence: Confidence,
    evidence: z.array(Evidence).min(1),
    estimate: Estimate.optional(),
  })
  .strict()
export type Finding = z.infer<typeof Finding>
