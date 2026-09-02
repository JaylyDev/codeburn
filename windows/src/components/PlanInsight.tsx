import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatTokens, plural } from '../lib/currency'
import { relativeFuture } from '../lib/dates'
import type { PlanProjection, PlanUsage } from '../lib/plan'
import { projectQuotaWindow, projectWindow, earliestReset } from '../lib/plan'
import { displayLabel, refreshQuota, summaryFor, type QuotaState, type QuotaSummary } from '../lib/quota'
import { ALL_PROVIDER, type Provider } from './AgentTabStrip'
import { BulbIcon, ChevronRight, KeySlashIcon, PersonDashedIcon, WarningIcon, ArrowUpRight } from './Icons'

/// Sonnet-weighted approximation the mac app uses to turn a dollar saving into tokens.
const USD_PER_MILLION_EFFECTIVE_TOKENS = 9
const MILLION = 1_000_000
const PLAN_REFRESH_MS = 5 * 60_000

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; usage: Extract<PlanUsage, { state: 'ok' }> }
  | { kind: 'no_credentials' }
  | { kind: 'failed'; message: string }

type Props = {
  payload: MenubarPayload | null
  currency: CurrencyState
  provider: Provider
  quota: QuotaState
  onOpenTerminal: (args: string[]) => void
  onConnectClaude: () => void
}

/// Which providers the Plan tab has something to say about. Claude always qualifies: its
/// tier and prior-cycle baseline come from the credential file, not from the CLI's quota
/// answer, so it has a plan view before the store has replied. Otherwise it is whichever
/// provider is selected, or, under All, every provider currently reporting quota.
export function planTargets(quota: QuotaState, provider: Provider): QuotaSummary[] {
  if (provider !== ALL_PROVIDER) {
    const summary = summaryFor(quota, provider)
    return summary ? [summary] : []
  }
  const connected = quota.providers
    .filter(p => p.available && p.windows.length > 0)
    .map(p => summaryFor(quota, p.id))
    .filter((s): s is QuotaSummary => s !== null)
  // Claude first, as on the mac, then the rest in the order the CLI reports them.
  return connected.sort((a, b) => Number(b.id === 'claude') - Number(a.id === 'claude'))
}

export function PlanInsight({ payload, currency, provider, quota, onOpenTerminal, onConnectClaude }: Props) {
  const targets = planTargets(quota, provider)
  // Selecting Claude shows its plan even before the quota store has answered, since that
  // view does not depend on the store.
  const blocks: Array<QuotaSummary | 'claude'> = provider === 'claude' && !targets.some(t => t.id === 'claude')
    ? ['claude', ...targets]
    : targets
  const named = blocks.length > 1

  return (
    <div className="plan-stack">
      {blocks.map(target => target === 'claude' || target.id === 'claude' ? (
        <ClaudePlan
          key="claude"
          payload={payload}
          currency={currency}
          named={named}
          onOpenTerminal={onOpenTerminal}
          onConnectClaude={onConnectClaude}
        />
      ) : (
        <ProviderPlan key={target.id} summary={target} named={named} />
      ))}
    </div>
  )
}

