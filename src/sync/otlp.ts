/**
 * codeburn sync — OTLP payload builder.
 *
 * Converts ParsedApiCall[] into an ExportTraceServiceRequest (OTLP/HTTP JSON).
 * Span and trace IDs are derived deterministically from deduplicationKey/sessionId.
 */

import { createHash } from 'crypto'
import { hostname, userInfo } from 'os'
import { posix, win32 } from 'path'
import { isTrustedAbsoluteWorkingDirectory } from '../path-privacy.js'
import type { ParsedApiCall } from '../types.js'
import type { SessionAttributionRecord } from '../yield.js'

export interface OtlpSpan {
  traceId: string
  spanId: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttribute[]
}

export interface OtlpAttribute {
  key: string
  value: OtlpValue
}

export type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpValue[] } }

export interface OtlpPayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] }
    scopeSpans: Array<{
      spans: OtlpSpan[]
    }>
  }>
}

// --- Device ID (pseudonymous, stable) ---

let cachedDeviceId: string | null = null

/** Pure derivation — exposed so the encoding can be golden-pinned in tests. */
export function deriveDeviceId(host: string, username: string): string {
  return createHash('sha256').update(`${host}:${username}`).digest('hex').slice(0, 16)
}

export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  cachedDeviceId = deriveDeviceId(hostname(), userInfo().username)
  return cachedDeviceId
}

// --- Span/Trace ID derivation (deterministic) ---

export function deriveSpanId(deduplicationKey: string): string {
  return createHash('sha256').update(deduplicationKey).digest('hex').slice(0, 16)
}

export function deriveTraceId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
}

// --- Timestamp conversion ---

function toUnixNano(isoTimestamp: string): string {
  const ms = new Date(isoTimestamp).getTime()
  if (isNaN(ms)) return '0'
  return (BigInt(ms) * 1_000_000n).toString()
}

// --- Payload construction ---

export interface CallWithSession {
  call: ParsedApiCall
  sessionId: string
  /** Local reconciliation label retained for compatibility; never serialized. */
  project?: string
  /** Exact provider-recorded cwd. Synthetic labels and storage paths are excluded upstream. */
  workingDirectory?: string
}

function isEmailOrCredentialShaped(value: string): boolean {
  if (/^[^@\s]{1,64}@(?![^@\s]*@)(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/.test(value)) return true
  if (/(?:^|[^A-Za-z0-9])(?:x[-_]?access[-_]?token|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|authorization|bearer|password|passwd|private[-_]?key|client[-_]?secret|secret)(?=[:=])/i.test(value)) return true
  if (/(?:^|[^A-Za-z0-9])(?:github_pat_|gh[pousr]_|glpat-|sk-[A-Za-z0-9]|[sr]k_(?:live|test)_|whsec_|xox[baprs]-|AIza|npm_|pypi-|hf_)/i.test(value)) return true
  if (/(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?:$|[^A-Z0-9])/i.test(value)) return true
  return false
}

/**
 * Convert a trusted absolute provider cwd into the only project label allowed
 * on usage spans. Imported Windows paths are handled on every host. Anything
 * ambiguous fails closed.
 */
export function projectBasenameFromWorkingDirectory(workingDirectory: string | undefined): string | undefined {
  if (!isTrustedAbsoluteWorkingDirectory(workingDirectory)) return undefined
  const flavour = posix.isAbsolute(workingDirectory)
    ? posix
    : win32.isAbsolute(workingDirectory)
      ? win32
      : null
  if (!flavour) return undefined

  const value = flavour.basename(workingDirectory)
  if (!value || value === '.' || value === '..' || value.length > 128) return undefined
  if (/[\\/\u0000-\u001f\u007f]/.test(value)) return undefined
  if (/%(?:2f|5c)/i.test(value)) return undefined
  if (isEmailOrCredentialShaped(value)) return undefined
  return value
}

const IDENTIFIER_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]*$/

