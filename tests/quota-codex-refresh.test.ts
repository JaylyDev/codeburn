import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { collectQuota } from '../src/quota/index.js'
import { fetchCodexQuota } from '../src/quota/codex.js'
import { awaitCredentialWrites, pendingCredentialWrites } from '../src/quota/security.js'

const NOW = Date.parse('2026-09-02T12:00:00.000Z')
const OLD_REFRESH = 'refresh-token-that-the-grant-retires'
const NEW_REFRESH = 'refresh-token-the-grant-returns'

let root: string
let authPath: string

// The refresh token on disk is older than the eight-day staleness window, so
// every fetch here takes the proactive refresh path.
function authDoc(): Record<string, unknown> {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'access-old',
      refresh_token: OLD_REFRESH,
      id_token: 'id-old',
      account_id: 'account-1',
    },
    last_refresh: new Date(NOW - 30 * 86_400_000).toISOString(),
  }
}

async function writeAuth(doc: Record<string, unknown>, mode = 0o600): Promise<void> {
  // A real login file is private to the user; readSecureFile rejects group or world bits on POSIX.
  await writeFile(authPath, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode })
}

async function readAuth(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(authPath, 'utf8')) as Record<string, any>
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const rotatedGrant = () => json({ access_token: 'access-new', refresh_token: NEW_REFRESH, id_token: 'id-new' })
const usagePayload = () => json({
  plan_type: 'pro',
  rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } },
})

type Handler = () => Response | Promise<Response>

