import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Anonymous, consent-gated product telemetry for the desktop app ONLY.
// Runs entirely in the Electron main process. Like cli.ts, this module must
// NOT import `electron` so it stays unit-testable in plain node; main.ts
// injects the electron-derived bits (userData path, country, isPackaged).
//
// Privacy invariants (enforced here, not by the caller):
// - Nothing is ever sent before the user completes the onboarding consent
//   screen, and nothing is sent while the toggle is off.
// - EU/EEA/UK/CH installs default the toggle OFF; everywhere else defaults ON.
//   Either way the user decides on the consent screen.
// - The only identifier is a random UUID minted locally. No fingerprinting.
// - Events carry day-granularity timestamps only, and props pass a whitelist
//   sanitizer: every leaf is a short string, a finite number or a boolean, and
//   the nesting, key count and array length are all capped. Anything else
//   (functions, dates, deep trees) is dropped rather than encoded.
// - The richest event is `usage_snapshot`, the CLI-computed daily aggregate in
//   `payload.telemetrySnapshot`. It is bucketed and name-only by construction:
//   see src/telemetry-snapshot.ts for the contract it holds.
// - Dev / unpackaged builds never send (CODEBURN_TELEMETRY_DEV=1 overrides
//   for end-to-end testing).

export const TELEMETRY_ENDPOINT = 'https://api.codeburn.app/v1/telemetry'
export const TELEMETRY_SCHEMA = 1

// EU-27 + EEA (IS, LI, NO) + UK + CH: conservative "default off" region.
const DEFAULT_OFF_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH',
])

export function defaultEnabledFor(country: string | null | undefined): boolean {
  if (!country) return false // unknown region: be conservative
  return !DEFAULT_OFF_COUNTRIES.has(country.toUpperCase())
}

export const EVENT_NAMES = new Set([
  'app_open',
  'app_close',
  'section_view',
  'cold_start',
  'usage_snapshot',
  'cli_error',
  // Name-only interaction events. Props carry a fix id, a provider, a format,
  // a model name or a setting name and its boolean/enum value, never free text.
  'optimize_apply',
  'plan_set',
  'export',
  'compare_view',
  'settings_change',
])

const MAX_QUEUE = 200
const MAX_CLI_ERRORS_PER_KIND_PER_DAY = 20
const MAX_STRING = 64
const MAX_ARRAY = 12
const MAX_KEYS = 16
// Containers may nest this deep below the props object. The daily usage
// snapshot is the deepest shape we send: props -> models[] -> model -> tasks[]
// -> task. Anything deeper is dropped whole.
const MAX_DEPTH = 5
// Belt and braces on top of the per-level caps: one event can never encode more
// than this many leaf values, whatever shape it arrives in.
const MAX_LEAVES = 1000

export type TelemetryStatus = {
  installId: string
  country: string | null
  enabled: boolean
  defaultEnabled: boolean
  /** True once the user has been through the onboarding consent screen. */
  onboarded: boolean
}

type PersistedState = {
  version: 1
  installId: string
  enabled: boolean
  onboardedAt?: string
  lastSnapshotDay?: string
  cliErrorDay?: string
  cliErrorCounts?: Record<string, number>
}

type Deps = {
  /** Directory for the consent/state file (Electron userData in production). */
  stateDir: string
  /** ISO-3166 alpha-2 from the OS locale, or null when unknown. */
  country: string | null
  /** Only packaged builds send (unless CODEBURN_TELEMETRY_DEV=1). */
  isPackaged: boolean
  appVersion: string
  platform?: string
  arch?: string
  endpoint?: string
  fetchFn?: typeof fetch
  now?: () => Date
}

