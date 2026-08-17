// Per-provider shard layout (CACHE_VERSION 8): the on-disk cache is a directory
// holding one envelope plus one shard per provider. What matters here is that
// the move off the single v7 blob loses nothing, that a save rewrites only the
// providers that changed, and that one unreadable shard costs exactly one
// provider instead of the whole cache.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  CACHE_VERSION,
  cleanupOrphanedTempFiles,
  clearLoadCacheMemo,
  loadCache,
  markCacheDirty,
  saveCache,
  sessionCacheDir,
  type CachedFile,
  type SessionCache,
} from '../src/session-cache.js'

let TMP_DIR: string

beforeEach(async () => {
  TMP_DIR = join(tmpdir(), `codeburn-shard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  process.env['CODEBURN_CACHE_DIR'] = TMP_DIR
  await mkdir(TMP_DIR, { recursive: true })
  clearLoadCacheMemo()
})

afterEach(async () => {
  if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true })
})

function cachedFile(overrides: Partial<CachedFile> = {}): CachedFile {
  return {
    fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
    lastCompleteLineOffset: 128,
    mcpInventory: ['mcp__github__list'],
    turns: [{
      timestamp: '2026-05-15T10:00:00Z',
      sessionId: 'sess-1',
      userMessage: 'do the thing',
      calls: [{
        provider: 'claude',
        model: 'claude-sonnet-4-20250514',
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          cacheCreationOneHourTokens: 0,
        },
        costUSD: 0.01,
        speed: 'standard',
        timestamp: '2026-05-15T10:00:00Z',
        tools: ['Read'],
        bashCommands: [],
        skills: [],
        subagentTypes: [],
        deduplicationKey: 'msg-1',
      }],
    }],
    ...overrides,
  }
}

function v7Cache(): SessionCache {
  return {
    version: 7,
    complete: true,
    providers: {
      claude: {
        envFingerprint: 'claude-fp',
        files: {
          '/live/a.jsonl': cachedFile(),
          '/live/b.jsonl': cachedFile({ turns: [] }),
          // An orphaned PR-linked entry: its transcript is gone and can never
          // re-parse, so the migration has to carry it across verbatim.
          '/gone/pruned.jsonl': cachedFile({ prLinks: ['https://github.com/o/r/pull/1'] }),
        },
      },
      codex: {
        envFingerprint: 'codex-fp',
        durable: true,
        files: { '/live/rollout.jsonl': cachedFile() },
      },
    },
  }
}

async function shardNames(): Promise<string[]> {
  return (await readdir(sessionCacheDir())).sort()
}

describe('v7 -> shard migration', () => {
  it('is lossless: every entry survives, shards replace the v7 file, reload matches', async () => {
    const v7 = v7Cache()
    const v7Path = join(TMP_DIR, 'session-cache.v7.json')
    await writeFile(v7Path, JSON.stringify(v7))

    const loaded = await loadCache()
    // Same content, re-stamped at the current version.
    expect(loaded).toEqual({ ...v7, version: CACHE_VERSION })

    // Shards on disk, v7 blob removed.
    expect(existsSync(v7Path)).toBe(false)
    const names = await shardNames()
    expect(names).toContain('envelope.json')
    expect(names.filter(n => n.startsWith('claude.'))).toHaveLength(1)
    expect(names.filter(n => n.startsWith('codex.'))).toHaveLength(1)

    // A second load reads only the shards and produces the same cache.
    clearLoadCacheMemo()
    expect(await loadCache()).toEqual(loaded)
  })

  it('leaves a corrupt v7 file alone and starts fresh', async () => {
    await writeFile(join(TMP_DIR, 'session-cache.v7.json'), '{broken')
    const loaded = await loadCache()
    expect(loaded.providers).toEqual({})
    expect(existsSync(join(TMP_DIR, 'session-cache.v7.json'))).toBe(true)
  })
})

describe('per-provider dirty tracking', () => {
  it('rewrites only the provider that changed', async () => {
    await writeFile(join(TMP_DIR, 'session-cache.v7.json'), JSON.stringify(v7Cache()))
    const cache = await loadCache()

    const dir = sessionCacheDir()
    const before = new Map<string, string>()
    for (const name of await shardNames()) before.set(name, await readFile(join(dir, name), 'utf-8'))

    cache.providers['codex']!.files['/live/rollout.jsonl'] = cachedFile({ mcpInventory: ['changed'] })
    markCacheDirty(cache, 'codex')
    await saveCache(cache)

    const after = await shardNames()
    const claudeShard = [...before.keys()].find(n => n.startsWith('claude.'))!
    // The untouched provider keeps its exact file, byte for byte.
    expect(after).toContain(claudeShard)
    expect(await readFile(join(dir, claudeShard), 'utf-8')).toBe(before.get(claudeShard))
    // The changed provider is republished under a new name; the old one is gone.
    const codexBefore = [...before.keys()].find(n => n.startsWith('codex.'))!
    const codexAfter = after.find(n => n.startsWith('codex.'))!
    expect(codexAfter).not.toBe(codexBefore)
    expect(after).not.toContain(codexBefore)

    clearLoadCacheMemo()
    const reloaded = await loadCache()
    expect(reloaded.providers['codex']!.files['/live/rollout.jsonl']!.mcpInventory).toEqual(['changed'])
    expect(reloaded.providers['claude']).toEqual(cache.providers['claude'])
  })
})

describe('corrupt shard isolation', () => {
  it('drops only the unreadable provider, keeping the rest intact', async () => {
    await writeFile(join(TMP_DIR, 'session-cache.v7.json'), JSON.stringify(v7Cache()))
    const cache = await loadCache()

    const dir = sessionCacheDir()
    const claudeShard = (await shardNames()).find(n => n.startsWith('claude.'))!
    await writeFile(join(dir, claudeShard), '{"envFingerprint":"claude-fp","files":{"/x":{"turns":')

    clearLoadCacheMemo()
    const reloaded = await loadCache()
    expect(reloaded.providers['claude']).toBeUndefined()
    expect(reloaded.providers['codex']).toEqual(cache.providers['codex'])
  })
})

describe('cleanupOrphanedTempFiles', () => {
  it('sweeps stale shard temps and unreferenced shards, keeping the live ones', async () => {
    await saveCache({ version: CACHE_VERSION, complete: true, providers: {
      claude: { envFingerprint: 'fp', files: { '/a.jsonl': cachedFile() } },
    } })
    const dir = sessionCacheDir()
    const live = (await shardNames()).find(n => n.startsWith('claude.'))!

    const backdate = async (path: string, minutes: number) => {
      const at = new Date(Date.now() - minutes * 60 * 1000)
      await utimes(path, at, at)
    }

    const oldTemp = join(dir, 'claude.deadbeef.json.tmp')
    await writeFile(oldTemp, 'partial')
    await backdate(oldTemp, 10)
    const orphanShard = join(dir, 'codex.deadbeef.json')
    await writeFile(orphanShard, '{}')
    await backdate(orphanShard, 90)
    // Unreferenced but fresh: this is what a CONCURRENT save's shard looks like
    // before its envelope lands, so the sweep must leave it alone.
    const inFlightShard = join(dir, 'codex.c0ffee00.json')
    await writeFile(inFlightShard, '{}')
    const recentTemp = join(dir, 'claude.feedface.json.tmp')
    await writeFile(recentTemp, 'in flight')
    // The live shard is far older than the temp cutoff; being referenced is what
    // protects it, not its age.
    await backdate(join(dir, live), 120)

    await cleanupOrphanedTempFiles()

    expect(existsSync(oldTemp)).toBe(false)
    expect(existsSync(orphanShard)).toBe(false)
    expect(existsSync(inFlightShard)).toBe(true)
    expect(existsSync(recentTemp)).toBe(true)
    expect(existsSync(join(dir, live))).toBe(true)
    expect(existsSync(join(dir, 'envelope.json'))).toBe(true)
  })

  it('retires the pre-v8 single-file layout temps left in the parent directory', async () => {
    await saveCache({ version: CACHE_VERSION, complete: true, providers: {} })
    const legacyTemp = join(TMP_DIR, 'session-cache.v7.json.abc123.tmp')
    await writeFile(legacyTemp, 'orphan from an older build')
    const at = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(legacyTemp, at, at)
    const freshLegacyTemp = join(TMP_DIR, 'session-cache.v7.json.def456.tmp')
    await writeFile(freshLegacyTemp, 'an old binary mid-write')

    await cleanupOrphanedTempFiles()

    expect(existsSync(legacyTemp)).toBe(false)
    expect(existsSync(freshLegacyTemp)).toBe(true)
  })
})

// Two live processes share one cache directory routinely: a one-shot CLI beside
// the resident serve child, or two menubar polls. Neither may publish an
// envelope naming a file that is not there — that reads back as a corrupt
// provider and silently drops its history.
describe('concurrent writers', () => {
  function seed(provider: string, tag: string, files: number): SessionCache {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        [provider]: {
          envFingerprint: tag,
          files: Object.fromEntries(
            Array.from({ length: files }, (_, i) => [`/f/${provider}/${i}.jsonl`, cachedFile()]),
          ),
        },
      },
    }
    markCacheDirty(cache, provider)
    return cache
  }

  async function assertReferentialIntegrity(expected: string[]): Promise<void> {
    const dir = sessionCacheDir()
    const envelope = JSON.parse(await readFile(join(dir, 'envelope.json'), 'utf-8'))
    for (const name of Object.values(envelope.shards) as string[]) {
      expect(existsSync(join(dir, name)), `envelope names a missing shard: ${name}`).toBe(true)
    }
    clearLoadCacheMemo()
    const loaded = await loadCache()
    expect(Object.keys(loaded.providers).length).toBeGreaterThan(0)
    for (const provider of expected) expect(loaded.providers[provider]).toBeDefined()
  }

  it('never publishes a dangling envelope when two saves race', async () => {
    for (let round = 0; round < 15; round++) {
      await Promise.allSettled([
        saveCache(seed('claude', `a${round}`, 40)),
        saveCache(seed('codex', `b${round}`, 40)),
      ])
      // Whichever won, the published set has to be internally consistent and
      // hold at least the provider that got there last.
      await assertReferentialIntegrity([])
    }
  })

  it('a stale writer rewrites a shard another process retired instead of orphaning it', async () => {
    // Seed: claude holds an expired-source PR orphan no re-parse can recover.
    const initial: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: { envFingerprint: 'fp', files: { '/gone/pruned.jsonl': cachedFile({ prLinks: ['https://github.com/o/r/pull/1'] }) } },
        codex: { envFingerprint: 'fp', durable: true, files: { '/live/r.jsonl': cachedFile() } },
      },
    }
    markCacheDirty(initial, 'claude')
    markCacheDirty(initial, 'codex')
    await saveCache(initial)

    // Process B loads now, recording claude's current shard name.
    clearLoadCacheMemo()
    const b = await loadCache()

    // Process A independently touches ONLY claude and republishes, retiring the
    // shard file B is still holding a name for.
    clearLoadCacheMemo()
    const a = await loadCache()
    a.providers['claude']!.files['/live/new.jsonl'] = cachedFile()
    markCacheDirty(a, 'claude')
    await saveCache(a)

    // B now saves an unrelated codex change.
    b.providers['codex']!.files['/live/r2.jsonl'] = cachedFile()
    markCacheDirty(b, 'codex')
    await saveCache(b)

    await assertReferentialIntegrity(['claude', 'codex'])
    clearLoadCacheMemo()
    const final = await loadCache()
    expect(final.providers['claude']!.files['/gone/pruned.jsonl']).toBeDefined()
    expect(final.providers['codex']!.files['/live/r2.jsonl']).toBeDefined()
  })
})
