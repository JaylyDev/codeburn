// Live GLM Coding Plan quota via Z.ai's own usage endpoint (ported from the
// menubar's ZaiSubscriptionService.swift):
//
// - GET https://api.z.ai/api/monitor/usage/quota/limit
//     The API key goes in a bare Authorization header, not as a bearer.
//
// Credential, in the order the menubar tries them: a key the user supplied
// (there it is a Keychain entry, here the ZAI_API_KEY environment variable),
// then the Z.ai login the Pi CLI already holds in ~/.pi/agent/auth.json.
// Read-only; the key is used for one request and never persisted or logged.
import os from 'node:os'
import path from 'node:path'

import { quotaRequestSignal, readSecureFile, sanitizeError } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const USAGE_ENDPOINT = 'https://api.z.ai/api/monitor/usage/quota/limit'
const SOURCE_FOOTER = ['Source: Z.ai Coding Plan']
const REJECTED_FOOTER = ['Z.ai rejected this API key.']
const RATE_LIMITED_FOOTER = ['Z.ai rate-limited the quota request.']
const UNAVAILABLE_FOOTER = ['Z.ai is temporarily unavailable.']
const PARSE_FOOTER = ['Z.ai returned an unrecognized quota response.']

export type ZaiDeps = {
  fetch: typeof fetch
  /** The Pi CLI's own login store. */
  credentialPath: string
  readFile: typeof readSecureFile
  env: NodeJS.ProcessEnv
}

function defaultDeps(): ZaiDeps {
  return {
    fetch: globalThis.fetch,
    credentialPath: path.join(os.homedir(), '.pi', 'agent', 'auth.json'),
    readFile: readSecureFile,
    env: process.env,
  }
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'zai', connection, primary: null, details: [], planLabel: null, footerLines }
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Numbers have shipped as JSON numbers and as strings. */
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

async function apiKey(deps: ZaiDeps): Promise<string | null> {
  const supplied = nonEmpty(deps.env['ZAI_API_KEY'])
  if (supplied) return supplied
  try {
    const raw = await deps.readFile(deps.credentialPath, 64 * 1024)
    if (!raw) return null
    const auth = JSON.parse(raw) as Record<string, unknown>
    const entry = auth['zai']
    return entry && typeof entry === 'object' ? nonEmpty((entry as Record<string, unknown>)['key']) : null
  } catch {
    // A malformed or unreadable login file is the same as no login at all.
    return null
  }
}

/** Reset stamps arrive as ISO-8601, epoch seconds, or epoch milliseconds. */
function resetsAt(value: unknown): string | null {
  const epoch = num(value)
  if (epoch !== null) {
    const seconds = epoch < 1_000_000_000_000 ? epoch : epoch / 1000
    return new Date(seconds * 1000).toISOString()
  }
  const raw = nonEmpty(value)
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/** Z.ai encodes the window as a unit enum plus a count; only the two the plan
 *  actually meters (5-hour and weekly) have a label. */
function windowLabel(unit: number | null, count: number | null): string | null {
  if (unit === 3 && count === 5) return '5-hour'
  if (unit === 6 && count === 1) return 'Weekly'
  return null
}

/** "coding_pro" → "Coding Pro"; missing or blank → null. */
function planLabel(value: unknown): string | null {
  const raw = nonEmpty(value)
  if (!raw) return null
  return raw.replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\w/g, match => match.toUpperCase())
}

export type ZaiDecoded = QuotaProvider | 'rejected' | null

/** `'rejected'` when the body carries an auth error despite the HTTP status,
 *  `null` when it carries no usable window. */
export function decodeZaiUsage(body: unknown): ZaiDecoded {
  if (!body || typeof body !== 'object') return null
  const root = body as Record<string, any>
  const code = num(root.code)
  if (code === 401 || code === 403) return 'rejected'
  if (root.success === false) return null

  const payload = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, any>
  if (!Array.isArray(payload.limits)) return null

  let fiveHour: QuotaWindow | null = null
  let weekly: QuotaWindow | null = null
  for (const raw of payload.limits) {
    if (!raw || typeof raw !== 'object') continue
    const limit = raw as Record<string, unknown>
    if (limit.type !== 'CREDIT_LIMIT' && limit.type !== 'TOKENS_LIMIT') continue
    const label = windowLabel(num(limit.unit), num(limit.number))
    if (label === null) continue

    let usedPercent = num(limit.percentage)
    if (usedPercent === null) {
      const current = num(limit.currentValue)
      const total = num(limit.usage)
      if (current !== null && total !== null && total > 0) usedPercent = current / total * 100
    }
    if (usedPercent === null) continue

    const window: QuotaWindow = {
      label,
      percent: Math.min(1, Math.max(0, usedPercent / 100)),
      resetsAt: resetsAt(limit.nextResetTime),
    }
    if (label === 'Weekly') weekly = window
    else fiveHour = window
  }

  const details = [fiveHour, weekly].filter((row): row is QuotaWindow => row !== null)
  if (details.length === 0) return null
  return {
    provider: 'zai', connection: 'connected',
    primary: weekly ?? fiveHour,
    details,
    planLabel: planLabel(payload.level),
    footerLines: SOURCE_FOOTER,
  }
}

export type ZaiResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchZaiQuota(options: Partial<ZaiDeps> & { signal?: AbortSignal } = {}): Promise<ZaiResult> {
  const deps = { ...defaultDeps(), ...options }
  try {
    const key = await apiKey(deps)
    if (!key) return { quota: empty('disconnected') }

    const response = await deps.fetch(USAGE_ENDPOINT, {
      method: 'GET', signal: quotaRequestSignal(options.signal),
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-US,en',
        Authorization: key,
        'User-Agent': 'CodeBurn',
      },
    })
    if (response.status === 401 || response.status === 403) return { quota: empty('terminalFailure', REJECTED_FOOTER) }
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After')
      const seconds = raw === null ? NaN : Number(raw)
      return {
        quota: { ...empty('transientFailure', RATE_LIMITED_FOOTER), rateLimited: true },
        retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60),
      }
    }
    if (response.status >= 500) return { quota: empty('transientFailure', UNAVAILABLE_FOOTER) }
    if (!response.ok) return { quota: empty('transientFailure', PARSE_FOOTER) }
    // Never log the body - it carries account data.
    const decoded = decodeZaiUsage(await response.json())
    if (decoded === 'rejected') return { quota: empty('terminalFailure', REJECTED_FOOTER) }
    return { quota: decoded ?? empty('transientFailure', PARSE_FOOTER) }
  } catch (error) {
    console.warn(`Z.ai quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
