/// Pure geometry and presentation rules for the Capacity Dock, ported from
/// mac/Sources/CodeBurnMenubar/Views/CapacityDockView.swift, CapacityDockMotion.swift and
/// Data/QuotaSummary.swift. Every metric is a mac base value times the settings window's size
/// scale, rounded to a whole pixel the way CapacityDockMetrics.points does;
/// src-tauri/src/dock.rs rebuilds the same numbers from the same scale and the two must stay
/// in step.

/// CapacityDockPreferences.scaleRange and its default.
export const MIN_SCALE = 0.6
export const MAX_SCALE = 1.2
export const DEFAULT_SCALE = MIN_SCALE
/// The bubble never shrinks with the rail: below 90% its type stops being readable.
const MIN_DETAIL_SCALE = 0.9

/// Fractional sizes cost the mac 5 to 7 percent idle CPU by making the hosting view re-lay
/// itself out forever, so every metric lands on a whole pixel.
function points(base: number, scale: number): number {
  return Math.max(1, Math.round(base * scale))
}

export type Metrics = {
  scale: number
  detailScale: number
  railWidth: number
  horizontalRailWidth: number
  rowHeight: number
  rowSpacing: number
  railAlongPad: number
  flareCompensation: number
  railCrossPad: number
  shoulderDepth: number
  ringSize: number
  ringStroke: number
  ringMargin: number
  ringLabelSpacing: number
  providerIconSize: number
  percentTextSize: number
  alertSize: number
  alertOffset: number
  detailWidth: number
  detailGap: number
  detailGlyphSize: number
  rowReveal: number
}

function build(scale: number): Metrics {
  const detailScale = Math.max(scale, MIN_DETAIL_SCALE)
  return {
    scale,
    detailScale,
    railWidth: points(88, scale),
    horizontalRailWidth: points(106, scale),
    rowHeight: points(84, scale),
    rowSpacing: points(12, scale),
    railAlongPad: points(20, scale),
    // Docked rails add 60% of the shoulder depth so content never crowds the concave flare.
    flareCompensation: Math.round(points(52, scale) * 0.6),
    railCrossPad: points(12, scale),
    shoulderDepth: points(52, scale),
    ringSize: points(52, scale),
    ringStroke: points(4, scale),
    // SVG strokes are centred on the path, so the ring box carries a margin for half of one.
    ringMargin: points(5, scale),
    ringLabelSpacing: points(6, scale),
    providerIconSize: points(26, scale),
    percentTextSize: points(17, scale),
    alertSize: points(12, scale),
    alertOffset: points(19, scale),
    detailWidth: points(350, detailScale),
    // The gap between rail and bubble is a placement constant on the mac, not a scaled metric.
    detailGap: 10,
    detailGlyphSize: points(24, detailScale),
    rowReveal: -8 * scale,
  }
}

const CACHE = new Map<number, Metrics>()

/// Metrics for a size scale. Cached because the dock passes them through effect dependencies,
/// where a fresh object on every render would restart the layout round trip forever.
export function metrics(scale: number): Metrics {
  const value = Number.isFinite(scale) ? scale : DEFAULT_SCALE
  const key = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, value)) * 100) / 100
  let found = CACHE.get(key)
  if (!found) {
    found = build(key)
    CACHE.set(key, found)
  }
  return found
}

export type Edge = 'left' | 'right' | 'top' | 'bottom'

export function isVertical(edge: Edge): boolean {
  return edge === 'left' || edge === 'right'
}

export function opposite(edge: Edge): Edge {
  switch (edge) {
    case 'left':
      return 'right'
    case 'right':
      return 'left'
    case 'top':
      return 'bottom'
    case 'bottom':
      return 'top'
  }
}

function smoothstep(p: number): number {
  const t = Math.min(Math.max(p, 0), 1)
  return t * t * (3 - 2 * t)
}

