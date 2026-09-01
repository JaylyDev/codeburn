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
  rowHeight: points(84),
  rowSpacing: points(12),
  // Docked rails add 60% of the shoulder depth so content never crowds the concave flare.
  railAlongPad: points(20) + Math.round(points(52) * 0.6),
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

export function railHeight(rows: number): number {
  const count = Math.max(rows, 1)
  return M.railAlongPad * 2 + count * M.rowHeight + (count - 1) * M.rowSpacing
}

/// Motion: durations in ms and cubic-bezier control points, verbatim from CapacityDockMotion.
export const MOTION = {
  railExpand: { duration: 520, curve: [0.22, 1, 0.36, 1] as const },
  railCollapse: { duration: 440, curve: [0.32, 0, 0.2, 1] as const },
  detailPresent: { duration: 200, curve: [0.16, 1, 0.3, 1] as const },
  detailFollow: { duration: 220, curve: [0.25, 0.1, 0.25, 1] as const },
  detailDismiss: { duration: 140, curve: [0.4, 0, 1, 1] as const },
  railHoverOpenDelay: 80,
  railHoverCloseDelay: 180,
  detailShowDelay: 180,
  detailExitDelay: 240,
  detailAppearOffset: 10,
} as const

export function cssCurve(curve: readonly [number, number, number, number]): string {
  return `cubic-bezier(${curve.join(', ')})`
}

/// Cubic bezier easing solved by Newton iteration, matching CapacityDockMotion.cubicBezier.
export function bezier(curve: readonly [number, number, number, number], x: number): number {
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

/// The docked rail outline (CapacityDockRailShape.rightFlarePath at full attachment): convex
/// corners on the free left side, concave shoulders necking into the flush right edge, the
/// system-notch technique. Coordinates are local to a w by h box.
export function railPath(w: number, h: number): string {
  const freeR = Math.min(22, h / 2, w * 0.45)
  const contactR = Math.min(M.shoulderDepth * 0.6, h * 0.22, Math.max(0, h / 2 - freeR))
  const f = (n: number) => n.toFixed(2)
  return [
    `M ${f(w)} 0`,
    `Q ${f(w)} ${f(contactR)} ${f(w - contactR)} ${f(contactR)}`,
    `L ${f(freeR)} ${f(contactR)}`,
    `Q 0 ${f(contactR)} 0 ${f(contactR + freeR)}`,
    `L 0 ${f(h - contactR - freeR)}`,
    `Q 0 ${f(h - contactR)} ${f(freeR)} ${f(h - contactR)}`,
    `L ${f(w - contactR)} ${f(h - contactR)}`,
    `Q ${f(w)} ${f(h - contactR)} ${f(w)} ${f(h)}`,
    'Z',
  ].join(' ')
}

/// Detail bubble with a tail on its right edge pointing at the hovered row
/// (CapacityDockBubbleShape.rightTailPath). tailY is in local pixels.
export function bubblePath(w: number, h: number, tailY: number): string {
  const tailWidth = Math.min(22, Math.max(14, w * 0.055))
  const bodyRight = w - tailWidth
  const radius = Math.min(20, h * 0.18)
  const midY = h * Math.min(Math.max(tailY / Math.max(h, 1), 0.18), 0.82)
  const neck = Math.min(32, h * 0.19)
  const f = (n: number) => n.toFixed(2)
  return [
    `M ${f(radius)} 0`,
    `L ${f(bodyRight - radius)} 0`,
    `Q ${f(bodyRight)} 0 ${f(bodyRight)} ${f(radius)}`,
    `L ${f(bodyRight)} ${f(midY - neck)}`,
    `C ${f(bodyRight)} ${f(midY - neck * 0.55)} ${f(w)} ${f(midY - tailWidth * 0.42)} ${f(w)} ${f(midY)}`,
    `C ${f(w)} ${f(midY + tailWidth * 0.42)} ${f(bodyRight)} ${f(midY + neck * 0.55)} ${f(bodyRight)} ${f(midY + neck)}`,
    `L ${f(bodyRight)} ${f(h - radius)}`,
    `Q ${f(bodyRight)} ${f(h)} ${f(bodyRight - radius)} ${f(h)}`,
    `L ${f(radius)} ${f(h)}`,
    `Q 0 ${f(h)} 0 ${f(h - radius)}`,
    `L 0 ${f(radius)}`,
    `Q 0 0 ${f(radius)} 0`,
    'Z',
  ].join(' ')
}

/// Trailing inset of the bubble content: the regular inset plus room for the tail.
export const DETAIL_INSETS = {
  horizontal: Math.round(22 * DETAIL_SCALE),
  vertical: Math.round(16 * DETAIL_SCALE),
  tail: Math.round(18 * DETAIL_SCALE),
} as const
