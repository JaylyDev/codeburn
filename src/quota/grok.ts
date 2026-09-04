// Live Grok Build quota with the OAuth login the Grok CLI already owns
// (ported from the menubar's GrokBuildSubscriptionService.swift):
//
// - GET https://cli-chat-proxy.grok.com/v1/billing?format=credits -> usage
// - GET https://cli-chat-proxy.grok.com/v1/settings -> the plan display name,
//     optional: a failure there costs the label, not the reading.
//
// Credential: $GROK_HOME/auth.json (default ~/.grok/auth.json), read-only. The
// file maps a login scope to its token; the current OIDC login wins over the
// older sign-in one. CodeBurn never refreshes and never writes, so an expired
// login is terminal until the user runs `grok login` again.
import os from 'node:os'
import path from 'node:path'

import { quotaRequestSignal, readSecureFile, sanitizeError } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const BILLING_ENDPOINT = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const SETTINGS_ENDPOINT = 'https://cli-chat-proxy.grok.com/v1/settings'
const SOURCE_FOOTER = ['Source: Grok Build']
const EXPIRED_FOOTER = ['The Grok Build login has expired. Run `grok login`, then click Retry.']
const UNREADABLE_FOOTER = ["Could not read Grok Build's local login. Run `grok login` again, then click Retry."]
const REJECTED_FOOTER = ['Grok rejected the current Grok Build login. Run `grok login`, then click Retry.']
const RATE_LIMITED_FOOTER = ['Grok rate-limited the quota request.']
const UNAVAILABLE_FOOTER = ['Grok quota is temporarily unavailable.']
const PARSE_FOOTER = ['Grok returned an unrecognized quota response.']

export type GrokDeps = {
  fetch: typeof fetch
  credentialPath: string
  readFile: typeof readSecureFile
  now: () => number
}

export function grokAuthPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const configured = env['GROK_HOME']?.trim()
  const grokHome = configured
    ? (configured.startsWith('~') ? path.join(home, configured.slice(1)) : configured)
    : path.join(home, '.grok')
  return path.join(grokHome, 'auth.json')
}

