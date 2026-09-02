/// The one live-quota source the page has. Everything that shows a provider's remaining
/// capacity -- the tab strip capsules and their hover popover, the warning row above the
/// strip, the Plan insight, the settings window -- reads this store, so one CLI spawn per
/// cadence feeds them all instead of each surface polling on its own. The cadence is the
/// settings window's Quota Refresh setting, two minutes by default.
///
/// Port of the macOS quota path (Data/QuotaSummary.swift for the presentation types,
/// SubscriptionRefreshBackoff in CodeBurnApp.swift for the retry schedule). The CLI's
/// `quota --format json` is flatter than the mac's per-provider adapters: it collapses the
/// connection state into `available` plus an optional `error`, so the six-way Connection
/// enum is reconstructed from those two fields plus what the store itself knows about the
/// refresh in flight.

import { invoke } from '@tauri-apps/api/core'

export type Severity = 'normal' | 'warning' | 'critical' | 'danger'

/// Four tiers, from QuotaSummary.severity: below 50% is headroom, then yellow, orange, red.
export function severity(percent: number): Severity {
  if (percent >= 90) return 'danger'
  if (percent >= 75) return 'critical'
  if (percent >= 50) return 'warning'
  return 'normal'
}

export type QuotaWindow = { label: string; usedPct: number; resetsAt?: string }

/// The glance value: every provider on the same billing horizon, weekly if there is one, else
/// monthly, else the window nearest exhaustion. Empty stays null rather than posing as 0%.
export function headlineWindow(windows: QuotaWindow[]): QuotaWindow | null {
  const find = (needle: string) => windows.find((row) => row.label.toLowerCase().includes(needle))
  return (
    find('week') ??
    find('month') ??
    windows.reduce<QuotaWindow | null>((worst, row) => (worst && worst.usedPct >= row.usedPct ? worst : row), null)
  )
}

export function pct(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)))
}