/// Along-axis padding for a given attachment progress, the mac's railAlongPad.
export function alongPad(m: Metrics, attachment: number): number {
  return m.railAlongPad + m.flareCompensation * smoothstep(attachment)
}

export function railLength(m: Metrics, rows: number, attachment: number): number {
  const count = Math.max(rows, 1)
  return alongPad(m, attachment) * 2 + count * m.rowHeight + (count - 1) * m.rowSpacing
}

/// Motion: durations in ms and cubic-bezier control points, verbatim from CapacityDockMotion.
export const MOTION = {
  railExpand: { duration: 520, curve: [0.22, 1, 0.36, 1] as const },
  railCollapse: { duration: 440, curve: [0.32, 0, 0.2, 1] as const },
  dockAttach: { duration: 280, curve: [0.16, 1, 0.3, 1] as const },
  dockDetach: { duration: 240, curve: [0.2, 0.8, 0.2, 1] as const },
  detailPresent: { duration: 200, curve: [0.16, 1, 0.3, 1] as const },
  detailFollow: { duration: 220, curve: [0.25, 0.1, 0.25, 1] as const },
  detailDismiss: { duration: 140, curve: [0.4, 0, 1, 1] as const },
  railHoverOpenDelay: 80,
  railHoverCloseDelay: 180,
  detailShowDelay: 180,
  detailExitDelay: 240,
  detailAppearOffset: 10,
  dragThreshold: 3,
} as const

export type Curve = readonly [number, number, number, number]

/// Cubic bezier easing solved by Newton iteration, matching CapacityDockMotion.cubicBezier.
export function bezier(curve: Curve, x: number): number {
  const [p1x, p1y, p2x, p2y] = curve
  const sampleX = (t: number) => ((1 - 3 * p2x + 3 * p1x) * t + (3 * p2x - 6 * p1x)) * t * t + 3 * p1x * t
  const sampleY = (t: number) => ((1 - 3 * p2y + 3 * p1y) * t + (3 * p2y - 6 * p1y)) * t * t + 3 * p1y * t
  const sampleDx = (t: number) => (3 * (1 - 3 * p2x + 3 * p1x) * t + 2 * (3 * p2x - 6 * p1x)) * t + 3 * p1x
  if (x <= 0) return 0
  if (x >= 1) return 1
  let t = x
  for (let i = 0; i < 8; i += 1) {
    const dx = sampleX(t) - x
    if (Math.abs(dx) < 1e-5) break
    const d = sampleDx(t)
    if (Math.abs(d) < 1e-6) break
    t -= dx / d
  }
  return sampleY(Math.min(1, Math.max(0, t)))
}

// The quota vocabulary the dock shares with the popover now lives in lib/quota, beside the
// store that fetches it. Re-exported so the dock still has one import for a row's geometry.
export {
  displayLabel,
  headlineWindow,
  pct,
  resetsIn,
  severity,
  type QuotaWindow,
  type Severity,
} from './lib/quota'

/// Shapes are drawn once for a right-edge rail in a canonical box (cross by along) and mapped
/// to the other edges with the same affine transforms the mac applies. `cross` is the
/// canonical width.
type Pt = readonly [number, number]

function mapper(edge: Edge, cross: number): (p: Pt) => Pt {
  switch (edge) {
    case 'right':
      return (p) => p
    case 'left':
      return ([x, y]) => [cross - x, y]
    case 'bottom':
      return ([x, y]) => [y, x]
    case 'top':
      return ([x, y]) => [y, cross - x]
  }
}

class PathBuilder {
  private parts: string[] = []
  constructor(private map: (p: Pt) => Pt) {}
  private f(p: Pt): string {
    const [x, y] = this.map(p)
    return `${x.toFixed(2)} ${y.toFixed(2)}`
  }
  move(p: Pt) {
    this.parts.push(`M ${this.f(p)}`)
    return this
  }
  line(p: Pt) {
    this.parts.push(`L ${this.f(p)}`)
    return this
  }
  quad(control: Pt, to: Pt) {
    this.parts.push(`Q ${this.f(control)} ${this.f(to)}`)
    return this
  }
  cubic(c1: Pt, c2: Pt, to: Pt) {
    this.parts.push(`C ${this.f(c1)} ${this.f(c2)} ${this.f(to)}`)
    return this
  }
  close(): string {
    this.parts.push('Z')
    return this.parts.join(' ')
  }
}