function routes(handlers: { token: Handler; usage: Handler }): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input)
    return url.includes('auth.openai.com') ? handlers.token() : handlers.usage()
  }) as unknown as typeof fetch
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'codeburn-codex-refresh-'))
  authPath = path.join(root, 'auth.json')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('Codex quota credential rotation', () => {
  it('writes the rotated refresh token to auth.json and leaves no temp file behind', async () => {
    await writeAuth(authDoc())

    const result = await fetchCodexQuota({
      authPath,
      now: () => NOW,
      fetch: routes({ token: rotatedGrant, usage: usagePayload }),
    })

    expect(result.quota.connection).toBe('connected')
    const saved = await readAuth()
    expect(saved.tokens.refresh_token).toBe(NEW_REFRESH)
    expect(saved.tokens.access_token).toBe('access-new')
    expect(saved.tokens.id_token).toBe('id-new')
    expect(saved.tokens.account_id).toBe('account-1')
    expect(saved.auth_mode).toBe('chatgpt')
    expect(saved.last_refresh).toBe(new Date(NOW).toISOString())
    expect(await readdir(root)).toEqual(['auth.json'])
  })

  it('keeps the rotated refresh token when the quota request fails after the refresh', async () => {
    await writeAuth(authDoc())

    const result = await fetchCodexQuota({
      authPath,
      now: () => NOW,
      fetch: routes({ token: rotatedGrant, usage: () => json({ error: 'boom' }, 500) }),
    })

    expect(result.quota.connection).toBe('transientFailure')
    expect((await readAuth()).tokens.refresh_token).toBe(NEW_REFRESH)
  })

  // Two ways `codeburn quota` could throw a rotation away: the per-provider
  // abort cancelling the grant, and the command's process.exit landing between
  // the grant and the file. Neither may lose it.
  it('completes a rotation the caller has already aborted', async () => {
    await writeAuth(authDoc())
    const controller = new AbortController()
    let grantStarted = (): void => {}
    const reachedGrant = new Promise<void>(resolve => { grantStarted = resolve })
    let releaseGrant = (): void => {}
    const heldGrant = new Promise<void>(resolve => { releaseGrant = resolve })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const pending = fetchCodexQuota({
      authPath,
      now: () => NOW,
      signal: controller.signal,
      fetch: routes({
        token: async () => {
          grantStarted()
          await heldGrant
          return rotatedGrant()
        },
        // The quota read itself honours the abort; only the grant is exempt.
        usage: () => { throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }) },
      }),
    })

    await reachedGrant
    controller.abort()
    releaseGrant()
    const result = await pending

    expect(result.quota.connection).toBe('transientFailure')
    expect((await readAuth()).tokens.refresh_token).toBe(NEW_REFRESH)
  })

  it('holds the exit drain open until an abandoned rotation reaches disk', async () => {
    await writeAuth(authDoc())
    let grantStarted = (): void => {}
    const reachedGrant = new Promise<void>(resolve => { grantStarted = resolve })
    let releaseGrant = (): void => {}
    const heldGrant = new Promise<void>(resolve => { releaseGrant = resolve })

    // What the `quota` command does: race the provider, print, then exit.
    const report = await collectQuota({
      timeoutMs: 5,
      readers: [{
        id: 'codex',
        name: 'Codex',
        read: async signal => (await fetchCodexQuota({
          signal,
          authPath,
          now: () => NOW,
          fetch: routes({
            token: async () => {
              grantStarted()
              await heldGrant
              return rotatedGrant()
            },
            usage: usagePayload,
          }),
        })).quota,
      }],
    })

    expect(report.providers[0]).toMatchObject({ id: 'codex', error: 'Timed out.' })
    await reachedGrant
    expect(pendingCredentialWrites()).toBe(1)
    // The token on disk is the one the grant is in the middle of retiring, so
    // an exit taken here is what signs the user out.
    expect((await readAuth()).tokens.refresh_token).toBe(OLD_REFRESH)

    let drained = false
    const drain = awaitCredentialWrites().then(() => { drained = true })
    await new Promise(resolve => { setImmediate(resolve) })
    expect(drained).toBe(false)

    releaseGrant()
    await drain

    expect((await readAuth()).tokens.refresh_token).toBe(NEW_REFRESH)
    expect(pendingCredentialWrites()).toBe(0)
  })

  it('drains instantly when no rotation is outstanding', async () => {
    expect(pendingCredentialWrites()).toBe(0)
    await awaitCredentialWrites(0)
  })

  it('stops waiting on a grant that never answers', async () => {
    await writeAuth(authDoc())
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let releaseGrant = (): void => {}
    const heldGrant = new Promise<void>(resolve => { releaseGrant = resolve })

    const pending = fetchCodexQuota({
      authPath,
      now: () => NOW,
      fetch: routes({
        token: async () => { await heldGrant; return rotatedGrant() },
        usage: usagePayload,
      }),
    })
    // Bounded, so a wedged endpoint cannot keep the command from ever exiting.
    await awaitCredentialWrites(10)

    releaseGrant()
    await pending
  })

  it('has the rotated refresh token on disk before it makes another request', async () => {
    await writeAuth(authDoc())

    // The `quota` command races each provider against a timeout and exits as
    // soon as it has printed, so anything still awaited after the grant can be
    // killed. Reading the file from inside the next request proves the write
    // already completed rather than being left pending.
    let onDiskAtUsage: string | null = null
    const result = await fetchCodexQuota({
      authPath,
      now: () => NOW,
      fetch: routes({
        token: rotatedGrant,
        usage: () => {
          onDiskAtUsage = readFileSync(authPath, 'utf8')
          throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
        },
      }),
    })

    expect(result.quota.connection).toBe('transientFailure')
    expect(onDiskAtUsage).not.toBeNull()
    expect(JSON.parse(onDiskAtUsage!).tokens.refresh_token).toBe(NEW_REFRESH)
    expect((await readAuth()).tokens.refresh_token).toBe(NEW_REFRESH)
  })

  it('persists a rotated refresh token even when the grant returns no access token', async () => {
    await writeAuth(authDoc())

    await fetchCodexQuota({
      authPath,
      now: () => NOW,
      fetch: routes({ token: () => json({ refresh_token: NEW_REFRESH }), usage: usagePayload }),
    })

    const saved = await readAuth()
    expect(saved.tokens.refresh_token).toBe(NEW_REFRESH)
    expect(saved.tokens.access_token).toBe('access-old')
  })

  it('falls back to the credential it holds when the merge re-read fails', async () => {
    await writeAuth(authDoc())

    await fetchCodexQuota({
      authPath,
      now: () => NOW,
      readFileSync: () => { throw new Error('EBUSY: resource busy or locked') },
      fetch: routes({ token: rotatedGrant, usage: usagePayload }),
    })

    expect((await readAuth()).tokens.refresh_token).toBe(NEW_REFRESH)
  })

  it('reports a credential write it could not complete instead of failing silently', async () => {
    await writeAuth(authDoc())
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await fetchCodexQuota({
      authPath,
      now: () => NOW,
      writeFileSync: () => { throw new Error('EROFS: read-only file system') },
      fetch: routes({ token: rotatedGrant, usage: usagePayload }),
    })

    expect(errors).toHaveBeenCalledTimes(1)
    const message = String(errors.mock.calls[0]?.[0])
    expect(message).toContain(authPath)
    expect(message).toContain('codex login')
    expect(message).not.toContain(NEW_REFRESH)
  })

  it('discards the rotation rather than resurrecting a login that was removed', async () => {
    await writeAuth(authDoc())
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await fetchCodexQuota({
      authPath,
      now: () => NOW,
      // The Codex CLI signed the user out between our read and the grant.
      readFileSync: () => null,
      fetch: routes({ token: rotatedGrant, usage: usagePayload }),
    })

    expect((await readAuth()).tokens.refresh_token).toBe(OLD_REFRESH)
    expect(errors).toHaveBeenCalledTimes(1)
  })

  // POSIX mode bits do not exist on Windows, where the ACL carries the privacy.
  it.skipIf(process.platform === 'win32')('rewrites the credential with the permissions it already had', async () => {
    for (const mode of [0o600, 0o400]) {
      await rm(authPath, { force: true })
      await writeAuth(authDoc(), mode)
      const before = (await stat(authPath)).mode & 0o777

      await fetchCodexQuota({
        authPath,
        now: () => NOW,
        fetch: routes({ token: rotatedGrant, usage: usagePayload }),
      })

      expect((await readAuth()).tokens.refresh_token).toBe(NEW_REFRESH)
      expect((await stat(authPath)).mode & 0o777).toBe(before)
      expect(before & 0o077).toBe(0)
    }
  })
})
