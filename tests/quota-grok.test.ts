// Fixture-driven coverage for the Grok Build quota adapter, ported from the
// menubar's GrokBuildSubscriptionServiceTests. Tokens are synthetic and the
// login file lives in a temp dir.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { decodeGrokBilling, decodeGrokCredential, fetchGrokQuota, grokAuthPath, grokPlanLabel, grokWindowLabel } from '../src/quota/grok.js'

const neverFetch = (() => { throw new Error('the test must not reach the network') }) as unknown as typeof fetch
const NOW = Date.parse('2026-09-01T10:00:00Z')

const authFile = {
  'https://accounts.x.ai/sign-in': { key: 'synthetic-legacy-token', expires_at: '2026-09-08T10:00:00Z' },
  'https://auth.x.ai::synthetic-principal': { key: 'synthetic-oidc-token', auth_mode: 'oidc', expires_at: '2026-09-09T10:00:00Z' },
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

/** Answers billing and settings the way the proxy does, recording every call. */
function proxy(seen: { url: string; headers: Record<string, string> }[], billing: unknown, status = 200, extra: Record<string, string> = {}) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> })
    if (url.startsWith('https://cli-chat-proxy.grok.com/v1/settings')) {
      return jsonResponse({ subscription_tier_display: 'SuperGrok Heavy' })
    }
    return jsonResponse(billing, status, extra)
  }) as unknown as typeof fetch
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codeburn-grok-quota-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Grok Build credential discovery', () => {
  it('follows GROK_HOME and falls back to ~/.grok', () => {
    expect(grokAuthPath({ GROK_HOME: '/tmp/grok' }, '/home/dev')).toBe(path.join('/tmp/grok', 'auth.json'))
    expect(grokAuthPath({ GROK_HOME: '~/custom-grok' }, '/home/dev')).toBe(path.join('/home/dev', 'custom-grok', 'auth.json'))
    expect(grokAuthPath({}, '/home/dev')).toBe(path.join('/home/dev', '.grok', 'auth.json'))
  })

  it('prefers the current OIDC login over the older sign-in one', () => {
    const credential = decodeGrokCredential(JSON.stringify(authFile))
    expect(credential).toEqual({
      accessToken: 'synthetic-oidc-token',
      authMode: 'oidc',
      expiresAt: Date.parse('2026-09-09T10:00:00Z'),
    })
  })

  it('separates a file with no token from one it cannot read', () => {
    expect(decodeGrokCredential('{"https://accounts.x.ai/sign-in":{"key":""}}')).toBeNull()
    expect(decodeGrokCredential('not json')).toBe('malformed')
    expect(decodeGrokCredential('[]')).toBe('malformed')
  })
})

describe('Grok Build window and plan labels', () => {
  it('names the credit window after how long it runs', () => {
    expect(grokWindowLabel(NOW + 5 * 86_400_000, NOW)).toBe('Weekly')
    expect(grokWindowLabel(NOW + 30 * 86_400_000, NOW)).toBe('Monthly')
    expect(grokWindowLabel(NOW + 2 * 86_400_000, NOW)).toBe('Credits')
    expect(grokWindowLabel(null, NOW)).toBe('Credits')
  })

  it('folds the plan spellings together and passes unknown tiers through', () => {
    expect(grokPlanLabel('supergrok_heavy')).toBe('SuperGrok Heavy')
    expect(grokPlanLabel('SuperGrok Heavy')).toBe('SuperGrok Heavy')
    expect(grokPlanLabel('supergrok')).toBe('SuperGrok')
    expect(grokPlanLabel('some_future_tier')).toBe('some_future_tier')
    expect(grokPlanLabel('  ')).toBeNull()
  })
})

describe('Grok Build billing decoding', () => {
  it('reads the credit usage percentage and the period end', () => {
    const billing = decodeGrokBilling({ config: { creditUsagePercent: 2, currentPeriod: { end: '2026-09-06T17:52:03Z' } } }, NOW)
    expect(billing?.window).toEqual({ label: 'Weekly', percent: 0.02, resetsAt: '2026-09-06T17:52:03.000Z' })
  })

  it('derives the percentage from the on-demand pool when no percentage is sent', () => {
    const billing = decodeGrokBilling({
      config: { onDemandUsed: { val: 30 }, onDemandCap: { val: 120 }, billingPeriodEnd: '2026-10-01T00:00:00Z', subscriptionTier: 'supergrok' },
    }, NOW)
    expect(billing?.window.percent).toBe(0.25)
    expect(billing?.window.label).toBe('Monthly')
    expect(billing?.tier).toBe('supergrok')
  })

  it('rejects a payload with no usable percentage', () => {
    expect(decodeGrokBilling({}, NOW)).toBeNull()
    expect(decodeGrokBilling({ config: {} }, NOW)).toBeNull()
    expect(decodeGrokBilling({ config: { onDemandCap: { val: 0 }, onDemandUsed: { val: 1 } } }, NOW)).toBeNull()
  })
})