function defaultDeps(): GrokDeps {
  return { fetch: globalThis.fetch, credentialPath: grokAuthPath(), readFile: readSecureFile, now: Date.now }
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'grok', connection, primary: null, details: [], planLabel: null, footerLines }
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseDate(value: unknown): number | null {
  const raw = nonEmpty(value)
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export type GrokCredential = { accessToken: string; authMode: string | null; expiresAt: number | null }

/** The current OIDC login first, then the older sign-in one, then anything
 *  else; equal ranks break by scope so the pick never depends on key order. */
function credentialRank(scope: string): number {
  if (scope.startsWith('https://auth.x.ai::')) return 0
  if (scope.includes('/sign-in')) return 1
  return 2
}

/** `'malformed'` separates a file we cannot understand (terminal, the user has
 *  to log in again) from a file with no token in it at all. */
export function decodeGrokCredential(raw: string): GrokCredential | 'malformed' | null {
  let entries: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'malformed'
    entries = parsed as Record<string, unknown>
  } catch {
    return 'malformed'
  }
  const usable = Object.entries(entries)
    .map(([scope, entry]) => ({
      scope,
      entry: (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>,
    }))
    .filter(row => nonEmpty(row.entry['key']) !== null)
    .sort((a, b) => credentialRank(a.scope) - credentialRank(b.scope) || (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0))
  const selected = usable[0]
  if (!selected) return null
  return {
    accessToken: nonEmpty(selected.entry['key'])!,
    authMode: nonEmpty(selected.entry['auth_mode']),
    expiresAt: parseDate(selected.entry['expires_at']),
  }
}

/** Grok bills one credit pool, so the window is named after how long it runs
 *  rather than by a label the API sends. */
export function grokWindowLabel(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return 'Credits'
  const days = Math.round((resetsAt - now) / 86_400_000)
  if (days >= 4 && days <= 12) return 'Weekly'
  if (days >= 20 && days <= 45) return 'Monthly'
  return 'Credits'
}

/** "supergrok_heavy" and "SuperGrok Heavy" are the same plan; anything the
 *  menubar does not know is passed through as sent. */
export function grokPlanLabel(value: unknown): string | null {
  const raw = nonEmpty(value)
  if (!raw) return null
  const letters = raw.toLowerCase().replace(/[^a-z]/g, '')
  if (letters === 'supergrokheavy' || letters === 'heavy') return 'SuperGrok Heavy'
  if (letters === 'supergrok') return 'SuperGrok'
  return raw
}

export type GrokBilling = { window: QuotaWindow; tier: string | null }

/** `null` when the payload carries no usable percentage. */
export function decodeGrokBilling(body: unknown, now: number): GrokBilling | null {
  const root = body && typeof body === 'object' ? body as Record<string, any> : {}
  const config = root.config
  if (!config || typeof config !== 'object') return null

  let percent = num(config.creditUsagePercent)
  if (percent === null) {
    const used = num(config.onDemandUsed?.val)
    const cap = num(config.onDemandCap?.val)
    if (used !== null && cap !== null && used >= 0 && cap > 0) percent = used / cap * 100
  }
  if (percent === null) return null

  const resetsAt = parseDate(config.currentPeriod?.end ?? config.billingPeriodEnd)
  return {
    window: {
      label: grokWindowLabel(resetsAt, now),
      percent: Math.min(1, Math.max(0, percent / 100)),
      resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
    },
    tier: nonEmpty(config.subscriptionTier) ?? nonEmpty(root.subscriptionTier),
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'x-xai-token-auth': 'xai-grok-cli',
    Accept: 'application/json',
    'User-Agent': 'CodeBurn',
  }
}

/** The plan name is a nicety: any failure leaves the reading intact. */
async function fetchPlan(token: string, deps: GrokDeps, parent?: AbortSignal): Promise<string | null> {
  try {
    const response = await deps.fetch(SETTINGS_ENDPOINT, {
      method: 'GET', signal: quotaRequestSignal(parent), headers: headers(token),
    })
    if (!response.ok) return null
    const body = await response.json() as Record<string, unknown>
    return nonEmpty(body['subscription_tier_display'])
  } catch {
    return null
  }
}

export type GrokResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchGrokQuota(options: Partial<GrokDeps> & { signal?: AbortSignal } = {}): Promise<GrokResult> {
  const deps = { ...defaultDeps(), ...options }
  try {
    const raw = await deps.readFile(deps.credentialPath, 128 * 1024)
    if (!raw) return { quota: empty('disconnected') }
    const credential = decodeGrokCredential(raw)
    if (credential === 'malformed') return { quota: empty('terminalFailure', UNREADABLE_FOOTER) }
    if (credential === null) return { quota: empty('disconnected') }

    const now = deps.now()
    if (credential.expiresAt !== null && credential.expiresAt <= now) {
      return { quota: empty('terminalFailure', EXPIRED_FOOTER) }
    }

    const response = await deps.fetch(BILLING_ENDPOINT, {
      method: 'GET', signal: quotaRequestSignal(options.signal), headers: headers(credential.accessToken),
    })
    if (response.status === 401 || response.status === 403) return { quota: empty('terminalFailure', REJECTED_FOOTER) }
    if (response.status === 429) {
      const header = response.headers.get('Retry-After')
      const seconds = header === null ? NaN : Number(header)
      return {
        quota: { ...empty('transientFailure', RATE_LIMITED_FOOTER), rateLimited: true },
        retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60),
      }
    }
    if (response.status >= 500) return { quota: empty('transientFailure', UNAVAILABLE_FOOTER) }
    if (!response.ok) return { quota: empty('transientFailure', PARSE_FOOTER) }

    // Never log the body - it carries account data.
    const billing = decodeGrokBilling(await response.json(), now)
    if (billing === null) return { quota: empty('transientFailure', PARSE_FOOTER) }

    const plan = await fetchPlan(credential.accessToken, deps, options.signal)
    return {
      quota: {
        provider: 'grok', connection: 'connected',
        primary: billing.window,
        details: [billing.window],
        planLabel: grokPlanLabel(plan) ?? grokPlanLabel(billing.tier),
        footerLines: SOURCE_FOOTER,
      },
    }
  } catch (error) {
    console.warn(`Grok quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