type QueuedEvent = { name: string; day: string; props: Record<string, unknown> }

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function loadCliErrorBudget(day: unknown, counts: unknown): Pick<PersistedState, 'cliErrorDay' | 'cliErrorCounts'> {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return {}
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return {}
  const cleanCounts = Object.create(null) as Record<string, number>
  for (const [kind, count] of Object.entries(counts)) {
    if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > MAX_CLI_ERRORS_PER_KIND_PER_DAY) return {}
    cleanCounts[kind] = count as number
  }
  return { cliErrorDay: day, cliErrorCounts: cleanCounts }
}

type LeafBudget = { left: number }

function sanitizeValue(value: unknown, depth: number, budget: LeafBudget): unknown | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (budget.left <= 0) return undefined
    if (typeof value === 'number' && !Number.isFinite(value)) return undefined
    budget.left--
    return typeof value === 'string' ? value.slice(0, MAX_STRING) : value
  }
  if (depth >= MAX_DEPTH) return undefined
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const entry of value.slice(0, MAX_ARRAY)) {
      const sv = sanitizeValue(entry, depth + 1, budget)
      if (sv !== undefined) items.push(sv)
    }
    return items.length > 0 ? items : undefined
  }
  // Plain objects only. A Date, Map, function or class instance carries state
  // we have no whitelist for, so it is dropped rather than walked.
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return undefined
  const flat = sanitizeObject(value as Record<string, unknown>, depth + 1, budget)
  return Object.keys(flat).length > 0 ? flat : undefined
}

function sanitizeObject(obj: Record<string, unknown>, depth: number, budget: LeafBudget): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let keys = 0
  for (const [key, value] of Object.entries(obj)) {
    if (keys >= MAX_KEYS) break
    const sv = sanitizeValue(value, depth, budget)
    if (sv === undefined) continue
    out[key.slice(0, MAX_STRING)] = sv
    keys++
  }
  return out
}

/** Whitelist sanitizer. Keeps short strings, finite numbers and booleans, plus
 *  plain objects and arrays of them nested up to MAX_DEPTH, each level capped by
 *  MAX_KEYS / MAX_ARRAY and the whole event by MAX_LEAVES. Everything else is
 *  dropped. Deep enough for the daily usage snapshot's model x task cross and
 *  nothing more. */
export function sanitizeProps(props: unknown): Record<string, unknown> {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {}
  return sanitizeObject(props as Record<string, unknown>, 1, { left: MAX_LEAVES })
}

export class Telemetry {
  private readonly deps: Required<Pick<Deps, 'stateDir' | 'country' | 'isPackaged' | 'appVersion'>> & Deps
  private state: PersistedState
  private queue: QueuedEvent[] = []
  private openedAt: number

  constructor(deps: Deps) {
    this.deps = deps
    this.state = this.load()
    this.openedAt = Date.now()
  }

  private stateFile(): string {
    return join(this.deps.stateDir, 'telemetry.v1.json')
  }

