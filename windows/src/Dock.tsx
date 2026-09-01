import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ProviderGlyph } from './providerIcons'
import {
  M,
  MOTION,
  alongPad,
  bezier,
  bubblePath,
  detailPadding,
  displayLabel,
  headlineWindow,
  isVertical,
  opposite,
  pct,
  railLength,
  railPath,
  resetsIn,
  severity,
  type Curve,
  type Edge,
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
  edge: Edge
  vertical: boolean
  docked: boolean
  alongPad: number
  anchor: 'start' | 'end'
  bubbleSide: Edge
  detail: (Rect & { tail: number }) | null
  nativePointer: boolean
}
type PointerSnapshot = { railHovered: boolean; row: number | null; detailHovered: boolean }
const NO_POINTER: PointerSnapshot = { railHovered: false, row: null, detailHovered: false }

/// Port of CapacityDockInteractionState: the immediate truth that decides whether a delayed
/// hover action is still valid when its timer fires.
type Interaction = {
  railHovered: boolean
  detailHovered: boolean
  pinned: boolean
  collapseGrace: boolean
  dragging: boolean
}
const REST: Interaction = { railHovered: false, detailHovered: false, pinned: false, collapseGrace: false, dragging: false }
const isExpanded = (i: Interaction) => i.pinned || i.railHovered || i.detailHovered || i.collapseGrace
const canCollapse = (i: Interaction) => !i.pinned && !i.railHovered && !i.detailHovered && !i.collapseGrace && !i.dragging

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

type Motion = { duration: number; curve: Curve }

/// A value eased toward its target with the mac's curves. A retarget restarts from the current
/// value so a quick reversal never snaps.
function useEased(target: number, motionFor: (from: number, to: number) => Motion, onSettled?: (value: number) => void): number {
  const [value, setValue] = useState(target)
  const live = useRef<{ value: number; raf: number }>({ value: target, raf: 0 })
  const settled = useRef(onSettled)
  settled.current = onSettled
  const pick = useRef(motionFor)
  pick.current = motionFor
  useEffect(() => {
    const from = live.current.value
    if (from === target) return
    const motion = pick.current(from, target)
    const start = performance.now()
    const step = (now: number) => {
      const linear = Math.min(1, (now - start) / motion.duration)
      const next = from + (target - from) * bezier(motion.curve, linear)
      live.current.value = next
      setValue(next)
      if (linear < 1) {
        live.current.raf = requestAnimationFrame(step)
      } else {
        settled.current?.(target)
      }
    }
    cancelAnimationFrame(live.current.raf)
    live.current.raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(live.current.raf)
  }, [target])
  return value
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
  style: CSSProperties
  onEnter: () => void
  onLeave: () => void
  onClick: () => void
}

