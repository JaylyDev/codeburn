/// Pure geometry and presentation rules for the Capacity Dock, ported from
/// mac/Sources/CodeBurnMenubar/Views/CapacityDockView.swift, CapacityDockMotion.swift and
/// Data/QuotaSummary.swift. Every metric is the mac value at its default 0.6 scale, rounded to a
/// whole pixel the way CapacityDockMetrics.points does; src-tauri/src/dock.rs sizes the window
/// from the same numbers and the two must stay in step.

export const SCALE = 0.6
export const DETAIL_SCALE = 0.9

function points(base: number, scale = SCALE): number {
  return Math.max(1, Math.round(base * scale))
}

export const M = {
  railWidth: points(88),
  horizontalRailWidth: points(106),
  rowHeight: points(84),
  rowSpacing: points(12),
  railAlongPad: points(20),
  // Docked rails add 60% of the shoulder depth so content never crowds the concave flare.
  flareCompensation: Math.round(points(52) * 0.6),
  railCrossPad: points(12),
  shoulderDepth: points(52),
  ringSize: points(52),
  ringStroke: points(4),
  ringLabelSpacing: points(6),
  providerIconSize: points(26),
  percentTextSize: points(17),
  detailWidth: points(350, DETAIL_SCALE),
  detailGap: 10,
  rowReveal: -8 * SCALE,
} as const

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
export function alongPad(attachment: number): number {
  return M.railAlongPad + M.flareCompensation * smoothstep(attachment)
}

export function railLength(rows: number, attachment: number): number {
  const count = Math.max(rows, 1)
  return alongPad(attachment) * 2 + count * M.rowHeight + (count - 1) * M.rowSpacing
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

export type Severity = 'normal' | 'warning' | 'critical' | 'danger'

/// Four tiers, from QuotaSummary.severity: below 50% is headroom, then yellow, orange, red.
export function severity(percent: number): Severity {
  if (percent >= 90) return 'danger'
  if (percent >= 75) return 'critical'
  if (percent >= 50) return 'warning'
  return 'normal'
}

export type QuotaWindow = { label: string; usedPct: number; resetsAt?: string }

/// The glance value: every provider on the same billing horizon, weekly if there is one, else
/// monthly, else the window nearest exhaustion. Empty stays null rather than posing as 0%.
export function headlineWindow(windows: QuotaWindow[]): QuotaWindow | null {
  const find = (needle: string) => windows.find((row) => row.label.toLowerCase().includes(needle))
  return (
    find('week') ??
    find('month') ??
    windows.reduce<QuotaWindow | null>((worst, row) => (worst && worst.usedPct >= row.usedPct ? worst : row), null)
  )
}

export function pct(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)))
}

export function resetsIn(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const seconds = (new Date(iso).getTime() - now) / 1000
  if (Number.isNaN(seconds)) return ''
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

export function displayLabel(label: string): string {
  return label
    .replace(/Claude and GPT models/i, 'Claude + GPT')
    .replace(/Gemini Models/i, 'Gemini')
    .replace(/Five-hour/i, '5-hour')
}

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
export function railPath(edge: Edge, cross: number, len: number, attachment: number): string {
  const eased = smoothstep(attachment)
  const b = new PathBuilder(mapper(edge, cross))
  const freeR = Math.min(22, len / 2, cross * 0.45)
  if (eased < 0.5) return roundedRect(b, cross, len, freeR)
  const contactR = Math.min(M.shoulderDepth * 0.6, len * 0.22, Math.max(0, len / 2 - freeR)) * eased
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
export const DETAIL_INSETS = {
  horizontal: Math.round(22 * DETAIL_SCALE),
  vertical: Math.round(16 * DETAIL_SCALE),
  tail: Math.round(18 * DETAIL_SCALE),
} as const

export function detailPadding(tailEdge: Edge): string {
  const h = DETAIL_INSETS.horizontal
  const v = DETAIL_INSETS.vertical
  const t = DETAIL_INSETS.tail
  const top = v + (tailEdge === 'top' ? t : 0)
  const right = h + (tailEdge === 'right' ? t : 0)
  const bottom = v + (tailEdge === 'bottom' ? t : 0)
  const left = h + (tailEdge === 'left' ? t : 0)
  return `${top}px ${right}px ${bottom}px ${left}px`
}
