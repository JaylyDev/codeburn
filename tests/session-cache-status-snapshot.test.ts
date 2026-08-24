// The status-snapshot file (one `status-snapshot.<queryKeyHash>.json` per
// distinct query) is written by the same one-shot-CLI-process-per-poll model
// as the main session cache — a menubar poll and a manual refresh are two
// independent processes that can both be mid-write against the same cache
// dir at once. `session-cache-shards.test.ts` has a dedicated
// `describe('concurrent writers', ...)` block for the main cache's
// structurally identical tmp+rename atomic-write pattern; this file is the
// analogous coverage for the snapshot file (review finding D-G9), and
// exercises the locked publication fix for finding B-G1 directly: a slower,
// older-corpus write must not clobber a faster, newer one, and two distinct queryKeys
// must not evict each other.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, readdir, readFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

import { loadStatusSnapshot, saveStatusSnapshot } from '../src/session-cache.js'

let TMP_DIR: string
const SEMANTIC_KEY = 'test-render-v1'

beforeEach(async () => {
  TMP_DIR = join(tmpdir(), `codeburn-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  process.env['CODEBURN_CACHE_DIR'] = TMP_DIR
  await mkdir(TMP_DIR, { recursive: true })
})

afterEach(async () => {
  if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true })
})

async function readRawRecord(queryKey: string): Promise<Record<string, unknown> | null> {
  const hash = createHash('sha256').update(queryKey).digest('hex').slice(0, 16)
  try {
    const raw = await readFile(join(TMP_DIR, `status-snapshot.${hash}.json`), 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

describe('concurrent writers (status snapshot)', () => {
  it('serializes genuinely concurrent same-query saves so an older observation cannot win', async () => {
    let staleWins = 0

    for (let round = 0; round < 50; round++) {
      const queryKey = `same-query-${round}`
      await saveStatusSnapshot('baseline', 1_000, 1_000, queryKey, SEMANTIC_KEY, { p: 'baseline' })

      // Both writes start from the same baseline. On the broken read/guard then
      // rename protocol they both pass the guard, and the slower older write is
      // free to rename over the fresh result.
      await Promise.all([
        saveStatusSnapshot('fresh', 3_000, 3_000, queryKey, SEMANTIC_KEY, { p: 'fresh' }),
        saveStatusSnapshot('stale', 2_000, 2_000, queryKey, SEMANTIC_KEY, { p: 'stale' }),
      ])

      const record = await readRawRecord(queryKey)
      if (record?.['corpusFingerprint'] === 'stale') staleWins++
    }

    expect(staleWins).toBe(0)
  })

  it('never lets a slower recompute against an older corpus clobber a faster, newer one', async () => {
    const queryKey = 'q1'
    // Baseline: both processes started from this on-disk state.
    await saveStatusSnapshot('f1', 1_000, 1_000, queryKey, SEMANTIC_KEY, { p: 'baseline' })

    // Process A observed the corpus at m=2_000 and is slow to finish.
    // Process B observed it LATER, at m=3_000, and finishes first.
    await saveStatusSnapshot('f3', 3_000, 3_000, queryKey, SEMANTIC_KEY, { p: 'B-fresh' })
    // A's write lands after B's despite being based on an older observation.
    await saveStatusSnapshot('f2', 2_000, 2_000, queryKey, SEMANTIC_KEY, { p: 'A-stale' })

    const record = await readRawRecord(queryKey)
    expect(record).toMatchObject({ corpusFingerprint: 'f3', newestMtimeMs: 3_000, payload: { p: 'B-fresh' } })

    // Confirmed via the public read path too.
    const served = await loadStatusSnapshot('f3', queryKey, SEMANTIC_KEY)
    expect(served).toEqual({ p: 'B-fresh' })
  })

  it('does not let a delayed mismatch-bookkeeping write reintroduce a payload a real recompute already superseded', async () => {
    const queryKey = 'q1'
    await saveStatusSnapshot('f1', 1_000, 1_000, queryKey, SEMANTIC_KEY, { p: 'v1' })

    // A load observes the corpus moved to f2 (within the settle window) and
    // would normally persist a bookkeeping mismatchFirstSeenAt timestamp —
    // but a real recompute for f2 lands first.
    const stale = await loadStatusSnapshot('f2', queryKey, SEMANTIC_KEY)
    expect(stale).toEqual({ p: 'v1' }) // served from the settle window

    await saveStatusSnapshot('f2', 1_500, 2_000, queryKey, SEMANTIC_KEY, { p: 'v2-real' })

    const record = await readRawRecord(queryKey)
    // The real recompute's record must be exactly what's on disk — no
    // mismatchFirstSeenAt bookkeeping should have overwritten it with the
    // stale v1 payload.
    expect(record).toMatchObject({ corpusFingerprint: 'f2', payload: { p: 'v2-real' } })
    expect((record as { mismatchFirstSeenAt?: number }).mismatchFirstSeenAt).toBeUndefined()
  })

  it('recomputes instead of extending stale forever when mismatch bookkeeping cannot be persisted', async () => {
    const queryKey = 'read-only-cache'
    process.env['CODEBURN_STATUS_SNAPSHOT_SETTLE_MS'] = '20'
    await saveStatusSnapshot('before', 1_000, 1_000, queryKey, SEMANTIC_KEY, { p: 'stale' })

    await chmod(TMP_DIR, 0o500)
    try {
      expect(await loadStatusSnapshot('after', queryKey, SEMANTIC_KEY)).toBeNull()
      await new Promise(resolve => { setTimeout(resolve, 40) })
      // The first mismatch timestamp could not land. Treat that as a miss;
      // resetting the settle clock on every poll serves stale indefinitely.
      expect(await loadStatusSnapshot('after', queryKey, SEMANTIC_KEY)).toBeNull()
    } finally {
      await chmod(TMP_DIR, 0o700)
      delete process.env['CODEBURN_STATUS_SNAPSHOT_SETTLE_MS']
    }
  })

  it('publishes a later corpus observation even when deleting the newest file lowers max mtime', async () => {
    const queryKey = 'deletion-lowers-max-mtime'
    process.env['CODEBURN_STATUS_SNAPSHOT_SETTLE_MS'] = '0'
    try {
      await saveStatusSnapshot('before-delete', 3_000, 1_000, queryKey, SEMANTIC_KEY, { p: 'old' })
      expect(await loadStatusSnapshot('after-delete', queryKey, SEMANTIC_KEY)).toBeNull()

      // max(mtime) is not an ordering relation: deleting the former maximum
      // legitimately makes it go backwards even though this observation is
      // newer and must replace the old snapshot.
      await saveStatusSnapshot('after-delete', 2_000, 2_000, queryKey, SEMANTIC_KEY, { p: 'new' })
      expect(await loadStatusSnapshot('after-delete', queryKey, SEMANTIC_KEY)).toEqual({ p: 'new' })
    } finally {
      delete process.env['CODEBURN_STATUS_SNAPSHOT_SETTLE_MS']
    }
  })

  it('never publishes a torn write and always leaves a subsequent read intact, even racing two distinct queryKeys', async () => {
    for (let round = 0; round < 15; round++) {
      await Promise.allSettled([
        saveStatusSnapshot(`a${round}`, round, round, 'query-a', SEMANTIC_KEY, { round, who: 'a' }),
        saveStatusSnapshot(`b${round}`, round, round, 'query-b', SEMANTIC_KEY, { round, who: 'b' }),
      ])
      // Whichever landed, EACH queryKey's own file must be valid JSON and
      // present — a shared single-slot file would have one evict the other
      // every round; distinct per-queryKey files never touch each other.
      expect(await readRawRecord('query-a')).toBeTruthy()
      expect(await readRawRecord('query-b')).toBeTruthy()
      // A subsequent read must not throw on whatever landed.
      await loadStatusSnapshot(`a${round}`, 'query-a', SEMANTIC_KEY)
      await loadStatusSnapshot(`b${round}`, 'query-b', SEMANTIC_KEY)
    }
    // No stray .tmp files left mid-directory after the last round settles.
    const leftoverTemps = (await readdir(TMP_DIR)).filter(f => f.endsWith('.tmp'))
    expect(leftoverTemps).toEqual([])
  })

  it('rejects an exact-corpus snapshot written under different render semantics', async () => {
    const queryKey = 'semantic-fence'
    await saveStatusSnapshot('same-corpus', 1_000, 1_000, queryKey, 'render-v1', { p: 'old-shape' })

    expect(await loadStatusSnapshot('same-corpus', queryKey, 'render-v2')).toBeNull()
  })
})