function roundedRect(b: PathBuilder, w: number, h: number, r: number): string {
  return b
    .move([r, 0])
    .line([w - r, 0])
    .quad([w, 0], [w, r])
    .line([w, h - r])
    .quad([w, h], [w - r, h])
    .line([r, h])
    .quad([0, h], [0, h - r])
    .line([0, r])
    .quad([0, 0], [r, 0])
    .close()
}

/// The rail outline (CapacityDockRailShape): a plain rounded pill while loose, and once more
/// than half attached, convex corners on the free side with concave shoulders necking into the
/// flush contact edge, the system-notch technique. `len` runs along the edge.
export function railPath(m: Metrics, edge: Edge, cross: number, len: number, attachment: number): string {
  const eased = smoothstep(attachment)
  const b = new PathBuilder(mapper(edge, cross))
  const freeR = Math.min(22, len / 2, cross * 0.45)
  if (eased < 0.5) return roundedRect(b, cross, len, freeR)
  const contactR = Math.min(m.shoulderDepth * 0.6, len * 0.22, Math.max(0, len / 2 - freeR)) * eased
  return b
    .move([cross, 0])
    .quad([cross, contactR], [cross - contactR, contactR])
    .line([freeR, contactR])
    .quad([0, contactR], [0, contactR + freeR])
    .line([0, len - contactR - freeR])
    .quad([0, len - contactR], [freeR, len - contactR])
    .line([cross - contactR, len - contactR])
    .quad([cross, len - contactR], [cross, len])
    .close()
}

/// Detail bubble (CapacityDockBubbleShape) with its tail on `tailEdge`, pointing at `tail`
/// measured along that edge. `w` and `h` are the bubble's final box.
export function bubblePath(tailEdge: Edge, w: number, h: number, tail: number): string {
  const vertical = isVertical(tailEdge)
  const cross = vertical ? w : h
  const along = vertical ? h : w
  const b = new PathBuilder(mapper(tailEdge, cross))
  const tailWidth = Math.min(22, Math.max(14, cross * 0.055))
  const bodyRight = cross - tailWidth
  const radius = Math.min(20, along * 0.18)
  const midY = along * Math.min(Math.max(tail / Math.max(along, 1), 0.18), 0.82)
  const neck = Math.min(32, along * 0.19)
  return b
    .move([radius, 0])
    .line([bodyRight - radius, 0])
    .quad([bodyRight, 0], [bodyRight, radius])
    .line([bodyRight, midY - neck])
    .cubic([bodyRight, midY - neck * 0.55], [cross, midY - tailWidth * 0.42], [cross, midY])
    .cubic([cross, midY + tailWidth * 0.42], [bodyRight, midY + neck * 0.55], [bodyRight, midY + neck])
    .line([bodyRight, along - radius])
    .quad([bodyRight, along], [bodyRight - radius, along])
    .line([radius, along])
    .quad([0, along], [0, along - radius])
    .line([0, radius])
    .quad([0, 0], [radius, 0])
    .close()
}

/// Bubble content insets: the regular inset plus room for the tail on the tail edge.
export function detailPadding(m: Metrics, tailEdge: Edge): string {
  const h = points(22, m.detailScale)
  const v = points(16, m.detailScale)
  const t = points(18, m.detailScale)
  const top = v + (tailEdge === 'top' ? t : 0)
  const right = h + (tailEdge === 'right' ? t : 0)
  const bottom = v + (tailEdge === 'bottom' ? t : 0)
  const left = h + (tailEdge === 'left' ? t : 0)
  return `${top}px ${right}px ${bottom}px ${left}px`
}
