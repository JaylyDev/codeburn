import type { CombinedUsage, MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { USD, formatCurrency, formatTokens, plural } from '../lib/currency'
import { prettyDate, todayKey } from '../lib/dates'
import { SectionCaption } from './CollapsibleSection'
import { LeafIcon, MonitorIcon, WarningIcon } from './Icons'

type Props = {
  payload: MenubarPayload | null
  currency: CurrencyState
  periodLabel: string
  isToday: boolean
  /// Today spend limit from the CLI config, or null when the alert is off.
  dailyBudget: number | null
  /// True when the reader asked for every paired device, not just this one.
  combinedScope: boolean
}

export function HeroSection({ payload, currency, periodLabel, isToday, dailyBudget, combinedScope }: Props) {
  const todayLabel = prettyDate(todayKey())
  // Pulling the peers is best effort in the CLI, so combined scope can come back with local
  // totals and no `combined` block. The hero then reads as a plain local view, plus a note.
  const combined = combinedScope ? payload?.combined ?? null : null
  const totals = combined?.combined
  const cost = totals?.cost ?? payload?.current.cost ?? 0
  const calls = totals?.calls ?? payload?.current.calls ?? 0
  const sessions = totals?.sessions ?? payload?.current.sessions ?? 0

  const label = payload?.current.label || periodLabel
  const caption = combined ? `Combined · ${label}` : isToday ? `Today · ${todayLabel}` : label
  // The budget is defined in USD, matching the CLI config and the presets the settings
  // window will offer, so it is compared and printed in USD rather than converted. Combined
  // totals are several machines' spend, which the limit was never set against.
  const overBudget = isToday && !combinedScope && dailyBudget !== null && payload !== null && cost >= dailyBudget
  const savings = combined ? 0 : payload?.current.localModelSavings?.totalUSD ?? 0

  return (
    <section className="hero">
      <SectionCaption text={caption} />
      <div className="hero-row">
        {payload ? (
          <div className="hero-amount">{formatCurrency(cost, currency)}</div>
        ) : (
          <div className="hero-amount hero-skeleton" aria-label="Loading" />
        )}
        <div className="hero-meta">
          {payload ? (
            <>
              <span className="hero-calls">{calls.toLocaleString()} {calls === 1 ? 'call' : 'calls'}</span>
              <span className="hero-sessions">{plural(sessions, 'session')}</span>
            </>
          ) : (
            <>
              <span className="hero-skeleton-line" />
              <span className="hero-skeleton-line short" />
            </>
          )}
        </div>
      </div>
      {overBudget && dailyBudget !== null && (
        <div className="hero-note hero-note-warn">
          <WarningIcon size={10} />
          <span>Daily budget of {formatCurrency(dailyBudget, USD)} exceeded</span>
        </div>
      )}
      {combined ? (
        <DeviceBreakdown usage={combined} currency={currency} />
      ) : combinedScope && payload !== null ? (
        <div className="hero-note hero-note-muted">
          <WarningIcon size={10} />
          <span>Combined unavailable · showing local</span>
        </div>
      ) : null}
      {/* Actual spend above, hypothetical avoided spend here: kept apart so the two are
          never read as one number. */}
      {savings > 0 && (
        <div className="hero-note hero-note-saved">
          <LeafIcon size={10} />
          <span>Saved {formatCurrency(savings, currency)} with local models</span>
        </div>
      )}
    </section>
  )
}

function DeviceBreakdown({ usage, currency }: { usage: CombinedUsage; currency: CurrencyState }) {
  return (
    <div className="device-breakdown">
      <div className="hero-note hero-note-muted">
        <MonitorIcon size={10} />
        <span>{usage.combined.reachableCount} of {usage.combined.deviceCount} devices</span>
      </div>
      {usage.perDevice.map(device => (
        <div key={device.id} className="device-row">
          <span className={`device-dot ${device.error ? 'is-error' : ''}`} />
          <span className="device-name">{device.local ? `${device.name} · local` : device.name}</span>
          <span className="device-cost">
            {device.error ? 'Unavailable' : formatCurrency(device.cost, currency)}
          </span>
          <span className="device-tokens">{formatTokens(device.totalTokens)}</span>
        </div>
      ))}
    </div>
  )
}
