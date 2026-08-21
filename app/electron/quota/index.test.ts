import { describe, expect, it, vi } from 'vitest'

import { QuotaService } from './index'
import type { QuotaProvider } from './types'

const quota = (provider: 'claude' | 'codex'): QuotaProvider => ({
  provider, connection: 'connected', primary: null, details: [], planLabel: null, footerLines: [],
})

describe('QuotaService', () => {
  // The snap declares no Codex credential path, because the live gauge would
  // need write access to the Codex CLI's own auth.json to rotate the token.
  // Under $SNAP the Codex fetch must not run at all; Claude is unaffected.
  it('skips the Codex live gauge under snap confinement', async () => {
    const previous = process.env['SNAP']
    process.env['SNAP'] = '/snap/codeburn/current'
    try {
      const claude = vi.fn(async () => ({ quota: quota('claude') }))
      const codex = vi.fn(async () => ({ quota: quota('codex') }))
      const service = new QuotaService({
        claude, codex, now: () => Date.parse('2026-08-14T00:00:00Z'),
        readFile: vi.fn(async () => null),
        writeFile: vi.fn(async () => {}),
        statePath: '/mock/backoff.json',
      })
      const [claudeQuota, codexQuota] = await service.getQuota({ force: true })
      expect(codex).not.toHaveBeenCalled()
      expect(claude).toHaveBeenCalledTimes(1)
      expect(codexQuota?.connection).toBe('disconnected')
      expect(claudeQuota?.connection).toBe('connected')
    } finally {
      if (previous === undefined) delete process.env['SNAP']
      else process.env['SNAP'] = previous
    }
  })

  it('persists provider 429 blocked-until and gates the next forced fetch', async () => {
    const writes: string[] = []
    const claude = vi.fn(async () => ({ quota: quota('claude'), retryAfterSeconds: 60 }))
    const codex = vi.fn(async () => ({ quota: quota('codex') }))
    const service = new QuotaService({
      claude, codex, now: () => Date.parse('2026-07-12T00:00:00Z'),
      readFile: vi.fn(async () => writes.at(-1) ?? null),
      writeFile: vi.fn(async (_path, value) => { writes.push(value) }),
      statePath: '/mock/backoff.json',
    })
    await service.getQuota({ force: true })
    const saved = JSON.parse(writes[0]!)
    expect(saved.claude).toBe('2026-07-12T00:01:00.000Z')
    await service.getQuota({ force: true })
    expect(claude).toHaveBeenCalledTimes(1)
    expect(codex).toHaveBeenCalledTimes(2)
  })

  it('force re-fetches within the cache window by invalidating first', async () => {
    const claude = vi.fn(async () => ({ quota: quota('claude') }))
    const codex = vi.fn(async () => ({ quota: quota('codex') }))
    const service = new QuotaService({
      claude, codex, now: () => 1000, refreshMs: 120_000,
      readFile: vi.fn(async () => null), writeFile: vi.fn(async () => undefined),
    })
    await service.getQuota()
    await service.getQuota() // fresh cache, no re-fetch
    expect(claude).toHaveBeenCalledTimes(1)
    await service.getQuota({ force: true }) // force clears the still-fresh cache
    expect(claude).toHaveBeenCalledTimes(2)
  })

  it('single-flights simultaneous callers', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const claude = vi.fn(async () => { await pending; return { quota: quota('claude') } })
    const service = new QuotaService({
      claude, codex: vi.fn(async () => ({ quota: quota('codex') })),
      readFile: vi.fn(async () => null), writeFile: vi.fn(async () => undefined),
    })
    const first = service.getQuota({ force: true })
    const second = service.getQuota({ force: true })
    release()
    expect(await first).toEqual(await second)
    expect(claude).toHaveBeenCalledTimes(1)
  })
})

