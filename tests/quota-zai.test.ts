// Fixture-driven coverage for the Z.ai quota adapter, ported from the
// menubar's ZaiQuotaTests. Keys are synthetic and the Pi login is a temp file.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { decodeZaiUsage, fetchZaiQuota } from '../src/quota/zai.js'

const neverFetch = (() => { throw new Error('the test must not reach the network') }) as unknown as typeof fetch
const SYNTHETIC_KEY = 'synthetic-zai-test-key'

const successBody = {
  code: 200,
  data: {
    level: 'pro',
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 360, percentage: 3, nextResetTime: 1_800_000_000_000 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 10800, percentage: 18, nextResetTime: 1_800_500_000_000 },
    ],
  },
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codeburn-zai-quota-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Z.ai quota decoding', () => {
  it('maps the credit windows with the plan level', () => {
    const quota = decodeZaiUsage(successBody)
    expect(quota).not.toBe('rejected')
    if (quota === null || quota === 'rejected') throw new Error('expected a decoded provider')
    expect(quota.connection).toBe('connected')
    expect(quota.planLabel).toBe('Pro')
    expect(quota.details.map(row => row.label)).toEqual(['5-hour', 'Weekly'])
    expect(quota.details.map(row => row.percent)).toEqual([0.03, 0.18])
    expect(quota.primary).toEqual({ label: 'Weekly', percent: 0.18, resetsAt: '2027-01-21T02:53:20.000Z' })
    expect(quota.footerLines).toEqual(['Source: Z.ai Coding Plan'])
  })

  it('still reads string-typed token windows and derives the percentage', () => {
    const quota = decodeZaiUsage({
      data: { limits: [{ type: 'TOKENS_LIMIT', unit: '3', number: '5', usage: '2000', currentValue: '500', nextResetTime: '1800000000' }] },
    })
    if (quota === null || quota === 'rejected') throw new Error('expected a decoded provider')
    expect(quota.details).toEqual([{ label: '5-hour', percent: 0.25, resetsAt: '2027-01-15T08:00:00.000Z' }])
  })

  it('reads an authentication code in the body as a rejection', () => {
    for (const code of [401, 403]) {
      expect(decodeZaiUsage({ code, msg: 'token expired or incorrect', success: false })).toBe('rejected')
    }
  })

  it('rejects a payload with no usable window', () => {
    expect(decodeZaiUsage({ code: 500, success: false })).toBeNull()
    expect(decodeZaiUsage({ data: {} })).toBeNull()
    expect(decodeZaiUsage({ data: { limits: [] } })).toBeNull()
    expect(decodeZaiUsage({ data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5 }] } })).toBeNull()
    expect(decodeZaiUsage({ data: { limits: [{ type: 'CREDIT_LIMIT', unit: 9, number: 2, percentage: 5 }] } })).toBeNull()
  })
})

describe('Z.ai credential discovery', () => {
  it('prefers a supplied key and sends it as a bare authorization header', async () => {
    const seen: Record<string, string>[] = []
    const result = await fetchZaiQuota({
      env: { ZAI_API_KEY: `  ${SYNTHETIC_KEY}  ` },
      credentialPath: path.join(root, 'missing.json'),
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
        seen.push(init.headers as Record<string, string>)
        return jsonResponse(successBody)
      }) as unknown as typeof fetch,
    })

    expect(result.quota.connection).toBe('connected')
    expect(seen[0]!['Authorization']).toBe(SYNTHETIC_KEY)
  })

  it('falls back to the Pi login on disk', async () => {
    const credentialPath = path.join(root, '.pi', 'agent', 'auth.json')
    await mkdir(path.dirname(credentialPath), { recursive: true })
    await writeFile(credentialPath, JSON.stringify({ zai: { key: 'pi-zai-key' } }), 'utf8')

    const seen: Record<string, string>[] = []
    const result = await fetchZaiQuota({
      env: {},
      credentialPath,
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>)
        return jsonResponse(successBody)
      }) as unknown as typeof fetch,
    })

    expect(result.quota.connection).toBe('connected')
    expect(seen[0]!['Authorization']).toBe('pi-zai-key')
  })

  it('reports disconnected with no key anywhere and never fetches', async () => {
    const result = await fetchZaiQuota({ env: {}, credentialPath: path.join(root, 'missing.json'), fetch: neverFetch })
    expect(result.quota.connection).toBe('disconnected')
  })
})

describe('Z.ai HTTP failures', () => {
  it('keeps the terminal and retryable classifications', async () => {
    const respond = async (status: number, headers: Record<string, string> = {}) => fetchZaiQuota({
      env: { ZAI_API_KEY: SYNTHETIC_KEY },
      fetch: (async () => jsonResponse({}, status, headers)) as unknown as typeof fetch,
    })

    expect((await respond(401)).quota.connection).toBe('terminalFailure')
    expect((await respond(403)).quota.footerLines).toEqual(['Z.ai rejected this API key.'])
    const limited = await respond(429, { 'Retry-After': '90' })
    expect(limited.quota.rateLimited).toBe(true)
    expect(limited.retryAfterSeconds).toBe(90)
    expect((await respond(503)).quota.footerLines).toEqual(['Z.ai is temporarily unavailable.'])
    expect((await respond(404)).quota.footerLines).toEqual(['Z.ai returned an unrecognized quota response.'])
  })

  it('turns a body-level authentication failure into a terminal state', async () => {
    const result = await fetchZaiQuota({
      env: { ZAI_API_KEY: SYNTHETIC_KEY },
      fetch: (async () => jsonResponse({ code: 401, success: false })) as unknown as typeof fetch,
    })
    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.footerLines).toEqual(['Z.ai rejected this API key.'])
  })
})
