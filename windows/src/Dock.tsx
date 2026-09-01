import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './dock.css'

const REFRESH_MS = 5 * 60 * 1000
const HOVER_CLOSE_MS = 180

type QuotaWindow = {
  label: string
  usedPct: number
  resetsAt?: string
}

type Provider = {
  id: string
  name: string
  available: boolean
  plan?: string
  windows: QuotaWindow[]
  error?: string
}

type DockQuota =
  | { state: 'ready'; providers: Provider[] }
  | { state: 'cliOutdated' }
  | { state: 'unavailable'; message: string }

const RING_SIZE = 32
const RING_STROKE = 3
const RADIUS = (RING_SIZE - RING_STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function headline(provider: Provider): QuotaWindow | null {
  if (provider.windows.length === 0) return null
  return provider.windows.reduce((worst, row) => (row.usedPct > worst.usedPct ? row : worst))
}

// Whole percentage points, matching the mac dock's rounded metrics.
function pct(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)))
}

function resetsIn(iso?: string): string {
  if (!iso) return ''
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  if (Number.isNaN(seconds)) return ''
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

function Ring({ provider }: { provider: Provider }) {
  const top = headline(provider)
  const used = top ? pct(top.usedPct) : 0
  return (
    <div className="dock-row" data-provider={provider.id} title={provider.name}>
      <svg className="dock-ring" width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
        <circle
          className="dock-ring-track"
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          strokeWidth={RING_STROKE}
        />
        <circle
          className="dock-ring-arc"
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          strokeWidth={RING_STROKE}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - used / 100)}
        />
      </svg>
      <span className={`dock-pct${used >= 90 ? ' is-spent' : ''}`}>{top ? `${used}%` : '--'}</span>
    </div>
  )
}

function notice(quota: DockQuota | null, providers: Provider[]): string | null {
  if (quota?.state === 'cliOutdated') return 'CLI update needed for live quota. Run npm install -g codeburn.'
  if (quota?.state === 'unavailable') return 'Quota is unavailable right now.'
  if (quota?.state === 'ready' && providers.length === 0) return 'No signed in providers to show.'
  return null
}

function Detail({ providers, message }: { providers: Provider[]; message: string | null }) {
  return (
    <div className="dock-detail">
      {message ? <p className="dock-notice">{message}</p> : null}
      {providers.map((provider) => (
        <section className="dock-detail-card" key={provider.id} data-provider={provider.id}>
          <header className="dock-detail-head">
            <span className="dock-detail-name">{provider.name}</span>
            {provider.plan ? <span className="dock-detail-plan">{provider.plan}</span> : null}
          </header>
          {provider.windows.map((row) => {
            const used = pct(row.usedPct)
            const resets = resetsIn(row.resetsAt)
            return (
              <div className="dock-window" key={`${provider.id}-${row.label}`}>
                <div className="dock-window-top">
                  <span className="dock-window-label">{row.label}</span>
                  <span className="dock-window-pct">{used}%</span>
                </div>
                <div className="dock-track">
                  <div className="dock-fill" style={{ width: `${used}%` }} />
                </div>
                {resets ? <span className="dock-window-resets">Resets in {resets}</span> : null}
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}

export function Dock() {
  const [quota, setQuota] = useState<DockQuota | null>(null)
  const [expanded, setExpanded] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      setQuota(await invoke<DockQuota>('dock_quota'))
    } catch (err) {
      setQuota({ state: 'unavailable', message: String(err) })
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const providers =
    quota?.state === 'ready' ? quota.providers.filter((provider) => provider.available) : []
  const rows = Math.max(providers.length, 1)

  useEffect(() => {
    void invoke('dock_set_layout', { rows, expanded })
  }, [rows, expanded])

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  const message = notice(quota, providers)

  const open = () => {
    window.clearTimeout(closeTimer.current)
    if (providers.length > 0 || message) setExpanded(true)
  }

  // A short grace period keeps the panel from flickering shut as the pointer crosses the
  // seam between the rail and the panel.
  const close = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setExpanded(false), HOVER_CLOSE_MS)
  }

  return (
    <div className={`dock${expanded ? ' is-expanded' : ''}`} onMouseEnter={open} onMouseLeave={close}>
      {expanded ? <Detail providers={providers} message={message} /> : null}
      <div className="dock-rail" onDoubleClick={() => void load()}>
        {providers.map((provider) => (
          <Ring provider={provider} key={provider.id} />
        ))}
        {providers.length === 0 ? (
          <div className="dock-row">
            <span className="dock-quiet">{quota?.state === 'cliOutdated' ? 'CLI' : '--'}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
