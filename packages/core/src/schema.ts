import { z } from 'zod'

/**
 * ObservationEnvelope schema version. 0.x per decision D8: the observation
 * contract is pre-stability, so consumers must treat minor bumps as breaking.
 *
 * 0.2.0 adds the optional per-call `resourceReads` / `resourceEdits` arrays
 * (ResourceRef). Strictness rules are unchanged: every added field is either a
 * fingerprint or a coarse enum, so the anti-smuggling property still holds.
 */
export const OBSERVATION_SCHEMA_VERSION = '0.2.0'

/**
 * A privacy-preserving fingerprint: the first 16 hex chars of an HMAC-SHA256.
 * Modelled as a strict 16-char lowercase-hex string so the schema can only ever
 * carry an opaque ref — never a raw id, path, or branch name (anti-smuggling).
 */
export const FingerprintHex = z
  .string()
  .regex(/^[0-9a-f]{16}$/, 'must be a 16-char lowercase hex fingerprint')

/** A non-negative integer (token counts, LOC deltas, error counts). */
export const NonNegInt = z.number().int().nonnegative()

/** A non-negative dollar amount. */
export const NonNegUSD = z.number().nonnegative()

/**
 * ISO-8601 timestamp. Offsets are permitted so hosts in any timezone can emit
 * without first normalising to UTC.
 */
export const IsoTimestamp = z.string().datetime({ offset: true })

/**
 * Canonical tool name. Restricted to a conservative identifier charset so a
 * decoder physically cannot smuggle tool ARGUMENTS, paths, or free text through
 * this field — only the canonical name of the tool may appear.
 */
export const CanonicalToolName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/, 'canonical tool names only (no args, paths, or spaces)')

/** Per-call token buckets. All five are required, non-negative integers. */
export const TokenBuckets = z
  .object({
    input: NonNegInt,
    output: NonNegInt,
    reasoning: NonNegInt,
    cacheRead: NonNegInt,
    cacheCreate: NonNegInt,
  })
  .strict()
export type TokenBuckets = z.infer<typeof TokenBuckets>

/** Inference speed tier. Matches the CLI's `'standard' | 'fast'`. */
export const Speed = z.enum(['standard', 'fast'])
export type Speed = z.infer<typeof Speed>

/**
 * Coarse, non-identifying bucket for a filesystem resource. Mirrors the
 * `ResourceClass` union produced by `classifyResource` in fingerprint.ts. It is
 * a small closed enum so it can never carry a raw path or free text.
 */
export const ResourceClassName = z.enum([
  'dependency',
  'build',
  'vcs',
  'config',
  'source',
  'doc',
  'other',
])
export type ResourceClassName = z.infer<typeof ResourceClassName>

/**
 * A reference to a filesystem resource a call touched: the opaque 16-hex
 * fingerprint of its normalised path plus its coarse class. `.strict()` blocks
 * any extra field, so the RAW path can never ride along — the structural
 * anti-smuggling property extended to resource refs.
 */
export const ResourceRef = z
  .object({
    resourceId: FingerprintHex,
    resourceClass: ResourceClassName,
  })
  .strict()
export type ResourceRef = z.infer<typeof ResourceRef>

/**
 * How a call's cost was determined.
 *  - 'measured'  : a provider-reported dollar figure is authoritative.
 *  - 'estimated' : cost is derived from the token buckets via a pricing pass.
 */
export const CostBasis = z.enum(['measured', 'estimated'])
export type CostBasis = z.infer<typeof CostBasis>
