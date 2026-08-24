// The status-snapshot file (one `status-snapshot.<queryKeyHash>.json` per
// distinct query) is written by the same one-shot-CLI-process-per-poll model
// as the main session cache — a menubar poll and a manual refresh are two
// independent processes that can both be mid-write against the same cache
// dir at once. `session-cache-shards.test.ts` has a dedicated
// `describe('concurrent writers', ...)` block for the main cache's
// structurally identical tmp+rename atomic-write pattern; this file is the
// analogous coverage for the snapshot file (review finding D-G9), and
// exercises the CAS fix for finding B-G1 directly: a slower, older-corpus
// write must not clobber a faster, newer one, and two distinct queryKeys
// must not evict each other.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

import { loadStatusSnapshot, saveStatusSnapshot } from '../src/session-cache.js'

let TMP_DIR: string

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
  it('never lets a slower recompute against an older corpus clobber a faster, newer one', async () => {
    const queryKey = 'q1'
    // Baseline: both processes started from this on-disk state.
    await saveStatusSnapshot('f1', 1_000, queryKey, { p: 'baseline' })

    // Process A observed the corpus at m=2_000 and is slow to finish.
    // Process B observed it LATER, at m=3_000, and finishes first.
    await saveStatusSnapshot('f3', 3_000, queryKey, { p: 'B-fresh' })
    // A's write lands after B's despite being based on an older observation.
    await saveStatusSnapshot('f2', 2_000, queryKey, { p: 'A-stale' })

    const record = await readRawRecord(queryKey)
    expect(record).toMatchObject({ corpusFingerprint: 'f3', newestMtimeMs: 3_000, payload: { p: 'B-fresh' } })

    // Confirmed via the public read path too.
    const served = await loadStatusSnapshot('f3', 3_000, queryKey)
    expect(served).toEqual({ p: 'B-fresh' })
  })

  it('does not let a delayed mismatch-bookkeeping write reintroduce a payload a real recompute already superseded', async () => {
    const queryKey = 'q1'
    await saveStatusSnapshot('f1', 1_000, queryKey, { p: 'v1' })

    // A load observes the corpus moved to f2 (within the settle window) and
    // would normally persist a bookkeeping mismatchFirstSeenAt timestamp —
    // but a real recompute for f2 lands first.
    const stale = await loadStatusSnapshot('f2', 1_500, queryKey)
    expect(stale).toEqual({ p: 'v1' }) // served from the settle window

    await saveStatusSnapshot('f2', 1_500, queryKey, { p: 'v2-real' })

    const record = await readRawRecord(queryKey)
    // The real recompute's record must be exactly what's on disk — no
    // mismatchFirstSeenAt bookkeeping should have overwritten it with the
    // stale v1 payload.
    expect(record).toMatchObject({ corpusFingerprint: 'f2', payload: { p: 'v2-real' } })
    expect((record as { mismatchFirstSeenAt?: number }).mismatchFirstSeenAt).toBeUndefined()
  })

  it('never publishes a torn write and always leaves a subsequent read intact, even racing two distinct queryKeys', async () => {
    for (let round = 0; round < 15; round++) {
      await Promise.allSettled([
        saveStatusSnapshot(`a${round}`, round, 'query-a', { round, who: 'a' }),
        saveStatusSnapshot(`b${round}`, round, 'query-b', { round, who: 'b' }),
      ])
      // Whichever landed, EACH queryKey's own file must be valid JSON and
      // present — a shared single-slot file would have one evict the other
      // every round; distinct per-queryKey files never touch each other.
      expect(await readRawRecord('query-a')).toBeTruthy()
      expect(await readRawRecord('query-b')).toBeTruthy()
      // A subsequent read must not throw on whatever landed.
      await loadStatusSnapshot(`a${round}`, round, 'query-a')
      await loadStatusSnapshot(`b${round}`, round, 'query-b')
    }
    // No stray .tmp files left mid-directory after the last round settles.
    const leftoverTemps = (await readdir(TMP_DIR)).filter(f => f.endsWith('.tmp'))
    expect(leftoverTemps).toEqual([])
  })
})