function Row({ provider, loading, style, onEnter, onLeave, onClick }: RowProps) {
  const headline = provider.available ? headlineWindow(provider.windows) : null
  const percent = headline ? pct(headline.usedPct) : null
  const sev = percent === null ? null : severity(percent)
  return (
    <button
      type="button"
      className="dock-row"
      style={style}
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

const RAIL_MOTION = (_from: number, to: number) => (to === 1 ? MOTION.railExpand : MOTION.railCollapse)
const ATTACH_MOTION = (_from: number, to: number) => (to === 1 ? MOTION.dockAttach : MOTION.dockDetach)

export function Dock() {
  const [quota, setQuota] = useState<DockQuota | null>(null)
  const [preferredId, setPreferredId] = useState<string | null>(null)
  const [interaction, setInteraction] = useState<Interaction>(REST)
  const [presentationExpanded, setPresentationExpanded] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [detailPhase, setDetailPhase] = useState<DetailPhase>('entering')
  const [detailHeight, setDetailHeight] = useState(0)
  const [frame, setFrame] = useState<DockFrame | null>(null)
  // Attachment while dragging comes straight from the cursor poll; otherwise it eases.
  const [dragAttachment, setDragAttachment] = useState<number | null>(null)
  // Where the rail was before a settle, relative to the new window, so it can glide in.
  const [glide, setGlide] = useState<{ dx: number; dy: number; key: number } | null>(null)
  const { schedule, cancel } = useTimers()

  const interactionRef = useRef(interaction)
  interactionRef.current = interaction
  const hoveredRef = useRef(hovered)
  hoveredRef.current = hovered
  const phaseRef = useRef(detailPhase)
  phaseRef.current = detailPhase
  const pointerRef = useRef<PointerSnapshot>(NO_POINTER)
  const orderedRef = useRef<Provider[]>([])
  const detailRef = useRef<HTMLDivElement>(null)
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null)
  const suppressClick = useRef(false)

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
    return () => window.clearInterval(timer)
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
  orderedRef.current = ordered
  const loading = quota === null

  const expanded = isExpanded(interaction)
  useEffect(() => {
    if (expanded) setPresentationExpanded(true)
  }, [expanded])
  const progress = useEased(expanded ? 1 : 0, RAIL_MOTION, (value) => {
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
  const hideDetail = useCallback(
    (animated = true) => {
      if (!hoveredRef.current) return
      if (!animated) {
        cancel('detailDismiss')
        setHovered(null)
        setDetailPhase('entering')
        return
      }
      setDetailPhase('dismissing')
      schedule('detailDismiss', MOTION.detailDismiss.duration, () => {
        setHovered(null)
        setDetailPhase('entering')
      })
    },
    [cancel, schedule]
  )

  const scheduleCollapse = useCallback(() => {
    schedule('collapse', MOTION.railHoverCloseDelay, () => {
      setInteraction((i) => ({ ...i, collapseGrace: false }))
      const next = { ...interactionRef.current, collapseGrace: false }
      if (canCollapse(next)) hideDetail()
    })
  }, [schedule, hideDetail])

  const railHoverChanged = useCallback(
    (hovering: boolean) => {
      if (interactionRef.current.dragging) return
      cancel('expand')
      cancel('collapse')
      if (hovering) {
        schedule('expand', MOTION.railHoverOpenDelay, () => {
          if (!pointerRef.current.railHovered) return
          setInteraction((i) => ({ ...i, railHovered: true, collapseGrace: false }))
        })
      } else {
        setInteraction((i) => ({ ...i, railHovered: false, collapseGrace: true }))
        scheduleCollapse()
      }
    },
    [cancel, schedule, scheduleCollapse]
  )
  const rowHoverChanged = useCallback(
    (id: string, hovering: boolean) => {
      if (interactionRef.current.dragging) return
      cancel('detailShow')
      cancel('detailExit')
      if (hovering) {
        // Re-entering a row aborts a pending collapse; a row exit must not touch it.
        cancel('collapse')
        schedule('detailShow', MOTION.detailShowDelay, () => showDetail(id))
      } else if (hoveredRef.current === id) {
        // Enough time to cross the transparent gap into the bubble.
        schedule('detailExit', MOTION.detailExitDelay, () => {
          if (interactionRef.current.detailHovered) return
          hideDetail()
          scheduleCollapse()
        })
      }
    },
    [cancel, schedule, showDetail, hideDetail, scheduleCollapse]
  )
  const detailHoverChanged = useCallback(
    (hovering: boolean) => {
      if (interactionRef.current.dragging) return
      cancel('collapse')
      cancel('detailExit')
      setInteraction((i) => ({ ...i, detailHovered: hovering }))
      if (hovering && phaseRef.current === 'dismissing') {
        cancel('detailDismiss')
        setDetailPhase('shown')
      } else if (!hovering) {
        scheduleCollapse()
      }
    },
    [cancel, scheduleCollapse]
  )

  // One entry point for hover, fed by the cursor poll on Windows and by DOM events elsewhere,
  // the way the mac synthesizes hover from its event monitor.
  const applyPointer = useCallback(
    (next: PointerSnapshot) => {
      const prev = pointerRef.current
      pointerRef.current = next
      const rows = orderedRef.current
      if (next.detailHovered !== prev.detailHovered) detailHoverChanged(next.detailHovered)
      if (next.railHovered !== prev.railHovered) railHoverChanged(next.railHovered)
      if (next.row !== prev.row) {
        const before = prev.row === null ? null : rows[prev.row]
        const after = next.row === null ? null : rows[next.row]
        if (before) rowHoverChanged(before.id, false)
        if (after) rowHoverChanged(after.id, true)
      }
    },
    [detailHoverChanged, railHoverChanged, rowHoverChanged]
  )
  const nativePointer = frame?.nativePointer ?? false
  const domPointer = (patch: Partial<PointerSnapshot>) => {
    if (nativePointer) return
    applyPointer({ ...pointerRef.current, ...patch })
  }

  const dismiss = useCallback(() => {
    ;['expand', 'collapse', 'detailShow', 'detailExit'].forEach(cancel)
    setInteraction((i) => ({ ...REST, dragging: i.dragging }))
    hideDetail()
  }, [cancel, hideDetail])

  useEffect(() => {
    const listeners = [
      listen('codeburn://dock-refresh', () => void load()),
      listen<PointerSnapshot>('codeburn://dock-pointer', (event) => applyPointer(event.payload)),
      listen<{ attachment: number }>('codeburn://dock-drag', (event) => setDragAttachment(event.payload.attachment)),
      listen<{ from: Rect; frame: DockFrame }>('codeburn://dock-settled', (event) => {
        const { from, frame: next } = event.payload
        setFrame(next)
        setDragAttachment(null)
        setGlide({ dx: from.x - next.rail.x, dy: from.y - next.rail.y, key: Date.now() })
        // A re-homed rail starts from a clean hover: the bubble is gone on the Rust side, and
        // the poll re-derives hover from the settled geometry on its next tick.
        ;['expand', 'collapse', 'detailShow', 'detailExit'].forEach(cancel)
        hideDetail(false)
        setInteraction((i) => ({ ...REST, pinned: i.pinned }))
        pointerRef.current = NO_POINTER
      }),
    ]
    return () => {
      listeners.forEach((p) => void p.then((unlisten) => unlisten()))
    }
  }, [load, applyPointer, cancel, hideDetail])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isExpanded(interactionRef.current)) dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismiss])

  // Dragging: the page owns the 3 px threshold, the cursor poll owns the rest.
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return
    suppressClick.current = false
    press.current = { x: event.clientX, y: event.clientY, dragged: false }
    // The rail is narrow; the first move often lands outside it, so keep the pointer here.
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onClickCapture = (event: ReactMouseEvent) => {
    if (!suppressClick.current) return
    suppressClick.current = false
    event.stopPropagation()
  }
  const onPointerMove = (event: ReactPointerEvent) => {
    const start = press.current
    if (!start || start.dragged) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= MOTION.dragThreshold) return
    start.dragged = true
    suppressClick.current = true
    ;['expand', 'collapse', 'detailShow', 'detailExit'].forEach(cancel)
    hideDetail(false)
    setInteraction((i) => ({ ...i, dragging: true, railHovered: false, detailHovered: false, collapseGrace: false }))
    // The press point, not the cursor when the command lands: the rail must stay under the
    // finger exactly where it was grabbed.
    void invoke('dock_begin_drag', { x: Math.round(start.x), y: Math.round(start.y) })
  }
  const onPointerUp = () => {
    press.current = null
  }

  const onRowClick = (provider: Provider) => {
    if (interactionRef.current.dragging) return
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

  // The bubble is laid out at its natural height first; its frame is computed from that.
  useLayoutEffect(() => {
    if (!hovered) {
      setDetailHeight(0)
      return
    }
    const el = detailRef.current
    if (el) setDetailHeight(Math.ceil(el.offsetHeight))
  }, [hovered, quota])

  const rows = ordered.length
  const totalRows = Math.max(selected.length, 1)
  const detailRow = hovered ? ordered.findIndex((p) => p.id === hovered) : -1
  const detailRequest = hovered && detailHeight > 0 && detailRow >= 0 ? { row: detailRow, height: detailHeight } : null
  useEffect(() => {
    let stale = false
    void invoke<DockFrame>('dock_set_layout', {
      request: { rows, totalRows, expanded: presentationExpanded, detail: detailRequest },
    }).then((next) => {
      if (!stale) setFrame(next)
    })
    return () => {
      stale = true
    }
    // detailRequest is derived from the two scalars below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, totalRows, presentationExpanded, detailRow, detailHeight])

  // Entering: the card is placed while invisible, then slides in on the next frame.
  const detailPlaced = frame?.detail != null && detailRequest != null
  useEffect(() => {
    if (detailPhase !== 'entering' || !detailPlaced) return
    const raf = requestAnimationFrame(() => setDetailPhase('shown'))
    return () => cancelAnimationFrame(raf)
  }, [detailPhase, detailPlaced])

  // Attachment: 1 docked, 0 loose. Eases home after a drop; tracks the poll during a drag.
  const attachmentTarget = frame?.docked ? 1 : 0
  const easedAttachment = useEased(attachmentTarget, ATTACH_MOTION)
  const attachment = dragAttachment ?? easedAttachment

  // Glide: after a settle the rail starts where it was dropped and eases into place.
  const glideKey = glide?.key ?? 0
  const glideProgress = useEased(glideKey ? 1 : 0, () => (frame?.docked ? MOTION.dockAttach : MOTION.dockDetach))
  const glideDx = glide ? glide.dx * (1 - glideProgress) : 0
  const glideDy = glide ? glide.dy * (1 - glideProgress) : 0
  useEffect(() => {
    if (glide && glideProgress >= 1) setGlide(null)
  }, [glide, glideProgress])

  const edge: Edge = frame?.edge ?? 'right'
  const vertical = frame?.vertical ?? true
  const cross = vertical ? M.railWidth : M.horizontalRailWidth
  const pad = alongPad(attachment)
  const restLength = railLength(1, attachment)
  const targetLength = railLength(rows, attachment)
  const bodyLength = Math.round(restLength + (targetLength - restLength) * progress)
  const railRect = frame?.rail ?? { x: 0, y: 0, w: cross, h: restLength }
  // The frame's rail is the target; the visual rail grows from the anchored end toward it.
  const railTarget = vertical ? railRect.h : railRect.w
  const alongOffset = anchor === 'end' ? railTarget - bodyLength : 0
  const railLeft = (vertical ? railRect.x : railRect.x + alongOffset) + glideDx
  const railTop = (vertical ? railRect.y + alongOffset : railRect.y) + glideDy
  const railW = vertical ? cross : bodyLength
  const railH = vertical ? bodyLength : cross
  const shape = railPath(edge, cross, bodyLength, attachment)

  const hoveredProvider = hovered ? (ordered.find((p) => p.id === hovered) ?? null) : null
  const detailFrame = frame?.detail ?? null
  const tailEdge = opposite(frame?.bubbleSide ?? 'left')
  const detailW = M.detailWidth
  const detailH = detailHeight
  const tail = detailFrame ? detailFrame.tail : (isVertical(tailEdge) ? detailH : detailW) / 2

  const rowsStyle: CSSProperties = vertical
    ? { flexDirection: 'column', left: M.railCrossPad, right: M.railCrossPad, ...(anchor === 'end' ? { bottom: pad } : { top: pad }) }
    : { flexDirection: 'row', top: M.railCrossPad, bottom: M.railCrossPad, ...(anchor === 'end' ? { right: pad } : { left: pad }) }

  return (
    <div className="dock" onContextMenu={(e) => { e.preventDefault(); void invoke('dock_context_menu') }}>
      <div
        className={`dock-rail${interaction.dragging ? ' is-dragging' : ''}`}
        style={{ left: railLeft, top: railTop, width: railW, height: railH, clipPath: `path('${shape}')` }}
        onMouseEnter={() => domPointer({ railHovered: true })}
        onMouseLeave={() => domPointer({ railHovered: false, row: null })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
      >
        <svg className="dock-surface" width={railW} height={railH} viewBox={`0 0 ${railW} ${railH}`} aria-hidden="true">
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
        <div className="dock-rows" style={rowsStyle}>
          {ordered.map((provider, index) => {
            const isPreferred = provider.id === preferred.id
            const reveal = isPreferred ? 0 : M.rowReveal * (1 - progress)
            return (
              <Row
                key={provider.id}
                provider={provider}
                loading={loading}
                style={{
                  width: vertical ? cross - M.railCrossPad * 2 : M.rowHeight,
                  height: vertical ? M.rowHeight : cross - M.railCrossPad * 2,
                  opacity: isPreferred ? 1 : progress,
                  transform: vertical ? `translateY(${reveal}px)` : `translateX(${reveal}px)`,
                }}
                onEnter={() => domPointer({ row: index })}
                onLeave={() => domPointer({ row: null })}
                onClick={() => onRowClick(provider)}
              />
            )
          })}
        </div>
      </div>

      {hoveredProvider ? (
        <div
          ref={detailRef}
          className={`dock-detail is-${detailPhase} is-tail-${tailEdge}${detailPlaced ? '' : ' is-measuring'}`}
          style={{ left: detailFrame?.x ?? 0, top: detailFrame?.y ?? 0, width: detailW, padding: detailPadding(tailEdge) }}
          onMouseEnter={() => domPointer({ detailHovered: true })}
          onMouseLeave={() => domPointer({ detailHovered: false })}
        >
          {detailH > 0 ? (
            <svg className="dock-surface" width={detailW} height={detailH} viewBox={`0 0 ${detailW} ${detailH}`} aria-hidden="true">
              <path d={bubblePath(tailEdge, detailW, detailH, tail)} fill="url(#dock-rail-fill)" />
              <path d={bubblePath(tailEdge, detailW, detailH, tail)} fill="url(#dock-rail-glow)" />
              <path d={bubblePath(tailEdge, detailW, detailH, tail)} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="0.9" />
            </svg>
          ) : null}
          <Detail provider={hoveredProvider} quota={quota} loading={loading} />
        </div>
      ) : null}
    </div>
  )
}
