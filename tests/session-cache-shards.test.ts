// Provider x month shard layout (CACHE_VERSION 9): the on-disk cache is a
// directory holding one envelope plus one shard per provider-month. What matters
// here is that the move off the older layouts loses nothing, that a file's
// bucket never moves when the session is appended to, that a save rewrites only
// the months that changed (including when the load was scoped to a subset of
// them), and that one unreadable shard costs exactly one month.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  CACHE_VERSION,
  cacheBucketMonth,
  computeEnvFingerprint,
  cleanupOrphanedTempFiles,
  clearLoadCacheMemo,
  loadCache,
  markCacheDirty,
  monthScopeForRange,
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

function turnAt(timestamp: string, key = 'msg-1'): CachedFile['turns'][number] {
  const base = cachedFile().turns[0]!
  return { ...base, timestamp, calls: [{ ...base.calls[0]!, timestamp, deduplicationKey: key }] }
}

function fileSpanning(first: string, last?: string): CachedFile {
  return cachedFile({ turns: last ? [turnAt(first, 'a'), turnAt(last, 'b')] : [turnAt(first, 'a')] })
}

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

async function envelope(): Promise<{ providers: Record<string, { shards: Record<string, { name: string; until: string }> }> }> {
  return JSON.parse(await readFile(join(sessionCacheDir(), 'envelope.json'), 'utf-8'))
}

/** name -> bytes, for every shard on disk. */
async function shardBytes(): Promise<Map<string, string>> {
  const dir = sessionCacheDir()
  const out = new Map<string, string>()
  for (const name of await shardNames()) out.set(name, await readFile(join(dir, name), 'utf-8'))
  return out
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
    // claude's three entries split by month: two dated 2026-05, one turn-less.
    expect(Object.keys((await envelope()).providers['claude']!.shards).sort()).toEqual(['0000-00', '2026-05'])
    expect(Object.keys((await envelope()).providers['codex']!.shards)).toEqual(['2026-05'])

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
  it('drops only the unreadable month, keeping every other month and provider', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: 'claude-fp',
          files: { '/live/may.jsonl': fileSpanning('2026-05-15T10:00:00Z'), '/live/jun.jsonl': fileSpanning('2026-06-15T10:00:00Z') },
        },
        codex: { envFingerprint: 'codex-fp', files: { '/live/r.jsonl': fileSpanning('2026-05-15T10:00:00Z') } },
      },
    }
    markCacheDirty(cache, 'claude')
    markCacheDirty(cache, 'codex')
    await saveCache(cache)

    const dir = sessionCacheDir()
    await writeFile(join(dir, (await envelope()).providers['claude']!.shards['2026-05']!.name), '{"/x":{"turns":')

    clearLoadCacheMemo()
    const reloaded = await loadCache()
    expect(Object.keys(reloaded.providers['claude']!.files)).toEqual(['/live/jun.jsonl'])
    expect(reloaded.providers['codex']).toEqual(cache.providers['codex'])

    // Self-heals: the unreadable month is republished from whatever re-parses
    // into it rather than being carried forward corrupt forever.
    reloaded.providers['claude']!.files['/live/may.jsonl'] = fileSpanning('2026-05-15T10:00:00Z')
    markCacheDirty(reloaded, 'claude', '/live/may.jsonl')
    await saveCache(reloaded)
    clearLoadCacheMemo()
    expect(Object.keys((await loadCache()).providers['claude']!.files).sort()).toEqual(['/live/jun.jsonl', '/live/may.jsonl'])
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
    for (const meta of Object.values((await envelope()).providers)) {
      for (const ref of Object.values(meta.shards)) {
        expect(existsSync(join(dir, ref.name)), `envelope names a missing shard: ${ref.name}`).toBe(true)
      }
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

describe('month buckets', () => {
  it('keeps a file in its first-turn month when the session is appended to', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: { claude: { envFingerprint: 'fp', files: { '/live/long.jsonl': fileSpanning('2026-05-15T10:00:00Z') } } },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)
    expect(Object.keys((await envelope()).providers['claude']!.shards)).toEqual(['2026-05'])

    // Two months of appends later the bucket is unchanged; only `until` moves,
    // which is what lets a ranged load still find this session.
    const appended = fileSpanning('2026-05-15T10:00:00Z', '2026-07-02T10:00:00Z')
    expect(cacheBucketMonth(appended)).toBe('2026-05')
    cache.providers['claude']!.files['/live/long.jsonl'] = appended
    markCacheDirty(cache, 'claude', '/live/long.jsonl')
    await saveCache(cache)
    const shards = (await envelope()).providers['claude']!.shards
    expect(Object.keys(shards)).toEqual(['2026-05'])
    expect(shards['2026-05']!.until).toBe('2026-07')

    // ...and a July query still loads it, despite the May bucket key.
    clearLoadCacheMemo()
    const scoped = await loadCache(monthScopeForRange(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-31T23:59:59Z')))
    expect(scoped.providers['claude']!.files['/live/long.jsonl']).toBeDefined()
  })

  it('rewrites only the month that changed', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: 'fp',
          files: {
            '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'),
            '/live/apr.jsonl': fileSpanning('2026-04-10T10:00:00Z'),
            '/live/may.jsonl': fileSpanning('2026-05-10T10:00:00Z'),
          },
        },
      },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)
    const before = await shardBytes()
    const untouched = [
      (await envelope()).providers['claude']!.shards['2026-03']!.name,
      (await envelope()).providers['claude']!.shards['2026-04']!.name,
    ]

    cache.providers['claude']!.files['/live/may.jsonl'] = cachedFile({ turns: [turnAt('2026-05-10T10:00:00Z', 'a')], mcpInventory: ['changed'] })
    markCacheDirty(cache, 'claude', '/live/may.jsonl')
    await saveCache(cache)

    const after = await shardBytes()
    for (const name of untouched) expect(after.get(name)).toBe(before.get(name))
    expect(after.has((await envelope()).providers['claude']!.shards['2026-05']!.name)).toBe(true)
  })

  it('dirties the month a deleted file was in', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: 'fp',
          files: { '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'), '/live/mar2.jsonl': fileSpanning('2026-03-11T10:00:00Z') },
        },
      },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)

    delete cache.providers['claude']!.files['/live/mar2.jsonl']
    markCacheDirty(cache, 'claude', '/live/mar2.jsonl')
    await saveCache(cache)

    clearLoadCacheMemo()
    expect(Object.keys((await loadCache()).providers['claude']!.files)).toEqual(['/live/mar.jsonl'])
  })
})

