import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCurrency } from '../lib/currency'
import { SectionCaption } from './CollapsibleSection'

/// Port of PullRequestsSection in mac/.../Views/PullRequestsSection.swift: the three pull
/// requests the period's spend was attributed to. Hidden entirely when the payload carries
/// no PR block, which is the case for an older CLI and for a provider-scoped payload.

export function PullRequestsSection({ payload, currency }: { payload: MenubarPayload; currency: CurrencyState }) {
  const rows = (payload.current.pullRequests?.rows ?? []).slice(0, 3)
  if (rows.length === 0) return null

  return (
    <section className="pr-section">
      <SectionCaption text="Pull requests" />
      {rows.map(row => (
        <div key={row.url} className="pr-row">
          <span className="pr-label">{row.label}</span>
          <span className="pr-cost">{formatCurrency(row.cost, currency)}</span>
        </div>
      ))}
    </section>
  )
}
