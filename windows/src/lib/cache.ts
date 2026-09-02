/// Per-selection payload cache. Entries are served instantly on tab switches and refreshed
/// in the background (stale-while-revalidate); `age` lets the caller decide whether a
/// background refresh is due. The key is the whole selection, as PayloadCacheKey is on the
/// mac: two selections that would send different arguments to the CLI are different entries.

import type { Period } from '../components/PeriodTabs'

export type Selection = {
  period: Period
  provider: string
  /// Picked days, sorted. Non-empty means the day picker governs and the period is ignored.
  days: string[]
}

export function selectionKey(s: Selection): string {
  return [s.period, s.provider, s.days.join(',')].join('|')
}

export function sameSelection(a: Selection, b: Selection): boolean {
  return selectionKey(a) === selectionKey(b)
}

interface CacheEntry<T> {
  data: T
  ts: number
}

export class PayloadCache<T> {
  private store = new Map<string, CacheEntry<T>>()
  private flights = new Set<string>()

  get(selection: Selection): T | null {
    return this.store.get(selectionKey(selection))?.data ?? null
  }

  /// Milliseconds since the entry was stored, or Infinity when absent.
  age(selection: Selection): number {
    const entry = this.store.get(selectionKey(selection))
    return entry ? Date.now() - entry.ts : Number.POSITIVE_INFINITY
  }

  set(selection: Selection, data: T): void {
    this.store.set(selectionKey(selection), { data, ts: Date.now() })
  }

  isInFlight(selection: Selection): boolean {
    return this.flights.has(selectionKey(selection))
  }

  markInFlight(selection: Selection): void {
    this.flights.add(selectionKey(selection))
  }

  clearInFlight(selection: Selection): void {
    this.flights.delete(selectionKey(selection))
  }
}
