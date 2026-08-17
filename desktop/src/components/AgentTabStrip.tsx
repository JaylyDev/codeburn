import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency } from '../lib/currency'

export type Provider = 'all' | 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | 'pi'

/// Same order as the macOS ProviderFilter.allCases.
export const ALL_PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'all',      label: 'All'      },
  { id: 'claude',   label: 'Claude'   },
  { id: 'codex',    label: 'Codex'    },
  { id: 'cursor',   label: 'Cursor'   },
  { id: 'copilot',  label: 'Copilot'  },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'pi',       label: 'Pi'       },
]

export const PROVIDER_LABELS: Record<Provider, string> = Object.fromEntries(
  ALL_PROVIDERS.map(p => [p.id, p.label]),
) as Record<Provider, string>

/// Providers the CLI detected on this machine (installed, even with zero spend today).
export function detectedProviders(payload: MenubarPayload | null): Provider[] {
  if (!payload) return []
  const detected = payload.current.providers
  return ALL_PROVIDERS.map(p => p.id).filter(id => id !== 'all' && id in detected)
}

type Props = {
  selected: Provider
  onSelect: (p: Provider) => void
  payload: MenubarPayload | null
  currency: CurrencyState
}

/// Hidden entirely when there is nothing to choose between (zero or one provider): the
/// popover then reads as a single-tool tracker and the Plan pill takes the provider from
/// the detected list instead.
export function AgentTabStrip({ selected, onSelect, payload, currency }: Props) {
  const providers = detectedProviders(payload)
  if (providers.length < 2) return null

  const detected = payload?.current.providers ?? {}
  const visible = ALL_PROVIDERS.filter(p => p.id === 'all' || providers.includes(p.id))

  return (
    <nav className="agent-tabs" aria-label="Provider">
      {visible.map(p => {
        const cost = p.id === 'all'
          ? providers.reduce((s, id) => s + (detected[id] ?? 0), 0)
          : (detected[p.id] ?? 0)
        const active = selected === p.id
        return (
          <button
            key={p.id}
            type="button"
            className={`tab ${active ? 'tab-active' : ''}`}
            aria-pressed={active}
            onClick={() => onSelect(p.id)}
          >
            <span className="tab-label">{p.label}</span>
            {cost > 0 && (
              <span className="tab-cost">{formatCompactCurrency(cost, currency)}</span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