  private load(): PersistedState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile(), 'utf-8')) as Partial<PersistedState>
      if (raw && raw.version === 1 && typeof raw.installId === 'string' && typeof raw.enabled === 'boolean') {
        return {
          version: 1,
          installId: raw.installId,
          enabled: raw.enabled,
          onboardedAt: typeof raw.onboardedAt === 'string' ? raw.onboardedAt : undefined,
          lastSnapshotDay: typeof raw.lastSnapshotDay === 'string' ? raw.lastSnapshotDay : undefined,
          ...loadCliErrorBudget(raw.cliErrorDay, raw.cliErrorCounts),
        }
      }
    } catch { /* first run or unreadable — start fresh */ }
    return { version: 1, installId: randomUUID(), enabled: defaultEnabledFor(this.deps.country) }
  }

  private save(): void {
    try {
      const file = this.stateFile()
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(this.state), { mode: 0o600 })
    } catch { /* consent must still work in-memory */ }
  }

  status(): TelemetryStatus {
    return {
      installId: this.state.installId,
      country: this.deps.country,
      enabled: this.state.enabled,
      defaultEnabled: defaultEnabledFor(this.deps.country),
      onboarded: this.state.onboardedAt !== undefined,
    }
  }

  setEnabled(enabled: boolean): TelemetryStatus {
    this.state.enabled = enabled
    // Opting out mints a fresh id so past and future data cannot be linked.
    if (!enabled) {
      this.queue = []
      this.state.installId = randomUUID()
    }
    this.save()
    return this.status()
  }

  /** The onboarding consent screen's final decision. Unlocks sending. */
  completeOnboarding(enabled: boolean): TelemetryStatus {
    this.state.onboardedAt = new Date().toISOString()
    const next = this.setEnabled(enabled)
    this.track('app_open', {})
    return next
  }

  private get canSend(): boolean {
    if (!this.state.enabled || this.state.onboardedAt === undefined) return false
    return this.deps.isPackaged || process.env.CODEBURN_TELEMETRY_DEV === '1'
  }

  /** Queue an event. Unknown names and junk props are dropped, never thrown. */
  track(name: string, props: unknown): void {
    if (!EVENT_NAMES.has(name)) return
    if (!this.state.enabled) return
    // usage_snapshot is an aggregate: at most one per calendar day.
    const now = (this.deps.now ?? (() => new Date()))()
    const day = dayKey(now)
    if (name === 'usage_snapshot') {
      if (this.state.lastSnapshotDay === day) return
      this.state.lastSnapshotDay = day
      this.save()
    }
    if (this.queue.length >= MAX_QUEUE) {
      if (name !== 'app_close') return
      this.queue.shift()
    }
    const sanitizedProps = sanitizeProps(props)
    if (name === 'cli_error') {
      if (this.state.cliErrorDay !== day) {
        this.state.cliErrorDay = day
        this.state.cliErrorCounts = Object.create(null) as Record<string, number>
      }
      const counts = this.state.cliErrorCounts ?? (this.state.cliErrorCounts = Object.create(null) as Record<string, number>)
      const kind = typeof sanitizedProps.kind === 'string' ? sanitizedProps.kind : ''
      const count = Object.prototype.hasOwnProperty.call(counts, kind) ? counts[kind]! : 0
      if (count >= MAX_CLI_ERRORS_PER_KIND_PER_DAY) return
      counts[kind] = count + 1
      this.save()
    }
    this.queue.push({ name, day, props: sanitizedProps })
  }

  /** Record session duration; queued for the next (final) flush. */
  trackClose(): void {
    this.track('app_close', { sessionMinutes: Math.round((Date.now() - this.openedAt) / 60_000) })
  }

  /** Best-effort batch POST. Keeps the queue on failure, clears on success. */
  async flush(): Promise<boolean> {
    if (!this.canSend || this.queue.length === 0) return false
    const events = this.queue
    const body = JSON.stringify({
      schema: TELEMETRY_SCHEMA,
      installId: this.state.installId,
      app: {
        name: 'codeburn-desktop',
        version: this.deps.appVersion,
        platform: this.deps.platform ?? process.platform,
        arch: this.deps.arch ?? process.arch,
        country: this.deps.country,
      },
      events,
    })
    try {
      const fetchFn = this.deps.fetchFn ?? fetch
      const res = await fetchFn(this.deps.endpoint ?? TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      if (!res.ok) {
        // 4xx is a permanent rejection of this batch (schema drift, bad shape):
        // retrying the same payload forever would wedge the queue at its cap.
        // Drop it. 5xx/network are transient — keep the batch for the next beat.
        if (res.status >= 400 && res.status < 500) this.queue = this.queue.filter(e => !events.includes(e))
        return false
      }
      // Only drop what was sent; events tracked mid-flight stay queued.
      this.queue = this.queue.filter(e => !events.includes(e))
      return true
    } catch {
      return false
    }
  }

  /** Visible for tests. */
  get queueLength(): number {
    return this.queue.length
  }
}
