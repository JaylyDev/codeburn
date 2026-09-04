import type { Model } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatTokens } from '../lib/currency'
import { CollapsibleSection } from './CollapsibleSection'
import { FixedBar, COL_COST, COL_COUNT } from './ActivitySection'

/// The Saved column only appears once something was actually saved. With no local-model
/// mapping it would be an unlabelled column of dashes, so the mac drops it entirely.
const COL_SAVED = 54

type Props = {
  models: Model[]
  inputTokens: number
  outputTokens: number
  cacheHitPercent: number
  currency: CurrencyState
}

export function ModelsSection({ models, inputTokens, outputTokens, cacheHitPercent, currency }: Props) {
  if (models.length === 0) return null
  const maxCost = Math.max(...models.map(m => m.cost), 0.01)
  const showSavings = models.some(m => (m.savingsUSD ?? 0) > 0)

  return (
    <CollapsibleSection
      caption="Models"
      columns={[
        { label: 'Cost', width: COL_COST },
        ...(showSavings ? [{ label: 'Saved', width: COL_SAVED }] : []),
        { label: 'Calls', width: COL_COUNT },
      ]}
    >
      {models.map(m => (
        <div key={m.name} className="data-row">
          {/* The bar tracks real cost, so a local model at $0 leaves it empty. The
              counterfactual saving is text in its own column and is never added in. */}
          <FixedBar fraction={m.cost / maxCost} />
          <span className="row-name">{m.name}</span>
          <span className="row-cost" style={{ minWidth: COL_COST }}>{formatCompactCurrency(m.cost, currency)}</span>
          {showSavings && (
            <span
              className={`row-saved ${(m.savingsUSD ?? 0) > 0 ? 'row-saved-on' : ''}`}
              style={{ minWidth: COL_SAVED }}
            >
              {(m.savingsUSD ?? 0) > 0 ? formatCompactCurrency(m.savingsUSD ?? 0, currency) : '-'}
            </span>
          )}
          <span className="row-count" style={{ minWidth: COL_COUNT }}>{m.calls}</span>
        </div>
      ))}
      {(inputTokens > 0 || outputTokens > 0) && (
        <div className="tokens-line">
          <span className="tokens-label">Tokens</span>
          <span className="tokens-value">{formatTokens(inputTokens)} in</span>
          <span className="tokens-sep">·</span>
          <span className="tokens-value">{formatTokens(outputTokens)} out</span>
          <span className="tokens-sep">·</span>
          <span className="tokens-value">{Math.round(cacheHitPercent)}% cache hit</span>
        </div>
      )}
    </CollapsibleSection>
  )
}
