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
 * A decoder turns a batch of raw provider records into observations plus
 * diagnostics, threading optional streaming `state` between batches.
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
