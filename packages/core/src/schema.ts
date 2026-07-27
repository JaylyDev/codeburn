import { z } from 'zod'

/**
 * ObservationEnvelope schema version. 0.x per decision D8: the observation
 * contract is pre-stability, so consumers must treat minor bumps as breaking.
 *
 * 0.2.0 adds the optional per-call `resourceReads` / `resourceEdits` arrays
 * (ResourceRef). Strictness rules are unchanged: every added field is either a
 * fingerprint or a coarse enum, so the anti-smuggling property still holds.
 *
 * 0.3.0 is BREAKING on three counts:
 *   - every fingerprint widens from 16 to 32 hex chars (64 -> 128 bits);
 *   - the raw per-call `dedupKey` becomes the fingerprinted `callRef`, closing
 *     the last field that carried provider-native ids verbatim;
 *   - envelopes now name the fingerprint algorithm and the host key id, so a
 *     consumer can tell whether two refs are even comparable.
 * `provider` / `model` / `pricingModel` also gain length + charset caps.
 */
export const OBSERVATION_SCHEMA_VERSION = '0.3.0'

/**
 * A privacy-preserving fingerprint: the first 32 hex chars (128 bits) of an
 * HMAC-SHA256. Modelled as a strict 32-char lowercase-hex string so the schema
 * can only ever carry an opaque ref — never a raw id, path, or branch name
 * (anti-smuggling).
 */
export const FingerprintHex = z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'must be a 32-char lowercase hex fingerprint')

/**
 * Names the fingerprint construction. A closed enum, so it can never carry free
 * text, and a consumer reading an envelope can tell exactly how the refs were
 * derived rather than inferring it from their length.
 */
export const FingerprintAlgorithm = z.enum(['hmac-sha256-128'])
export type FingerprintAlgorithm = z.infer<typeof FingerprintAlgorithm>

/**
 * Identifies WHICH host-managed privacy key produced the refs in an envelope —
 * it is emphatically NOT the key itself, and core never sees a key id and a key
 * together in any emitted field. Refs are only comparable across envelopes that
 * share a key id, so rotating the key must change this value.
 *
 * Capped and charset-restricted like every other label, so it cannot become a
 * smuggling channel.
 */
export const FingerprintKeyId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/, 'key ids only (no paths, spaces, or free text)')

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

/**
 * Canonical provider id (`claude`, `codex`, `vercel-gateway`). Capped and
 * charset-restricted for the same reason as CanonicalToolName: an unbounded
 * `z.string().min(1)` is a free-text channel, and a decoder that mistakenly
 * assigned a title or a path to this field would pass validation.
 */
export const CanonicalProviderId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/, 'canonical provider ids only (no paths, spaces, or free text)')

/**
 * Canonical model id (`claude-opus-4-8`, `anthropic/claude-sonnet-5`,
 * `gpt-5:fast`, `us.anthropic.claude-opus-4-8-v1:0`). A wider charset than
 * provider ids because vendors namespace with `/`, tag with `:`, and version
 * with `+`. The leading segment may not be empty and `..` is rejected, so a
 * filesystem path cannot masquerade as a model id.
 *
 * KNOWN RESIDUAL: a charset cannot separate a model id from every string that
 * merely LOOKS like one. `sk-live-0123456789abcdef` and
 * `feature/acme-acquisition` are shape-identical to legitimate model ids, so a
 * malicious decoder could still route one of those here. What the constraint
 * does guarantee is that no prose, prompt, file content, command line,
 * whitespace, or newline reaches the field, and that its length is bounded.
 * Tests in label-constraints.test.ts pin both the guarantee and the residual.
 */
export const CanonicalModelId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:+-][A-Za-z0-9._:/+-]*$/, 'canonical model ids only (no spaces, free text, or leading separator)')
  .refine((s) => !s.includes('..'), { message: 'model ids may not contain ".."' })
  .refine((s) => !s.includes('//'), { message: 'model ids may not contain "//"' })

/**
 * Fallback emitted when a decoded label is not canonical. The decoders already
 * use `'unknown'` for a missing model, so a non-canonical one lands in the same
 * bucket rather than inventing a second sentinel.
 */
export const UNKNOWN_LABEL = 'unknown'

/**
 * Coerce a decoded provider id to the canonical charset, falling back to
 * `'unknown'`.
 *
 * Adapters must call these rather than passing decoded labels straight through.
 * A provider that ever puts free text where a model id belongs would otherwise
 * fail envelope validation and cost the host the ENTIRE session — dropping one
 * label is strictly better than dropping every call in it. This mirrors the
 * existing convention for tool names, which adapters already filter.
 */
export function toCanonicalProviderId(raw: string | undefined | null): string {
  return raw && CanonicalProviderId.safeParse(raw).success ? raw : UNKNOWN_LABEL
}

/** Coerce a decoded model id to the canonical charset, falling back to `'unknown'`. */
export function toCanonicalModelId(raw: string | undefined | null): string {
  return raw && CanonicalModelId.safeParse(raw).success ? raw : UNKNOWN_LABEL
}

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