function isPathUrlOrCredentialShaped(value: string): boolean {
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) return true
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return true
  if (/[=?&#\\]/.test(value) || /%(?:2f|5c)/i.test(value)) return true
  if (/(?:^|\/)(?:\.{1,2})(?:\/|$)/.test(value)) return true
  if (/^(?:users|home|private|tmp|var|etc|root|workspaces?|projects?)\//i.test(value)) return true
  if (/^(?:[A-Za-z]--)?(?:users|home|private|tmp|var|etc|root|workspaces?|projects?)[-_]/i.test(value)) return true
  return isEmailOrCredentialShaped(value)
}

function sanitizeIdentifier(value: string, maxBytes: number, fallback?: string): string | undefined {
  if (/\p{Cc}/u.test(value)) return fallback
  if (Buffer.byteLength(value, 'utf8') > maxBytes
    || !IDENTIFIER_SHAPE.test(value)
    || isPathUrlOrCredentialShaped(value)) {
    return fallback
  }
  return value
}

export function sanitizeProviderIdentifier(value: string): string {
  return sanitizeIdentifier(value, 64, 'unknown') ?? 'unknown'
}

export function sanitizeModelIdentifier(value: string): string {
  return sanitizeIdentifier(value, 160, 'unknown') ?? 'unknown'
}

export function sanitizeToolIdentifiers(values: readonly string[]): string[] {
  const result: string[] = []
  let totalBytes = 0
  for (const value of values) {
    if (result.length >= 64) break
    const safe = sanitizeIdentifier(value, 128)
    if (!safe) continue
    const bytes = Buffer.byteLength(safe, 'utf8')
    if (totalBytes + bytes > 4096) break
    result.push(safe)
    totalBytes += bytes
  }
  return result
}

function safeProjectAttribute(project: string | undefined): OtlpAttribute | null {
  if (!project || project.length > 128 || /[\\/\u0000-\u001f\u007f]/.test(project)
    || /%(?:2f|5c)/i.test(project) || isEmailOrCredentialShaped(project)) return null
  return { key: 'ai.project', value: { stringValue: project } }
}

export function buildOtlpPayload(calls: CallWithSession[]): OtlpPayload {
  const deviceId = getDeviceId()

  const spans: OtlpSpan[] = calls.map(({ call, sessionId, workingDirectory }) => {
    const startNano = toUnixNano(call.timestamp)
    // End time = start + 1ms (we don't have real duration, but OTLP requires both)
    const endNano = (BigInt(startNano) + 1_000_000n).toString()

    const provider = sanitizeProviderIdentifier(call.provider)
    const model = sanitizeModelIdentifier(call.model)
    const project = projectBasenameFromWorkingDirectory(workingDirectory)
    const tools = sanitizeToolIdentifiers(call.tools)
    const attributes: OtlpAttribute[] = [
      { key: 'ai.provider', value: { stringValue: provider } },
      { key: 'ai.model', value: { stringValue: model } },
      { key: 'ai.input_tokens', value: { intValue: String(call.usage.inputTokens) } },
      { key: 'ai.output_tokens', value: { intValue: String(call.usage.outputTokens) } },
      { key: 'ai.cost_usd', value: { doubleValue: call.costUSD } },
      { key: 'ai.speed', value: { stringValue: call.speed } },
    ]
    const projectAttribute = safeProjectAttribute(project)
    if (projectAttribute) attributes.push(projectAttribute)

    if (tools.length > 0) {
      attributes.push({
        key: 'ai.tools',
        value: { arrayValue: { values: tools.map(t => ({ stringValue: t })) } },
      })
    }

    // cost_estimated = true when provider reports char-based estimates
    const isEstimated = call.provider === 'kiro' || call.usage.inputTokens === 0
    attributes.push({ key: 'ai.cost_estimated', value: { boolValue: isEstimated } })

    return {
      traceId: deriveTraceId(sessionId),
      spanId: deriveSpanId(call.deduplicationKey),
      name: `${provider}/${model}`,
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      attributes,
    }
  })

  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'codeburn.device_id', value: { stringValue: deviceId } },
        ],
      },
      scopeSpans: [{
        spans,
      }],
    }],
  }
}

/** Split calls into batches of maxBatchSize. */
export function batchCalls(calls: CallWithSession[], maxBatchSize: number): CallWithSession[][] {
  const batches: CallWithSession[][] = []
  for (let i = 0; i < calls.length; i += maxBatchSize) {
    batches.push(calls.slice(i, i + maxBatchSize))
  }
  return batches
}

// --- Attribution spans (sync push --attribution) ---

export const SESSION_ATTRIBUTION_SPAN_NAME = 'codeburn.session.attribution'
export const COMMIT_ATTRIBUTION_SPAN_NAME = 'codeburn.commit'

/**
 * A single ledger-able attribution unit: either one session-level record
 * (repo + PR links + commit count) or one attributed commit. The dedup key
 * encodes the mutable state (inMain/wasReverted for commits; repo, PR links,
 * and commit set for sessions), so a state TRANSITION mints a new key and the
 * updated fact is re-sent on the next push — the receiver upserts by
 * (repo, sha) / traceId. Identical states dedupe via the sent-ledger.
 */
export type AttributionItem = {
  kind: 'session' | 'commit'
  dedupKey: string
  /** Span start: commit author time for commits, session start for sessions. ISO 8601. */
  timestamp: string
  /** Span end for session items (session lastTimestamp). Absent for commits. */
  endTimestamp?: string
  sessionId: string
  project?: string
  repo: string | null
  // session kind
  prLinks?: string[]
  commitCount?: number
  // commit kind
  sha?: string
  inMain?: boolean
  wasReverted?: boolean
}

function attributionProjectFromRepo(repo: string | null): string | undefined {
  if (!repo) return undefined
  const parts = repo.split('/').filter(Boolean)
  if (parts.length < 3) return undefined
  return projectBasenameFromWorkingDirectory(`/${parts.at(-1)}`)
}

function stateHash(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u001e')).digest('hex').slice(0, 16)
}

