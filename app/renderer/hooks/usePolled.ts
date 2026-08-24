import { useCallback, useContext, useEffect, useRef, useState } from 'react'

import { normalizeCliError } from '../lib/ipc'
import { RefreshCadenceContext } from '../lib/refreshCadence'
import type { CliError } from '../lib/types'

export type Polled<T> = {
  data: T | null
  error: CliError | null
  loading: boolean
  /** True while a fresh fetch runs behind instantly-served memoized data (a
   *  provider/period switch). Sections use it for a subtle in-flight indicator. */
  switching: boolean
  /** Wall-clock timestamp for the most recent successful fetch. */
  lastSuccessAt: number | null
  /** Re-run the fetcher immediately (period/provider change, manual refresh). */
  refresh: () => void
}

// Module-level store of the LAST successful result per memoKey, kept for the
// whole app session — one payload per key, replaced on each success, never
// evicted. A section that switches deps to a previously-seen key (a period or
// provider switch, or a switch-back) paints the cached result in the same frame:
// no blank, no skeleton, no stale-freeze. Keys are bounded by
// (section × period × provider × range), so the map cannot grow without limit.
//
// Entries carry the wall-clock of the fetch that produced them. When the memoKey
// CHANGES (a period/provider/scope switch) a cached entry younger than
// POLLED_FRESH_MS is served as-is with no CLI spawn at all; an older one is
// served instantly and revalidated behind the painted data
// (stale-while-revalidate). Any reload on the SAME key — interval poll,
// visibility catch-up, refresh() — always fetches, so the poll cadence and the
// manual refresh are unaffected.
const POLLED_FRESH_MS = 30_000
type MemoEntry = { value: unknown; at: number }
const memoStore = new Map<string, MemoEntry>()

function memoGet<T>(key: string): { value: T; at: number } | undefined {
  return memoStore.get(key) as { value: T; at: number } | undefined
}

function memoSet(key: string, value: unknown): void {
  memoStore.set(key, { value, at: Date.now() })
}

/** Test-only: clear the module-level memo between renders so cached results from
 *  one test never bleed into the next. */
export function __resetPolledMemo(): void {
  memoStore.clear()
}

/** Empty the instant-switch memo. Called when a Settings action mutates config
 *  that changes computed costs or currency (currency/alias/plan/price-override):
 *  a later provider/period switch must never paint a payload cached under the OLD
 *  config, which is what stuck the display on the previous currency. */
export function clearPolledMemo(): void {
  memoStore.clear()
}

/** Seed the instant-switch memo out of band. The prefetcher (App.tsx) warms the
 *  overview result for every detected provider so a picker switch to one paints
 *  from memory in the same frame instead of waiting on a fresh CLI spawn. Keyed
 *  identically to the corresponding usePolled `memoKey`. */
export function primePolledMemo(key: string, value: unknown): void {
  memoSet(key, value)
}

/** Whether a live result is already memoized for `key` (does not affect recency).
 *  Lets the prefetcher skip providers it has already warmed. */
export function hasPolledMemo(key: string): boolean {
  return memoStore.has(key)
}

/**
 * Generic CLI-backed data hook: fetches on mount + whenever `deps` change, then
 * re-polls every `intervalMs`. Errors are normalized to the CliError shape so
 * sections can branch on `error.kind`. Last-good data is retained on error.
 *
 * `intervalMs` defaults to the app-wide refresh cadence (Settings > General) via
 * context; pass one explicitly to override. `null` cadence (Manual) means no
 * setInterval — the fetcher runs only on mount, deps change, and refresh().
 *
 * `enabled` (default true) gates fetching: while false the hook stays in its
 * initial loading state and issues no CLI spawn. The app boot flow sets it false
 * on every section poll until the first overview resolves, so the one-time cold
 * cache hydration happens ONCE (via overview) instead of fanning out into a
 * parallel full-history parse per section.
 *
 * `memoKey` opts into the instant-switch memo above.
 */
