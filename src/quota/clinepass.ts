// Live ClinePass quota from the public usage-limits contract (ported from the
// menubar's ClinePassSubscriptionService.swift):
//
// - GET https://api.cline.bot/api/v1/users/me/plan/usage-limits
//     Bearer API key, one 5-hour / weekly / monthly window each.
//
// Credential: ClinePass has no local login file to read; the key is one the
// user supplies. On the Mac that is a CodeBurn Keychain entry, and the CLI's
// equivalent is the environment: CLINEPASS_API_KEY, then CLINE_API_KEY. The
// key is used for one request and never persisted or logged.
import { quotaRequestSignal, sanitizeError } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const USAGE_ENDPOINT = 'https://api.cline.bot/api/v1/users/me/plan/usage-limits'
const API_KEY_VARS = ['CLINEPASS_API_KEY', 'CLINE_API_KEY'] as const
const REJECTED_FOOTER = ['ClinePass rejected this API key.']
const RATE_LIMITED_FOOTER = ['ClinePass rate-limited the quota request.']
const UNAVAILABLE_FOOTER = ['ClinePass is temporarily unavailable.']
const PARSE_FOOTER = ['ClinePass quota response was malformed.']

const WINDOW_LABELS: Record<string, string> = { five_hour: '5-hour', weekly: 'Weekly', monthly: 'Monthly' }

export type ClinePassDeps = {
  fetch: typeof fetch
  env: NodeJS.ProcessEnv
}

function defaultDeps(): ClinePassDeps {
  return { fetch: globalThis.fetch, env: process.env }
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'clinepass', connection, primary: null, details: [], planLabel: null, footerLines }
}

export function clinePassApiKey(env: NodeJS.ProcessEnv): string | null {
  for (const name of API_KEY_VARS) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * `null` on any malformed row. ClinePass publishes this contract, so unlike the
 * looser internal endpoints a field that is present but wrong is a broken
 * response rather than something to skip past; only an unknown window type is
 * ignored, so a new one does not break the reading.
 */
export function decodeClinePassUsage(body: unknown): QuotaProvider | null {
  if (!body || typeof body !== 'object') return null
  const root = body as Record<string, unknown>
  if (root['success'] !== true) return null
  const data = root['data']
  if (!data || typeof data !== 'object') return null
  const limits = (data as Record<string, unknown>)['limits']
  if (!Array.isArray(limits)) return null

  const windows = new Map<string, QuotaWindow>()
  for (const raw of limits) {
    if (!raw || typeof raw !== 'object') return null
    const limit = raw as Record<string, unknown>
    const type = limit['type']
    if (typeof type !== 'string') return null
    const label = WINDOW_LABELS[type]
    if (label === undefined) continue

    const percentUsed = num(limit['percentUsed'])
    if (percentUsed === null) return null
    let resetsAt: string | null = null
    if (limit['resetsAt'] !== undefined && limit['resetsAt'] !== null) {
      const parsed = typeof limit['resetsAt'] === 'string' ? Date.parse(limit['resetsAt']) : NaN
      if (!Number.isFinite(parsed)) return null
      resetsAt = new Date(parsed).toISOString()
    }
    windows.set(type, { label, percent: Math.min(1, Math.max(0, percentUsed / 100)), resetsAt })
  }

  const details = ['five_hour', 'weekly', 'monthly']
    .map(type => windows.get(type))
    .filter((row): row is QuotaWindow => row !== undefined)
  if (details.length === 0) return null
  return {
    provider: 'clinepass', connection: 'connected',
    primary: windows.get('weekly') ?? windows.get('five_hour') ?? windows.get('monthly')!,
    details,
    planLabel: null,
    footerLines: [],
  }
}

export type ClinePassResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchClinePassQuota(options: Partial<ClinePassDeps> & { signal?: AbortSignal } = {}): Promise<ClinePassResult> {
  const deps = { ...defaultDeps(), ...options }
  const key = clinePassApiKey(deps.env)
  if (!key) return { quota: empty('disconnected') }

  try {
    const response = await deps.fetch(USAGE_ENDPOINT, {
      method: 'GET', signal: quotaRequestSignal(options.signal),
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': 'CodeBurn' },
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
    const quota = decodeClinePassUsage(await response.json())
    return { quota: quota ?? empty('transientFailure', PARSE_FOOTER) }
  } catch (error) {
    console.warn(`ClinePass quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
