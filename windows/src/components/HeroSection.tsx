import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { USD, formatCurrency, plural } from '../lib/currency'
import { prettyDate, todayKey } from '../lib/dates'
import { SectionCaption } from './CollapsibleSection'
import { LeafIcon, WarningIcon } from './Icons'

type Props = {
  payload: MenubarPayload | null
  currency: CurrencyState
  periodLabel: string
  isToday: boolean
  /// Today spend limit from the CLI config, or null when the alert is off.
  dailyBudget: number | null
}

export function HeroSection({ payload, currency, periodLabel, isToday, dailyBudget }: Props) {
  const todayLabel = prettyDate(todayKey())
  const caption = isToday ? `Today · ${todayLabel}` : (payload?.current.label || periodLabel)
  const cost = payload?.current.cost ?? 0
  // The budget is defined in USD, matching the CLI config and the presets the settings
  // window will offer, so it is compared and printed in USD rather than converted.
  const overBudget = isToday && dailyBudget !== null && payload !== null && cost >= dailyBudget
  const savings = payload?.current.localModelSavings?.totalUSD ?? 0

  return (
    <section className="hero">
      <SectionCaption text={caption} />
      <div className="hero-row">
        {payload ? (
          <div className="hero-amount">{formatCurrency(payload.current.cost, currency)}</div>
        ) : (
          <div className="hero-amount hero-skeleton" aria-label="Loading" />
        )}
        <div className="hero-meta">
          {payload ? (
            <>
              <span className="hero-calls">{payload.current.calls.toLocaleString()} {payload.current.calls === 1 ? 'call' : 'calls'}</span>
              <span className="hero-sessions">{plural(payload.current.sessions, 'session')}</span>
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