/// The Claude tab keeps its own path: `plan_usage` reads the credential file directly, which
/// is the only source for the subscription tier and last cycle's final reading.
function ClaudePlan({ payload, currency, named, onOpenTerminal, onConnectClaude }: {
  payload: MenubarPayload | null
  currency: CurrencyState
  named: boolean
  onOpenTerminal: (args: string[]) => void
  onConnectClaude: () => void
}) {
  const [state, setState] = useState<LoadState>({ kind: 'idle' })
  const [now, setNow] = useState(() => new Date())

  const load = async () => {
    setState(prev => (prev.kind === 'loaded' ? prev : { kind: 'loading' }))
    try {
      const usage = await invoke<PlanUsage>('plan_usage')
      if (usage.state === 'ok') setState({ kind: 'loaded', usage })
      else if (usage.state === 'no_credentials') setState({ kind: 'no_credentials' })
      else setState({ kind: 'failed', message: usage.message })
    } catch (err) {
      setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
    setNow(new Date())
  }

  useEffect(() => {
    load()
    const id = setInterval(load, PLAN_REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  switch (state.kind) {
    case 'idle':
    case 'loading':
      return (
        <div className="plan-state">
          <PersonDashedIcon size={22} className="plan-state-icon" />
          <div className="plan-state-title-muted">Loading your plan...</div>
          <div className="plan-state-note">Reading Claude Code credentials from this machine.</div>
        </div>
      )
    case 'no_credentials':
      return (
        <div className="plan-state">
          <KeySlashIcon size={20} className="plan-state-icon" />
          <div className="plan-state-title">No Claude subscription connected</div>
          <div className="plan-state-note">Click Connect to sign in with Claude in a terminal, then return here.</div>
          <div className="plan-actions">
            <button type="button" className="btn btn-prominent" onClick={() => onConnectClaude()}>Connect Claude</button>
            <button type="button" className="btn" onClick={load}>Retry</button>
          </div>
        </div>
      )
    case 'failed':
      return (
        <div className="plan-state">
          <WarningIcon size={18} filled={false} className="plan-state-icon plan-state-icon-accent" />
          <div className="plan-state-title">Couldn't load plan data</div>
          <div className="plan-state-error">{state.message}</div>
          <div className="plan-actions">
            <button type="button" className="btn btn-prominent" onClick={() => onConnectClaude()}>Reconnect Claude</button>
            <button type="button" className="btn" onClick={load}>Retry</button>
          </div>
        </div>
      )
    case 'loaded': {
      const { usage } = state
      const reset = earliestReset(usage.windows)
      return (
        <div className="plan-insight">
          <div className="plan-header">
            {named && <span className="plan-provider">Claude</span>}
            <span className="plan-tier">{usage.tier}</span>
            {reset && <span className="plan-reset">Resets {relativeFuture(reset, now)}</span>}
          </div>
          <div className="plan-rows">
            {usage.windows.map(w => (
              <UtilizationRow key={w.key} label={w.label} percent={w.percent} projection={projectWindow(w, now)} now={now} />
            ))}
          </div>
          {payload && payload.optimize.findingCount > 0 && payload.optimize.savingsUSD > 0 && (
            <button type="button" className="savings-badge" onClick={() => onOpenTerminal(['optimize'])}>
              <BulbIcon size={10} className="savings-badge-icon" />
              <span>
                Save ~{formatCompactCurrency(payload.optimize.savingsUSD, currency)} / ~
                {formatTokens((payload.optimize.savingsUSD / USD_PER_MILLION_EFFECTIVE_TOKENS) * MILLION)} tokens
                {' · '}{plural(payload.optimize.findingCount, 'finding')}
              </span>
              <ChevronRight size={8} className="savings-badge-chevron" />
            </button>
          )}
        </div>
      )
    }
  }
}

/// Every other provider reads the shared quota store, which is the same data the mac's
/// per-provider plan tabs render. There is no prior-cycle baseline behind it, so a window
/// too fresh to extrapolate simply gets no caption.
function ProviderPlan({ summary, named }: { summary: QuotaSummary; named: boolean }) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), PLAN_REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const retry = () => { setNow(new Date()); void refreshQuota() }

  if (summary.connection === 'disconnected') {
    return (
      <div className="plan-state">
        <KeySlashIcon size={20} className="plan-state-icon" />
        <div className="plan-state-title">No {summary.name} credentials found</div>
        <div className="plan-state-note">Sign in with the {summary.name} CLI first. Then click Try Again.</div>
        <div className="plan-actions">
          <button type="button" className="btn btn-prominent" onClick={retry}>Try Again</button>
        </div>
      </div>
    )
  }
  if (summary.connection === 'terminalFailure') {
    return (
      <div className="plan-state">
        <WarningIcon size={18} filled={false} className="plan-state-icon plan-state-icon-accent" />
        <div className="plan-state-title">Reconnect {summary.name}</div>
        <div className="plan-state-error">{summary.reason ?? `Your ${summary.name} session has expired. Sign in again in your terminal, then click Reconnect.`}</div>
        <div className="plan-actions">
          <button type="button" className="btn btn-prominent" onClick={retry}>Reconnect</button>
        </div>
      </div>
    )
  }
  if (summary.windows.length === 0) {
    return (
      <div className="plan-state">
        <PersonDashedIcon size={22} className="plan-state-icon" />
        <div className="plan-state-title-muted">Reading {summary.name} credentials...</div>
      </div>
    )
  }

  const reset = summary.windows
    .map(w => (w.resetsAt ? new Date(w.resetsAt) : null))
    .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
    .reduce<Date | null>((a, b) => (a && a < b ? a : b), null)

  return (
    <div className="plan-insight">
      <div className="plan-header">
        {named && <span className="plan-provider">{summary.name}</span>}
        <span className="plan-tier">{summary.planLabel ?? summary.name}</span>
        {reset && <span className="plan-reset">Resets {relativeFuture(reset, now)}</span>}
      </div>
      <div className="plan-rows">
        {summary.windows.map((window, index) => (
          <UtilizationRow
            key={`${window.label}-${index}`}
            label={`${displayLabel(window.label)} window`}
            percent={window.usedPct}
            projection={projectQuotaWindow(window.label, window.usedPct, window.resetsAt, now)}
            now={now}
          />
        ))}
      </div>
      {summary.connection === 'transientFailure' && (
        <div className="plan-note">{summary.name} temporarily unreachable. Retrying.</div>
      )}
      {summary.connection === 'stale' && <div className="plan-note">Showing the last reading.</div>}
    </div>
  )
}

function UtilizationRow({ label, percent, projection, now }: {
  label: string
  percent: number
  projection: PlanProjection | null
  now: Date
}) {
  const clamped = Math.min(Math.max(percent, 0), 100)
  const marker = projection ? Math.min(Math.max(projection.percent, 0), 100) : null

  let caption: string | null = null
  if (projection) {
    const pct = Math.round(projection.percent)
    if (projection.source === 'historical') caption = `Based on last cycle: ${pct}%`
    else if (projection.willOverflow && projection.hitsLimitAt) caption = `On pace: ${pct}% at reset · hits 100% ${relativeFuture(projection.hitsLimitAt, now)}`
    else caption = `On pace: ${pct}% at reset`
  }

  return (
    <div className="util-row">
      <div className="util-row-head">
        <span className="util-label">{label}</span>
        <span className="util-percent">{Math.round(clamped)}%</span>
      </div>
      <div className="util-bar">
        <div className="util-bar-fill" style={{ width: `${clamped}%` }} />
        {marker !== null && <div className="util-bar-marker" style={{ left: `calc(${marker}% - 0.75px)` }} />}
      </div>
      {caption && (
        <div className={`util-caption ${projection?.willOverflow ? 'util-caption-warn' : ''}`}>
          {projection?.willOverflow ? <WarningIcon size={8} /> : <ArrowUpRight size={8} />}
          <span>{caption}</span>
        </div>
      )}
    </div>
  )
}
