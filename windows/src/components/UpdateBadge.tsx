import { useEffect, useState } from 'react'

import {
  EMPTY_UPDATE, badgeAction, badgeLabel, badgeVisible, checkUpdates, helpText, performUpdate,
  subscribeUpdate, type UpdateState,
} from '../lib/update'
import { DownloadIcon, RefreshIcon, WarningIcon } from './Icons'

/// Port of UpdateBadge in mac/.../Views/MenuBarContent.swift: a small prominent pill in the
/// header, there only when there is something to say. A failed check retries the check, an
/// offered update installs it in one click, and the tooltip carries the whole story.

export function UpdateBadge() {
  const [update, setUpdate] = useState<UpdateState>(EMPTY_UPDATE)
  useEffect(() => subscribeUpdate(setUpdate), [])

  if (!update.updating && !badgeVisible(update)) return null

  const label = badgeLabel(update)
  const help = helpText(update)
  const failed = update.status?.error != null

  return (
    <button
      type="button"
      className="update-badge"
      title={help}
      aria-label={label}
      disabled={update.updating}
      onClick={() => {
        if (badgeAction(update) === 'update') void performUpdate()
        else void checkUpdates(true)
      }}
    >
      {update.updating
        ? <span className="update-badge-spin"><RefreshIcon size={10} /></span>
        : failed
          ? <WarningIcon size={10} />
          : <DownloadIcon size={10} />}
      <span>{label}</span>
    </button>
  )
}
