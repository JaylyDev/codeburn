import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ProviderGlyph } from './providerIcons'
import {
  DETAIL_INSETS,
  M,
  MOTION,
  bezier,
  bubblePath,
  displayLabel,
  headlineWindow,
  pct,
  railHeight,
  railPath,
  resetsIn,
  severity,
  type QuotaWindow,
  type Severity,
} from './dockGeometry'
import './dock.css'

const REFRESH_MS = 5 * 60 * 1000
const MAX_DETAIL_ROWS = 5

const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'GitHub Copilot',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
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

type Rect = { x: number; y: number; w: number; h: number }
type DockFrame = {
  rail: Rect
  anchor: 'start' | 'end'
  detail: (Rect & { tailY: number }) | null
}

/// Port of CapacityDockInteractionState: the immediate truth that decides whether a delayed
/// hover action is still valid when its timer fires.
type Interaction = {
  railHovered: boolean
  detailHovered: boolean
  pinned: boolean
  collapseGrace: boolean
}
const REST: Interaction = { railHovered: false, detailHovered: false, pinned: false, collapseGrace: false }
const isExpanded = (i: Interaction) => i.pinned || i.railHovered || i.detailHovered || i.collapseGrace
const canCollapse = (i: Interaction) => !i.pinned && !i.railHovered && !i.detailHovered && !i.collapseGrace

type DetailPhase = 'entering' | 'shown' | 'dismissing'

function useTimers() {
  const timers = useRef<Record<string, number>>({})
  const cancel = useCallback((name: string) => {
    window.clearTimeout(timers.current[name])
    delete timers.current[name]
  }, [])
  const schedule = useCallback(
    (name: string, ms: number, fn: () => void) => {
      cancel(name)
      timers.current[name] = window.setTimeout(() => {
        delete timers.current[name]
        fn()
      }, ms)
    },
    [cancel]
  )
  useEffect(() => {
    const all = timers.current
    return () => Object.values(all).forEach((id) => window.clearTimeout(id))
  }, [])
  return { schedule, cancel }
}

/// The rail's presentation progress, 0 at rest and 1 expanded, eased with the mac's rail
/// curves. A reversal restarts from the current value so a quick exit never snaps.
function useRailProgress(target: 0 | 1, onSettled: (value: 0 | 1) => void): number {
  const [progress, setProgress] = useState<number>(target)
  const live = useRef<{ value: number; raf: number }>({ value: target, raf: 0 })
  const settled = useRef(onSettled)
  settled.current = onSettled
  useEffect(() => {
    const from = live.current.value
    if (from === target) return
    const motion = target === 1 ? MOTION.railExpand : MOTION.railCollapse
    const start = performance.now()
    const step = (now: number) => {
      const linear = Math.min(1, (now - start) / motion.duration)
      const value = from + (target - from) * bezier(motion.curve, linear)
      live.current.value = value
      setProgress(value)
      if (linear < 1) {
        live.current.raf = requestAnimationFrame(step)
      } else {
        settled.current(target)
      }
    }
    cancelAnimationFrame(live.current.raf)
    live.current.raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(live.current.raf)
  }, [target])
  return progress
}

const RING_COLORS: Record<Severity, string> = {
  normal: '#30D158',
  warning: '#FFD60A',
  critical: '#FF9F0A',
  danger: '#FF453A',
}