describe('scoped load', () => {
  async function seedThreeMonths(): Promise<void> {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: computeEnvFingerprint('claude'),
          files: {
            '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'),
            '/live/apr.jsonl': fileSpanning('2026-04-10T10:00:00Z'),
            '/live/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z'),
          },
        },
      },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)
  }

  const juneScope = monthScopeForRange(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T23:59:59Z'))

  it('reads only the months the range can report on, plus one of slack', async () => {
    await seedThreeMonths()
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    // June is in range; May would be the slack month (absent here); March and
    // April cannot contribute a June turn and stay on disk.
    expect(Object.keys(scoped.providers['claude']!.files)).toEqual(['/live/jun.jsonl'])
  })

  it('save from a scoped load leaves the unloaded months byte-identical', async () => {
    await seedThreeMonths()
    const before = await shardBytes()
    const kept = [
      (await envelope()).providers['claude']!.shards['2026-03']!.name,
      (await envelope()).providers['claude']!.shards['2026-04']!.name,
    ]

    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    scoped.providers['claude']!.files['/live/jun2.jsonl'] = fileSpanning('2026-06-20T10:00:00Z')
    markCacheDirty(scoped, 'claude', '/live/jun2.jsonl')
    await saveCache(scoped)

    const after = await shardBytes()
    for (const name of kept) expect(after.get(name), `unloaded month rewritten: ${name}`).toBe(before.get(name))

    clearLoadCacheMemo()
    const full = await loadCache()
    expect(Object.keys(full.providers['claude']!.files).sort())
      .toEqual(['/live/apr.jsonl', '/live/jun.jsonl', '/live/jun2.jsonl', '/live/mar.jsonl'])
  })

  it('merges rather than replaces when a re-parse lands in an unloaded month', async () => {
    await seedThreeMonths()
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    // A March session that was never loaded is re-parsed (its mtime moved) and
    // written straight back into the March bucket.
    scoped.providers['claude']!.files['/live/mar.jsonl'] = cachedFile({ turns: [turnAt('2026-03-10T10:00:00Z', 'z')], mcpInventory: ['reparsed'] })
    markCacheDirty(scoped, 'claude', '/live/mar.jsonl')
    await saveCache(scoped)

    clearLoadCacheMemo()
    const full = await loadCache()
    expect(full.providers['claude']!.files['/live/mar.jsonl']!.mcpInventory).toEqual(['reparsed'])
    expect(Object.keys(full.providers['claude']!.files).sort())
      .toEqual(['/live/apr.jsonl', '/live/jun.jsonl', '/live/mar.jsonl'])
  })

  it('never scopes a provider whose fingerprint moved, or a durable one', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: { envFingerprint: 'stale-fp', files: { '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z') } },
        copilot: { envFingerprint: computeEnvFingerprint('copilot'), durable: true, files: { '/live/otel.db': fileSpanning('2026-03-10T10:00:00Z') } },
      },
    }
    markCacheDirty(cache, 'claude')
    markCacheDirty(cache, 'copilot')
    await saveCache(cache)

    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    // Both would be skipped on month alone; both are read in full anyway, so the
    // fingerprint reset and the durable orphan carry-forward see every entry.
    expect(scoped.providers['claude']!.files['/live/mar.jsonl']).toBeDefined()
    expect(scoped.providers['copilot']!.files['/live/otel.db']).toBeDefined()
  })
})

describe('v8 -> v9 migration', () => {
  it('re-buckets the v8 provider shards losslessly and retires the v8 directory', async () => {
    const v8Dir = join(TMP_DIR, 'session-cache.v8')
    await mkdir(v8Dir, { recursive: true })
    const section = {
      envFingerprint: 'claude-fp',
      files: {
        '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'),
        '/live/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z'),
        '/gone/pruned.jsonl': cachedFile({ prLinks: ['https://github.com/o/r/pull/1'] }),
      },
    }
    await writeFile(join(v8Dir, 'claude.abc.json'), JSON.stringify(section))
    await writeFile(join(v8Dir, 'envelope.json'), JSON.stringify({
      version: 8, complete: true, nonce: 'n', shards: { claude: 'claude.abc.json' },
    }))

    const loaded = await loadCache()
    expect(loaded.providers['claude']).toEqual(section)
    expect(loaded.complete).toBe(true)
    expect(existsSync(v8Dir)).toBe(false)
    expect(Object.keys((await envelope()).providers['claude']!.shards).sort()).toEqual(['2026-03', '2026-05', '2026-06'])

    clearLoadCacheMemo()
    expect(await loadCache()).toEqual(loaded)
  })
})
