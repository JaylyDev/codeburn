// Fixture-driven coverage for the Cursor quota adapter, ported from the
// menubar's CursorQuotaTests. Every test drives a synthetic JWT and a temp
// state database; none of them reads the operator's real Cursor session.
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  cursorAccessTokenFromDatabase,
  cursorDatabasePath,
  cursorSessionCookie,
  decodeCursorUsage,
  fetchCursorQuota,
} from '../src/quota/cursor.js'
import { isSqliteAvailable } from '../src/sqlite.js'

const requireForTest = createRequire(import.meta.url)
const neverFetch = (() => { throw new Error('the test must not reach the network') }) as unknown as typeof fetch
const NOW = Date.parse('2026-08-15T12:00:00Z')

function syntheticJWT(expiresAt = NOW + 3_600_000, subject = 'auth0|user_123'): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode({ sub: subject, exp: Math.floor(expiresAt / 1000) })}.signature`
}

const successBody = {
  billingCycleStart: '2026-08-01T00:00:00Z',
  billingCycleEnd: '2026-09-01T00:00:00Z',
  membershipType: 'pro',
  individualUsage: {
    plan: { enabled: true, used: 850, limit: 2000, remaining: 1150, autoPercentUsed: 20, apiPercentUsed: 65, totalPercentUsed: 42.5 },
  },
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codeburn-cursor-quota-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Cursor credential discovery', () => {
  it('follows the app layout of each platform', () => {
    expect(cursorDatabasePath('darwin', '/Users/dev'))
      .toBe(path.join('/Users/dev', 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
    expect(cursorDatabasePath('win32', 'C:\\Users\\dev'))
      .toBe(path.join('C:\\Users\\dev', 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
    expect(cursorDatabasePath('linux', '/home/dev'))
      .toBe(path.join('/home/dev', '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
  })

  it('reports no token when the app has never run here', async () => {
    expect(await cursorAccessTokenFromDatabase(path.join(root, 'state.vscdb'))).toBeNull()
  })

  it.runIf(isSqliteAvailable())('reads the token out of a real state database without writing to it', async () => {
    const databasePath = path.join(root, 'state.vscdb')
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (file: string) => any }
    const db = new DatabaseSync(databasePath)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', 'jwt-token-value')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/other', 'ignored')
    db.close()

    expect(await cursorAccessTokenFromDatabase(databasePath)).toBe('jwt-token-value')
  })
})

describe('Cursor session cookie', () => {
  it('carries the user id from the subject claim beside the token', () => {
    const token = syntheticJWT()
    expect(cursorSessionCookie(token, NOW)).toBe(`WorkosCursorSessionToken=user_123%3A%3A${token}`)
  })

  it('refuses an expired, imminently expiring, or malformed token', () => {
    expect(cursorSessionCookie(syntheticJWT(NOW - 60_000), NOW)).toBeNull()
    expect(cursorSessionCookie(syntheticJWT(NOW + 30_000), NOW)).toBeNull()
    expect(cursorSessionCookie(syntheticJWT(NOW + 3_600_000, 'auth0|user 123'), NOW)).toBeNull()
    expect(cursorSessionCookie('not-a-jwt', NOW)).toBeNull()
  })
})

describe('Cursor quota decoding', () => {
  it('maps the monthly window plus the auto and API pools', () => {
    const quota = decodeCursorUsage(successBody)
    expect(quota?.connection).toBe('connected')
    expect(quota?.planLabel).toBe('Pro')
    expect(quota?.primary).toEqual({ label: 'Monthly', percent: 0.425, resetsAt: '2026-09-01T00:00:00.000Z' })
    expect(quota?.details.map(row => row.label)).toEqual(['Monthly', 'Auto', 'API'])
    expect(quota?.details.map(row => row.percent)).toEqual([0.425, 0.2, 0.65])
    expect(quota?.footerLines).toEqual(['Source: Cursor app'])
  })

  it('falls back to the tighter of the two pools when no total is reported', () => {
    const quota = decodeCursorUsage({
      membershipType: 'ultra',
      individualUsage: { plan: { autoPercentUsed: 20, apiPercentUsed: 65 } },
    })
    expect(quota?.primary?.percent).toBe(0.65)
    expect(quota?.planLabel).toBe('Ultra')
  })

  it('adds the on-demand and team-pool windows when they carry a limit', () => {
    const quota = decodeCursorUsage({
      billingCycleEnd: '2026-09-01T00:00:00Z',
      individualUsage: { plan: { totalPercentUsed: 10 }, onDemand: { enabled: true, used: 5, limit: 20 } },
      teamUsage: { pooled: { used: 300, limit: 1000 } },
    })
    expect(quota?.details.map(row => row.label)).toEqual(['Monthly', 'On-demand', 'Team pool'])
    expect(quota?.details.map(row => row.percent)).toEqual([0.1, 0.25, 0.3])
  })

  it('reads an unlimited plan as an empty monthly window and rejects a payload with no usage at all', () => {
    expect(decodeCursorUsage({ isUnlimited: true })?.primary?.percent).toBe(0)
    expect(decodeCursorUsage({ membershipType: 'pro' })).toBeNull()
  })
})

describe('Cursor quota fetch', () => {
  it('sends the session cookie and no bearer', async () => {
    const token = syntheticJWT()
    const seen: { url: string; headers: Record<string, string> }[] = []
    const result = await fetchCursorQuota({
      loadAccessToken: async () => token,
      now: () => NOW,
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers as Record<string, string> })
        return jsonResponse(successBody)
      }) as unknown as typeof fetch,
    })

    expect(result.quota.connection).toBe('connected')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://cursor.com/api/usage-summary')
    expect(seen[0]!.headers['Authorization']).toBeUndefined()
    expect(seen[0]!.headers['Cookie']).toBe(`WorkosCursorSessionToken=user_123%3A%3A${token}`)
  })

  it('reports disconnected without a signed-in app and never fetches', async () => {
    const result = await fetchCursorQuota({ loadAccessToken: async () => null, fetch: neverFetch })
    expect(result.quota.connection).toBe('disconnected')
  })

  it('reports an expired session as terminal and never fetches', async () => {
    const result = await fetchCursorQuota({
      loadAccessToken: async () => syntheticJWT(NOW - 1000),
      now: () => NOW,
      fetch: neverFetch,
    })
    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.footerLines[0]).toContain('expired or invalid')
  })

  it('treats an unreadable local store as transient and never fetches', async () => {
    const result = await fetchCursorQuota({
      loadAccessToken: async () => { throw new Error('database is locked') },
      fetch: neverFetch,
    })
    expect(result.quota.connection).toBe('transientFailure')
    expect(result.quota.footerLines[0]).toContain("Could not read the Cursor app's local session data")
  })

  it('maps the HTTP failures the way the menubar classifies them', async () => {
    const respond = async (status: number, headers: Record<string, string> = {}) => fetchCursorQuota({
      loadAccessToken: async () => syntheticJWT(),
      now: () => NOW,
      fetch: (async () => jsonResponse({}, status, headers)) as unknown as typeof fetch,
    })

    expect((await respond(401)).quota.connection).toBe('terminalFailure')
    expect((await respond(403)).quota.footerLines[0]).toContain('rejected the current app session')
    const limited = await respond(429, { 'Retry-After': '120' })
    expect(limited.quota.connection).toBe('transientFailure')
    expect(limited.quota.rateLimited).toBe(true)
    expect(limited.retryAfterSeconds).toBe(120)
    expect((await respond(503)).quota.footerLines[0]).toBe('Cursor is temporarily unavailable.')
    expect((await respond(404)).quota.footerLines[0]).toBe('Cursor returned an unrecognized quota response.')
  })
})
