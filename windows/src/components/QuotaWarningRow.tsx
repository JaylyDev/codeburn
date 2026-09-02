import type { ComponentType } from 'react'
import { quotaWarnings, severity, type QuotaState, type Severity } from '../lib/quota'
import { ExclamationCircleIcon, InfoCircleIcon, OctagonIcon, WarningIcon } from './Icons'

/// Port of QuotaWarningRow in mac/Sources/CodeBurnMenubar/Views/MenuBarContent.swift. Lists
/// every connected provider at or over the threshold with its worst window, so the reader
/// knows whether to slow down on one tool or on several.

const ICONS: Record<Severity, ComponentType<{ size: number }>> = {
  normal: InfoCircleIcon,
  warning: ExclamationCircleIcon,
  critical: props => <WarningIcon {...props} filled={false} />,
  danger: OctagonIcon,
}

export function QuotaWarningRow({ quota }: { quota: QuotaState }) {
  const warnings = quotaWarnings(quota)
  if (warnings.length === 0) return null

  const tone = severity(warnings[0].percent)
  const Icon = ICONS[tone]
  return (
    <div className={`quota-warning is-${tone}`} role="status">
      <Icon size={11} />
      <span>{message(warnings, tone)}</span>
    </div>
  )
}

function message(warnings: Array<{ name: string; percent: number }>, tone: Severity): string {
  const parts = warnings.map(w => `${w.name} ${Math.round(w.percent)}%`)
  if (parts.length === 1) {
    // Reads "Claude over limit (105%)" rather than the awkward "Claude 105% of quota used".
    if (tone === 'danger') return `${warnings[0].name} over limit (${Math.round(warnings[0].percent)}%)`
    return `${parts[0]} of quota used`
  }
  return parts.join(' · ')
}