describe('Grok Build quota fetch', () => {
  it('reuses one login for the quota and the plan name', async () => {
    const credentialPath = path.join(root, 'auth.json')
    // A real login file is private to the user; readSecureFile rejects group or world bits on POSIX.
    await writeFile(credentialPath, JSON.stringify(authFile), { encoding: 'utf8', mode: 0o600 })

    const seen: { url: string; headers: Record<string, string> }[] = []
    const result = await fetchGrokQuota({
      credentialPath,
      now: () => NOW,
      fetch: proxy(seen, { config: { creditUsagePercent: 2, currentPeriod: { end: '2026-09-06T17:52:03Z' } } }),
    })

    expect(result.quota.connection).toBe('connected')
    expect(result.quota.primary).toEqual({ label: 'Weekly', percent: 0.02, resetsAt: '2026-09-06T17:52:03.000Z' })
    expect(result.quota.planLabel).toBe('SuperGrok Heavy')
    expect(result.quota.footerLines).toEqual(['Source: Grok Build'])
    expect(seen.map(row => row.url)).toEqual([
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      'https://cli-chat-proxy.grok.com/v1/settings',
    ])
    expect(seen.every(row => row.headers['Authorization'] === 'Bearer synthetic-oidc-token'
      && row.headers['x-xai-token-auth'] === 'xai-grok-cli')).toBe(true)
  })

  it('reports disconnected without a login and never fetches', async () => {
    const result = await fetchGrokQuota({ credentialPath: path.join(root, 'missing.json'), fetch: neverFetch })
    expect(result.quota.connection).toBe('disconnected')
  })

  it('reports an expired login as terminal and never fetches', async () => {
    const credentialPath = path.join(root, 'auth.json')
    await writeFile(credentialPath, JSON.stringify({
      'https://auth.x.ai::p': { key: 'synthetic-oidc-token', expires_at: '2026-08-01T10:00:00Z' },
    }), { encoding: 'utf8', mode: 0o600 })

    const result = await fetchGrokQuota({ credentialPath, now: () => NOW, fetch: neverFetch })
    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.footerLines[0]).toContain('has expired')
  })

  it('reports an unreadable login file as terminal and never fetches', async () => {
    const credentialPath = path.join(root, 'auth.json')
    await writeFile(credentialPath, 'not json', { encoding: 'utf8', mode: 0o600 })

    const result = await fetchGrokQuota({ credentialPath, now: () => NOW, fetch: neverFetch })
    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.footerLines[0]).toContain("Could not read Grok Build's local login")
  })

  it('maps the HTTP failures the way the menubar classifies them', async () => {
    const credentialPath = path.join(root, 'auth.json')
    await writeFile(credentialPath, JSON.stringify(authFile), { encoding: 'utf8', mode: 0o600 })
    const respond = async (status: number, headers: Record<string, string> = {}) => fetchGrokQuota({
      credentialPath,
      now: () => NOW,
      fetch: proxy([], {}, status, headers),
    })

    expect((await respond(401)).quota.connection).toBe('terminalFailure')
    expect((await respond(403)).quota.footerLines[0]).toContain('rejected the current Grok Build login')
    const limited = await respond(429, { 'Retry-After': '75' })
    expect(limited.quota.rateLimited).toBe(true)
    expect(limited.retryAfterSeconds).toBe(75)
    expect((await respond(503)).quota.footerLines).toEqual(['Grok quota is temporarily unavailable.'])
    expect((await respond(404)).quota.footerLines).toEqual(['Grok returned an unrecognized quota response.'])
    expect((await respond(200)).quota.footerLines).toEqual(['Grok returned an unrecognized quota response.'])
  })

  it('keeps the reading when only the plan lookup fails', async () => {
    const credentialPath = path.join(root, 'auth.json')
    await writeFile(credentialPath, JSON.stringify(authFile), { encoding: 'utf8', mode: 0o600 })

    const result = await fetchGrokQuota({
      credentialPath,
      now: () => NOW,
      fetch: (async (url: string) => {
        if (url.startsWith('https://cli-chat-proxy.grok.com/v1/settings')) throw new Error('settings unavailable')
        return jsonResponse({ config: { creditUsagePercent: 40, subscriptionTier: 'supergrok' } })
      }) as unknown as typeof fetch,
    })

    expect(result.quota.connection).toBe('connected')
    expect(result.quota.primary?.percent).toBe(0.4)
    expect(result.quota.planLabel).toBe('SuperGrok')
  })
})