export function resetsIn(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const seconds = (new Date(iso).getTime() - now) / 1000
  if (Number.isNaN(seconds)) return ''
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

/// The providers whose quota adapter takes a key from the environment, from `src/quota/*.ts`.
/// Rust refuses a key for anything else, so this list is the UI half of the same rule.
export const ACCEPTS_KEY = ['zai', 'clinepass']

/// CapacityDockQuotaPresentation.visibleFooterLines: a footer line that only repeats the
/// reason already shown above it is noise, so it is dropped rather than printed twice.
export function visibleFooterLines(lines: string[], reason: string | null): string[] {
  const needle = reason?.trim().toLowerCase()
  if (!needle) return lines
  return lines.filter((line) => line.trim().toLowerCase() !== needle)
}

export function displayLabel(label: string): string {
  return label
    .replace(/Claude and GPT models/i, 'Claude + GPT')
    .replace(/Gemini Models/i, 'Gemini')
    .replace(/Five-hour/i, '5-hour')
}

export type QuotaProvider = {
  id: string
  name: string
  available: boolean
  plan?: string
  windows: QuotaWindow[]
  error?: string
}

export type DockQuota =
  | { state: 'ready'; providers: QuotaProvider[] }
  | { state: 'cliOutdated' }
  | { state: 'unavailable'; message: string }

/// QuotaSummary.Connection, rebuilt from what the CLI reports plus the store's own view of
/// the refresh cycle.
export type Connection =
  | 'connected'
  | 'disconnected'
  | 'loading'
  | 'stale'
  | 'transientFailure'
  | 'terminalFailure'

export type QuotaSummary = {
  id: string
  name: string
  connection: Connection
  planLabel: string | null
  windows: QuotaWindow[]
  /// The one window that speaks for the provider, on the mac's shared billing horizon.
  headline: QuotaWindow | null
  /// The worst window, which is what a warning has to be loud about.
  worst: QuotaWindow | null
  reason: string | null
  footerLines: string[]
}

export type QuotaState = {
  /// The last answer that parsed, kept across a failed refresh so the bars do not blink out.
  providers: QuotaProvider[]
  loading: boolean
  /// Set once a refresh has failed and the last good answer is what is on screen.
  retrying: boolean
  cliOutdated: boolean
  error: string | null
  fetchedAt: number | null
}

export const EMPTY_QUOTA: QuotaState = {
  providers: [],
  loading: false,
  retrying: false,
  cliOutdated: false,
  error: null,
  fetchedAt: null,
}

/// The cadence and the retry schedule, from SubscriptionRefreshBackoff. A failure pulls the
/// next attempt in and each further failure doubles it back out to the cadence, so a provider
/// that has just come back is picked up quickly without hammering one that is down.
const DEFAULT_CADENCE_MS = 120_000
const INITIAL_BACKOFF_MS = 30_000
const MAX_JITTER_MS = 5_000
const MAX_BACKOFF_DOUBLINGS = 10
/// Data older than this is described as stale, matching the mac's "as of" caption.
const STALE_MS = 10 * 60_000

export function backoffDelay(failureCount: number, cadenceMs: number, jitterUnit: number): number {
  if (cadenceMs <= 0) return 0
  const exponent = Math.min(Math.max(failureCount, 1) - 1, MAX_BACKOFF_DOUBLINGS)
  const exponential = Math.min(cadenceMs, INITIAL_BACKOFF_MS * 2 ** exponent)
  const jitter = Math.min(Math.max(jitterUnit, 0), 1) * Math.min(MAX_JITTER_MS, cadenceMs)
  return Math.min(cadenceMs, exponential + jitter)
}

type Listener = (state: QuotaState) => void

let state: QuotaState = EMPTY_QUOTA
let listeners: Listener[] = []
let timer: number | undefined
let inFlight: Promise<void> | null = null
let failures = 0
let cadenceMs = DEFAULT_CADENCE_MS

/// The settings window's Quota Refresh picker, from SubscriptionRefreshCadence. Zero is
/// Manual: the store then only answers Retry and the popover opening, and never polls.
export function setQuotaCadence(seconds: number): void {
  const next = Math.max(0, seconds) * 1000
  if (next === cadenceMs) return
  cadenceMs = next
  if (listeners.length === 0) return
  if (cadenceMs === 0) {
    window.clearTimeout(timer)
    return
  }
  // Measured from the last answer, so shortening the cadence takes effect at once and
  // lengthening it does not fire a run the old timer had already earned.
  schedule(Math.max(0, cadenceMs - (Date.now() - (state.fetchedAt ?? 0))))
}

function publish(next: Partial<QuotaState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener(state)
}

function schedule(delay: number) {
  window.clearTimeout(timer)
  if (cadenceMs === 0) return
  timer = window.setTimeout(() => { void refreshQuota() }, delay)
}

/// Single-flight: the strip, the warning row and the Plan insight all mount at once, and a
/// CLI spawn each would be three Node processes for one answer.
export async function refreshQuota(): Promise<void> {
  if (inFlight) return inFlight
  publish({ loading: true })
  inFlight = (async () => {
    try {
      const answer = await invoke<DockQuota>('dock_quota')
      if (answer.state === 'ready') {
        failures = 0
        publish({
          providers: answer.providers,
          loading: false,
          retrying: false,
          cliOutdated: false,
          error: null,
          fetchedAt: Date.now(),
        })
        schedule(cadenceMs)
        return
      }
      failures += 1
      publish({
        loading: false,
        retrying: state.providers.length > 0,
        cliOutdated: answer.state === 'cliOutdated',
        error: answer.state === 'unavailable' ? answer.message : null,
      })
    } catch (err) {
      failures += 1
      publish({
        loading: false,
        retrying: state.providers.length > 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    schedule(backoffDelay(failures, cadenceMs, Math.random()))
  })().finally(() => { inFlight = null })
  return inFlight
}

/// Subscribing starts the poll and unsubscribing the last listener stops it, so a hidden
/// popover costs nothing.
export function subscribeQuota(listener: Listener): () => void {
  listeners.push(listener)
  listener(state)
  if (listeners.length === 1) {
    if (state.fetchedAt === null) void refreshQuota()
    else schedule(Math.max(0, cadenceMs - (Date.now() - state.fetchedAt)))
  }
  return () => {
    listeners = listeners.filter(l => l !== listener)
    if (listeners.length === 0) window.clearTimeout(timer)
  }
}

function connectionFor(provider: QuotaProvider, quota: QuotaState): Connection {
  // The CLI reports a provider it could not read as unavailable with the reason attached;
  // unavailable and silent means there were no credentials to read in the first place.
  if (!provider.available) return provider.error ? 'terminalFailure' : 'disconnected'
  if (quota.retrying) return 'transientFailure'
  if (quota.fetchedAt !== null && Date.now() - quota.fetchedAt > STALE_MS) return 'stale'
  return 'connected'
}

/// The quota for one provider id, or null when the CLI does not read that provider at all --
/// which is what keeps the capsule slot empty rather than drawing an empty bar.
export function summaryFor(quota: QuotaState, id: string): QuotaSummary | null {
  const provider = quota.providers.find(p => p.id === id)
  if (!provider) return null
  const windows = provider.windows
  const worst = windows.reduce<QuotaWindow | null>(
    (acc, row) => (acc && acc.usedPct >= row.usedPct ? acc : row),
    null,
  )
  const footerLines = quota.retrying && quota.error ? [`Refresh failed: ${quota.error}`] : []
  return {
    id: provider.id,
    name: provider.name,
    connection: connectionFor(provider, quota),
    planLabel: provider.plan ?? null,
    windows,
    headline: headlineWindow(windows),
    worst,
    reason: provider.error ?? null,
    footerLines,
  }
}

export function quotaSummaries(quota: QuotaState): QuotaSummary[] {
  return quota.providers
    .map(p => summaryFor(quota, p.id))
    .filter((s): s is QuotaSummary => s !== null)
}

/// Every connected provider at or over the warning threshold, worst window first. The mac
/// composes the same list for the header row and the menubar flame tint.
export function quotaWarnings(quota: QuotaState, thresholdPct = 70): Array<{ name: string; percent: number }> {
  return quotaSummaries(quota)
    .filter(s => s.connection !== 'disconnected' && s.connection !== 'terminalFailure')
    .map(s => ({ name: s.name, percent: s.worst?.usedPct ?? 0 }))
    .filter(row => row.percent >= thresholdPct)
    .sort((a, b) => b.percent - a.percent)
}

/// The worst severity across every connected provider, which is what tints the tray flame.
export function worstSeverity(quota: QuotaState): Severity {
  const worst = quotaSummaries(quota)
    .filter(s => s.connection !== 'disconnected' && s.connection !== 'terminalFailure')
    .reduce((max, s) => Math.max(max, s.worst?.usedPct ?? 0), 0)
  return severity(worst)
}