function Ring({ percent }: { percent: number | null }) {
  const size = M.ringSize
  const stroke = M.ringStroke
  // Strokes are centred on the ring's circle like SwiftUI's, so the box gets a margin for them.
  const margin = 3
  const box = size + margin * 2
  const c = box / 2
  const r = size / 2
  const circumference = 2 * Math.PI * r
  const amount = percent === null ? 0 : Math.min(1, Math.max(0, percent / 100))
  return (
    <svg className="dock-ring" width={box} height={box} viewBox={`0 0 ${box} ${box}`} aria-hidden="true">
      <defs>
        <linearGradient id="dock-ring-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.07" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.12" />
        </linearGradient>
      </defs>
      <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(0,0,0,0.74)" strokeWidth={stroke + 1.2} />
      <circle cx={c} cy={c} r={r} fill="none" stroke="url(#dock-ring-sheen)" strokeWidth={stroke + 0.36} />
      {percent === null ? (
        <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.24)" strokeWidth={1.2} strokeDasharray="1.8 2.4" />
      ) : (
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={RING_COLORS[severity(percent)]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * amount} ${circumference}`}
          transform={`rotate(-90 ${c} ${c})`}
          className="dock-ring-arc"
        />
      )}
    </svg>
  )
}

type RowProps = {
  provider: Provider
  loading: boolean
  opacity: number
  offset: number
  onEnter: () => void
  onLeave: () => void
  onClick: () => void
}

function Row({ provider, loading, opacity, offset, onEnter, onLeave, onClick }: RowProps) {
  const headline = provider.available ? headlineWindow(provider.windows) : null
  const percent = headline ? pct(headline.usedPct) : null
  const sev = percent === null ? null : severity(percent)
  return (
    <button
      type="button"
      className="dock-row"
      style={{ opacity, transform: `translateY(${offset}px)` }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      aria-label={`${provider.name} usage`}
    >
      <span className="dock-gauge">
        <Ring percent={percent} />
        <span className={`dock-glyph${loading ? ' is-loading' : ''}`}>
          <ProviderGlyph id={provider.id} size={M.providerIconSize} />
        </span>
        {provider.error ? <span className="dock-row-alert" /> : null}
      </span>
      <span className={`dock-pct${sev ? ` is-${sev}` : ' is-empty'}`}>{percent === null ? '--' : `${percent}%`}</span>
    </button>
  )
}

function instruction(provider: Provider, quota: DockQuota | null): string {
  if (quota?.state === 'cliOutdated') return 'CLI update needed for live quota. Run npm install -g codeburn.'
  if (quota?.state === 'unavailable') return quota.message || 'Quota is unavailable right now.'
  return `Sign in with the ${provider.name} app or CLI. The dock checks again every five minutes.`
}

function Detail({ provider, quota, loading }: { provider: Provider; quota: DockQuota | null; loading: boolean }) {
  const windows = provider.windows.slice(0, MAX_DETAIL_ROWS)
  return (
    <div className="dock-detail-body">
      <header className="dock-detail-head">
        <span className="dock-detail-glyph">
          <ProviderGlyph id={provider.id} size={Math.round(24 * 0.9)} />
        </span>
        <span className="dock-detail-title">{provider.name} Usage</span>
        {provider.plan ? <span className="dock-detail-plan">{provider.plan}</span> : null}
      </header>

      {loading ? <p className="dock-conn is-loading">Refreshing…</p> : null}
      {!loading && provider.error ? (
        <div className="dock-conn-block">
          <p className="dock-conn is-failed">Reconnect required</p>
          <p className="dock-conn-reason">{provider.error}</p>
          <p className="dock-conn-hint">{instruction(provider, quota)}</p>
        </div>
      ) : null}
      {!loading && !provider.error && !provider.available ? (
        <div className="dock-conn-block">
          <p className="dock-conn is-disconnected">Not connected</p>
          <p className="dock-conn-instruction">{instruction(provider, quota)}</p>
        </div>
      ) : null}

      {provider.available
        ? windows.map((row) => {
            const used = pct(row.usedPct)
            const resets = resetsIn(row.resetsAt)
            return (
              <div className="dock-window" key={`${provider.id}-${row.label}`}>
                <div className="dock-window-top">
                  <span className="dock-window-label">{displayLabel(row.label)}</span>
                  <span className="dock-window-pct">{used}%</span>
                </div>
                <div className="dock-track">
                  <div className={`dock-fill is-${severity(used)}`} style={{ width: `max(2px, ${used}%)` }} />
                </div>
                {resets ? <span className="dock-window-resets">Resets in {resets}</span> : null}
              </div>
            )
          })
        : null}
    </div>
  )
}

export function Dock() {
  const [quota, setQuota] = useState<DockQuota | null>(null)
  const [preferredId, setPreferredId] = useState<string | null>(null)
  const [interaction, setInteraction] = useState<Interaction>(REST)
  const [presentationExpanded, setPresentationExpanded] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [detailPhase, setDetailPhase] = useState<DetailPhase>('entering')
  const [detailHeight, setDetailHeight] = useState(0)
  const [frame, setFrame] = useState<DockFrame | null>(null)
  const { schedule, cancel } = useTimers()

  const interactionRef = useRef(interaction)
  interactionRef.current = interaction
  const hoveredRef = useRef(hovered)
  hoveredRef.current = hovered
  const phaseRef = useRef(detailPhase)
  phaseRef.current = detailPhase
  const pointerInsideRail = useRef(false)
  const detailRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      setQuota(await invoke<DockQuota>('dock_quota'))
    } catch (err) {
      setQuota({ state: 'unavailable', message: String(err) })
    }
  }, [])

  useEffect(() => {
    void load()
    void invoke<string | null>('dock_preferred').then((id) => setPreferredId(id ?? null))
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    const unlisten = listen('codeburn://dock-refresh', () => void load())
    return () => {
      window.clearInterval(timer)
      void unlisten.then((f) => f())
    }
  }, [load])

  // Providers: the ones the CLI reports signed in, else the preferred one as a dashed stand-in.
  const all = quota?.state === 'ready' ? quota.providers : []
  const available = all.filter((p) => p.available)
  const resolvedPreferredId = preferredId ?? available[0]?.id ?? all[0]?.id ?? 'claude'
  const preferred: Provider = all.find((p) => p.id === resolvedPreferredId) ?? {
    id: resolvedPreferredId,
    name: PROVIDER_NAMES[resolvedPreferredId] ?? resolvedPreferredId,
    available: false,
    windows: [],
  }
  const selected = available.length > 0 ? available : [preferred]
  const displayed = presentationExpanded
    ? [preferred, ...selected.filter((p) => p.id !== preferred.id)]
    : [preferred]
  const anchor = frame?.anchor ?? 'start'
  const ordered = anchor === 'end' ? [...displayed].reverse() : displayed
  const loading = quota === null

  const expanded = isExpanded(interaction)
  useEffect(() => {
    if (expanded) setPresentationExpanded(true)
  }, [expanded])
  const progress = useRailProgress(expanded ? 1 : 0, (value) => {
    if (value === 0) setPresentationExpanded(false)
  })

  // Detail lifecycle, port of showDetail / hideDetail / dismissDetail.
  const showDetail = useCallback(
    (id: string) => {
      cancel('detailDismiss')
      if (hoveredRef.current === id) {
        if (phaseRef.current === 'dismissing') setDetailPhase('shown')
        return
      }
      setHovered(id)
      setDetailPhase(hoveredRef.current && phaseRef.current === 'shown' ? 'shown' : 'entering')
    },
    [cancel]
  )
  const hideDetail = useCallback(() => {
    if (!hoveredRef.current) return
    setDetailPhase('dismissing')
    schedule('detailDismiss', MOTION.detailDismiss.duration, () => {
      setHovered(null)
      setDetailPhase('entering')
    })
  }, [schedule])

  const scheduleCollapse = useCallback(() => {
    schedule('collapse', MOTION.railHoverCloseDelay, () => {
      setInteraction((i) => ({ ...i, collapseGrace: false }))
      const next = { ...interactionRef.current, collapseGrace: false }
      if (canCollapse(next)) hideDetail()
    })
  }, [schedule, hideDetail])

  const onRailEnter = () => {
    pointerInsideRail.current = true
    cancel('expand')
    cancel('collapse')
    schedule('expand', MOTION.railHoverOpenDelay, () => {
      if (!pointerInsideRail.current) return
      setInteraction((i) => ({ ...i, railHovered: true, collapseGrace: false }))
    })
  }
  const onRailLeave = () => {
    pointerInsideRail.current = false
    cancel('expand')
    setInteraction((i) => ({ ...i, railHovered: false, collapseGrace: true }))
    scheduleCollapse()
  }
  const onRowEnter = (id: string) => {
    cancel('detailShow')
    cancel('detailExit')
    // Re-entering a row aborts a pending collapse; a row exit must not touch it.
    cancel('collapse')
    schedule('detailShow', MOTION.detailShowDelay, () => showDetail(id))
  }
  const onRowLeave = (id: string) => {
    cancel('detailShow')
    if (hoveredRef.current !== id) return
    // Enough time to cross the transparent gap into the bubble.
    schedule('detailExit', MOTION.detailExitDelay, () => {
      if (interactionRef.current.detailHovered) return
      hideDetail()
      scheduleCollapse()
    })
  }
  const onDetailEnter = () => {
    cancel('collapse')
    cancel('detailExit')
    setInteraction((i) => ({ ...i, detailHovered: true }))
    if (phaseRef.current === 'dismissing') {
      cancel('detailDismiss')
      setDetailPhase('shown')
    }
  }
  const onDetailLeave = () => {
    setInteraction((i) => ({ ...i, detailHovered: false }))
    scheduleCollapse()
  }
  const onRowClick = (provider: Provider) => {
    cancel('expand')
    cancel('collapse')
    if (provider.id !== resolvedPreferredId) {
      setPreferredId(provider.id)
      void invoke('dock_set_preferred', { id: provider.id })
      setInteraction((i) => (i.pinned ? i : { ...i, pinned: true }))
    } else {
      setInteraction((i) => ({ ...i, pinned: !i.pinned }))
    }
    showDetail(provider.id)
  }
  const dismiss = useCallback(() => {
    ;['expand', 'collapse', 'detailShow', 'detailExit'].forEach(cancel)
    setInteraction(REST)
    hideDetail()
  }, [cancel, hideDetail])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isExpanded(interactionRef.current)) dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismiss])

  // The bubble is laid out at its natural height first; the window is sized from that.
  useLayoutEffect(() => {
    if (!hovered) {
      setDetailHeight(0)
      return
    }
    const el = detailRef.current
    if (el) setDetailHeight(Math.ceil(el.offsetHeight))
  }, [hovered, quota])

  const rows = ordered.length
  const detailRow = hovered ? ordered.findIndex((p) => p.id === hovered) : -1
  const detailRequest = hovered && detailHeight > 0 && detailRow >= 0 ? { row: detailRow, height: detailHeight } : null
  useEffect(() => {
    let stale = false
    void invoke<DockFrame>('dock_set_layout', {
      request: { rows, expanded: presentationExpanded, detail: detailRequest },
    }).then((next) => {
      if (!stale) setFrame(next)
    })
    return () => {
      stale = true
    }
    // detailRequest is derived from the two scalars below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, presentationExpanded, detailRow, detailHeight])

  // Entering: the card is placed while invisible, then slides in on the next frame.
  const detailPlaced = frame?.detail != null && detailRequest != null
  useEffect(() => {
    if (detailPhase !== 'entering' || !detailPlaced) return
    const raf = requestAnimationFrame(() => setDetailPhase('shown'))
    return () => cancelAnimationFrame(raf)
  }, [detailPhase, detailPlaced])

  const restLength = railHeight(1)
  const targetLength = railHeight(rows)
  const bodyLength = Math.round(restLength + (targetLength - restLength) * progress)
  const railRect = frame?.rail ?? { x: 0, y: 0, w: M.railWidth, h: restLength }
  const railTop = anchor === 'end' ? railRect.y + railRect.h - bodyLength : railRect.y
  const shape = railPath(M.railWidth, bodyLength)

  const hoveredProvider = hovered ? (ordered.find((p) => p.id === hovered) ?? null) : null
  const detailFrame = frame?.detail ?? null
  const detailW = M.detailWidth
  const detailH = detailHeight
  const tailY = detailFrame ? detailFrame.tailY : detailH / 2

  return (
    <div className="dock" onContextMenu={(e) => { e.preventDefault(); void invoke('dock_context_menu') }}>
      <div
        className="dock-rail"
        style={{ top: railTop, width: M.railWidth, height: bodyLength, clipPath: `path('${shape}')` }}
        onMouseEnter={onRailEnter}
        onMouseLeave={onRailLeave}
      >
        <svg className="dock-surface" width={M.railWidth} height={bodyLength} viewBox={`0 0 ${M.railWidth} ${bodyLength}`} aria-hidden="true">
          <defs>
            <linearGradient id="dock-rail-fill" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#131416" />
              <stop offset="0.46" stopColor="#09090A" />
              <stop offset="1" stopColor="#030304" />
            </linearGradient>
            <radialGradient id="dock-rail-glow" cx="0" cy="0" r="180" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff" stopOpacity="0.055" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="dock-rail-edge" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0.05" />
              <stop offset="0.55" stopColor="#fff" stopOpacity="0.09" />
              <stop offset="0.86" stopColor="#fff" stopOpacity="0.14" />
              <stop offset="1" stopColor="#fff" stopOpacity="0.08" />
            </linearGradient>
          </defs>
          <path d={shape} fill="url(#dock-rail-fill)" />
          <path d={shape} fill="url(#dock-rail-glow)" />
          <path d={shape} fill="none" stroke="url(#dock-rail-edge)" strokeWidth="0.6" />
        </svg>
        <div
          className="dock-rows"
          style={anchor === 'end' ? { bottom: M.railAlongPad } : { top: M.railAlongPad }}
        >
          {ordered.map((provider) => {
            const isPreferred = provider.id === preferred.id
            return (
              <Row
                key={provider.id}
                provider={provider}
                loading={loading}
                opacity={isPreferred ? 1 : progress}
                offset={isPreferred ? 0 : M.rowReveal * (1 - progress)}
                onEnter={() => onRowEnter(provider.id)}
                onLeave={() => onRowLeave(provider.id)}
                onClick={() => onRowClick(provider)}
              />
            )
          })}
        </div>
      </div>

      {hoveredProvider ? (
        <div
          ref={detailRef}
          className={`dock-detail is-${detailPhase}${detailPlaced ? '' : ' is-measuring'}`}
          style={{
            left: detailFrame?.x ?? 0,
            top: detailFrame?.y ?? 0,
            width: detailW,
            paddingRight: DETAIL_INSETS.horizontal + DETAIL_INSETS.tail,
          }}
          onMouseEnter={onDetailEnter}
          onMouseLeave={onDetailLeave}
        >
          {detailH > 0 ? (
            <svg className="dock-surface" width={detailW} height={detailH} viewBox={`0 0 ${detailW} ${detailH}`} aria-hidden="true">
              <path d={bubblePath(detailW, detailH, tailY)} fill="url(#dock-rail-fill)" />
              <path d={bubblePath(detailW, detailH, tailY)} fill="url(#dock-rail-glow)" />
              <path d={bubblePath(detailW, detailH, tailY)} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="0.9" />
            </svg>
          ) : null}
          <Detail provider={hoveredProvider} quota={quota} loading={loading} />
        </div>
      ) : null}
    </div>
  )
}
