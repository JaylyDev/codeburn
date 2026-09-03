import { useEffect, useState } from 'react'

import {
  EMPTY_UPDATE, badgeAction, badgeLabel, badgeVisible, checkUpdates, helpText, openReleasePage,
  subscribeUpdate, type UpdateState,
} from '../lib/update'
import { DownloadIcon, WarningIcon } from './Icons'

/// Port of UpdateBadge in mac/.../Views/MenuBarContent.swift: a small prominent pill in the
/// header, there only when there is something to say. A failed check retries the check, an
/// offered update opens its GitHub release page for the reader to install from, and the
/// tooltip carries the whole story including the command that does it from a terminal.

export function UpdateBadge() {
  const [update, setUpdate] = useState<UpdateState>(EMPTY_UPDATE)
  useEffect(() => subscribeUpdate(setUpdate), [])

  if (!badgeVisible(update)) return null

  const label = badgeLabel(update)
  const help = helpText(update)
  const failed = update.status?.error != null

  return (
    <button
      type="button"
      className="update-badge"
      title={help}
      aria-label={label}
      onClick={() => {
        if (badgeAction(update) === 'download') void openReleasePage(update.status)
        else void checkUpdates(true)
      }}
    >
      {failed ? <WarningIcon size={10} /> : <DownloadIcon size={10} />}
      <span>{label}</span>
    </button>
  )
}