/** Deterministic dedup key for a commit attribution fact (state included). */
export function commitAttributionKey(sessionId: string, sha: string, inMain: boolean, wasReverted: boolean): string {
  return `attr:c:${sessionId}:${sha}:${inMain ? 1 : 0}${wasReverted ? 1 : 0}`
}

/** Deterministic dedup key for a session attribution fact (state included). */
export function sessionAttributionKey(record: SessionAttributionRecord): string {
  const commitStates = record.commits
    .map(c => `${c.sha}:${c.inMain ? 1 : 0}${c.wasReverted ? 1 : 0}`)
    .sort()
  // Project and both window timestamps are part of the state: an ongoing
  // session whose window grew (or whose project resolution changed) re-emits
  // with the corrected span times instead of freezing at first send.
  return `attr:s:${record.sessionId}:${stateHash([
    record.repo ?? '',
    record.project,
    record.firstTimestamp,
    record.lastTimestamp,
    ...record.prLinks,
    ...commitStates,
  ])}`
}

/** Ledger-key prefix for a session's attribution facts (any state). */
export function sessionAttributionKeyPrefix(sessionId: string): string {
  return `attr:s:${sessionId}:`
}

/** Flatten attribution records into ledger-able items (one session item + one per commit). */
export function flattenAttributionRecords(records: SessionAttributionRecord[]): AttributionItem[] {
  const items: AttributionItem[] = []
  for (const record of records) {
    const project = attributionProjectFromRepo(record.repo)
    items.push({
      kind: 'session',
      dedupKey: sessionAttributionKey(record),
      timestamp: record.firstTimestamp,
      endTimestamp: record.lastTimestamp,
      sessionId: record.sessionId,
      ...(project ? { project } : {}),
      repo: record.repo,
      prLinks: record.prLinks,
      commitCount: record.commits.length,
    })
    for (const commit of record.commits) {
      items.push({
        kind: 'commit',
        dedupKey: commitAttributionKey(record.sessionId, commit.sha, commit.inMain, commit.wasReverted),
        timestamp: commit.timestamp,
        sessionId: record.sessionId,
        ...(project ? { project } : {}),
        repo: record.repo,
        sha: commit.sha,
        inMain: commit.inMain,
        wasReverted: commit.wasReverted,
      })
    }
  }
  return items
}

/**
 * Build an OTLP payload from attribution items. Spans share the session's
 * traceId with the usage spans (`deriveTraceId(sessionId)`), so a receiver
 * can correlate cost and attribution without any extra key.
 */
export function buildAttributionOtlpPayload(items: AttributionItem[]): OtlpPayload {
  const deviceId = getDeviceId()

  const spans: OtlpSpan[] = items.map(item => {
    const startNano = toUnixNano(item.timestamp)
    // Clamp like the usage builder: end is never 0 (malformed timestamp) and
    // never earlier than start + 1ms (out-of-order session timestamps).
    const minEndNano = BigInt(startNano) + 1_000_000n
    const rawEndNano = item.endTimestamp ? BigInt(toUnixNano(item.endTimestamp)) : 0n
    const endNano = (rawEndNano > minEndNano ? rawEndNano : minEndNano).toString()

    const attributes: OtlpAttribute[] = []
    const projectAttribute = safeProjectAttribute(item.project)
    if (projectAttribute) attributes.push(projectAttribute)
    if (item.repo) {
      attributes.push({ key: 'git.repo', value: { stringValue: item.repo } })
    }

    if (item.kind === 'commit') {
      attributes.push(
        { key: 'git.sha', value: { stringValue: item.sha ?? '' } },
        { key: 'git.in_main', value: { boolValue: item.inMain ?? false } },
        { key: 'git.was_reverted', value: { boolValue: item.wasReverted ?? false } },
      )
    } else {
      attributes.push({ key: 'git.commit_count', value: { intValue: String(item.commitCount ?? 0) } })
      if (item.prLinks && item.prLinks.length > 0) {
        attributes.push({
          key: 'git.pr_links',
          value: { arrayValue: { values: item.prLinks.map(u => ({ stringValue: u })) } },
        })
      }
    }

    return {
      traceId: deriveTraceId(item.sessionId),
      spanId: deriveSpanId(item.dedupKey),
      name: item.kind === 'commit' ? COMMIT_ATTRIBUTION_SPAN_NAME : SESSION_ATTRIBUTION_SPAN_NAME,
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      attributes,
    }
  })

  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'codeburn.device_id', value: { stringValue: deviceId } },
          // Honesty marker: this attribution is inferred (timestamp-window
          // correlation), not declared. Receivers should label it as such.
          { key: 'codeburn.attribution_methodology', value: { stringValue: 'timestamp-window' } },
        ],
      },
      scopeSpans: [{
        spans,
      }],
    }],
  }
}

/** Split attribution items into batches of maxBatchSize. */
export function batchAttributionItems(items: AttributionItem[], maxBatchSize: number): AttributionItem[][] {
  const batches: AttributionItem[][] = []
  for (let i = 0; i < items.length; i += maxBatchSize) {
    batches.push(items.slice(i, i + maxBatchSize))
  }
  return batches
}