export function usePolled<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  opts: { intervalMs?: number | null; enabled?: boolean; memoKey?: string } = {},
): Polled<T> {
  const cadence = useContext(RefreshCadenceContext)
  const intervalMs = opts.intervalMs !== undefined ? opts.intervalMs : cadence.intervalMs
  const enabled = opts.enabled ?? true
  const memoKey = opts.memoKey
  const [data, setData] = useState<T | null>(() => (memoKey ? memoGet<T>(memoKey)?.value ?? null : null))
  const [error, setError] = useState<CliError | null>(null)
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  // Generation counter: every load() (mount, deps change, interval, refresh)
  // claims the next epoch; a fetch applies its result only while its epoch is
  // still current. This is what keeps a slow fetch from an older deps/period
  // from clobbering a newer one that already resolved.
  const epochRef = useRef(0)
  // Wall-clock of the last successful fetch, mirrored out of state so the
  // visibilitychange catch-up can read it without re-subscribing on every poll.
  const lastSuccessRef = useRef<number | null>(null)
  // memoKey of the previous load, so a switch can be told from a same-key reload.
  const lastKeyRef = useRef<string | undefined>(undefined)

  const load = useCallback(() => {
    if (!enabled) return
    const epoch = ++epochRef.current
    // A switch (new memoKey) may serve a still-fresh cached payload without
    // fetching; a reload on the same key never may.
    const keyChanged = memoKey !== undefined && memoKey !== lastKeyRef.current
    lastKeyRef.current = memoKey
    // Instant paint: on a deps/key change, if a last-good result for the new key
    // is cached, show it immediately and flag `switching` while the fresh fetch
    // runs. If there is NO cached result for the new key, clear stale data so the
    // section paints its loading/skeleton state — never the previous filter's
    // numbers. (An interval re-poll keeps the same key, whose last result is
    // always cached, so a background refresh never blanks.)
    let servedCached = false
    if (memoKey) {
      const cached = memoGet<T>(memoKey)
      if (cached !== undefined) {
        setData(cached.value)
        servedCached = true
        // The footer's "refreshed Ns ago" must describe the payload on screen,
        // not this hook instance's last fetch of some other key.
        setLastSuccessAt(cached.at)
        lastSuccessRef.current = cached.at
        // Still fresh, and this is a switch rather than a poll/manual refresh:
        // the painted answer is good enough, so skip the CLI spawn entirely.
        if (keyChanged && Date.now() - cached.at < POLLED_FRESH_MS) {
          setError(null)
          setLoading(false)
          setSwitching(false)
          return
        }
      } else setData(null)
    }
    setLoading(true)
    setSwitching(servedCached)
    // Clear any prior error at the start of each attempt so a fresh poll never
    // shows a stale banner while it is still in flight; last-good `data` stays.
    setError(null)
    fetcher()
      .then(result => {
        if (epochRef.current !== epoch) return
        setData(result)
        setError(null)
        const at = Date.now()
        setLastSuccessAt(at)
        lastSuccessRef.current = at
        if (memoKey) memoSet(memoKey, result)
      })
      .catch(err => {
        if (epochRef.current !== epoch) return
        setError(normalizeCliError(err))
      })
      .finally(() => {
        if (epochRef.current !== epoch) return
        setLoading(false)
        setSwitching(false)
      })
    // deps are intentionally the caller-provided dependency list; `enabled` and
    // `memoKey` are prepended so flipping the gate / key re-creates load and
    // fires immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, memoKey, ...deps])

  useEffect(() => {
    load()
    // Skip interval ticks while the window is hidden/minimized/occluded: a
    // backgrounded dashboard polling the CLI is pure energy waste. A visible-
    // but-unfocused window (e.g. a second monitor) reports 'visible' and keeps
    // polling. Read visibility live per tick so pausing holds even if a
    // visibilitychange event was missed.
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      load()
    }
    // Manual cadence (intervalMs == null) skips the interval entirely.
    const id = intervalMs != null ? setInterval(tick, intervalMs) : null
    // On return to visible, if the last success is older than a full cadence,
    // refresh once immediately instead of waiting up to intervalMs for the next
    // tick. Manual cadence has no catch-up (the user drives refresh).
    const onVisible = () => {
      if (intervalMs == null) return
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
      const last = lastSuccessRef.current
      if (last == null || Date.now() - last >= intervalMs) load()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (id != null) clearInterval(id)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      // Retire this generation so an in-flight fetch can't resolve into state
      // after unmount or a deps change.
      epochRef.current++
    }
  }, [load, intervalMs])

  const refresh = useCallback(() => {
    load()
  }, [load])

  return { data, error, loading, switching, lastSuccessAt, refresh }
}
