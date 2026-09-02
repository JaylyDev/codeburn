import { useEffect, useState } from 'react'

import { EMPTY_UPDATE, performUpdate, subscribeUpdate, type UpdateState } from '../lib/update'
import { ArrowUpRightCircleIcon, CheckIcon, CopyIcon } from './Icons'

/// Port of CLIUpdateBanner in mac/.../Views/MenuBarContent.swift: a strip under the footer
/// when the installed codeburn is behind the latest release. Two ways out of it, as on the
/// mac: one click that runs the update here, and the command itself, copyable, for anyone
/// who would rather watch it happen in their own terminal.

export function CLIUpdateBanner() {
  const [update, setUpdate] = useState<UpdateState>(EMPTY_UPDATE)
  const [copied, setCopied] = useState(false)
  useEffect(() => subscribeUpdate(setUpdate), [])

  const status = update.status
  if (!status?.cliUpdateAvailable) return null
  const command = status.cliUpdateCommand

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="cli-banner">
      <span className="cli-banner-icon" aria-hidden="true"><ArrowUpRightCircleIcon size={11} /></span>
      <span className="cli-banner-text">CLI v{status.latestCliVersion} available</span>
      <button
        type="button"
        className="cli-banner-action"
        disabled={update.updating}
        title="Update the CLI, and the tray app if one is available, automatically"
        onClick={() => { void performUpdate() }}
      >
        {update.updating ? 'Updating...' : 'Update now'}
      </button>
      <button
        type="button"
        className="cli-banner-copy"
        title="Copy the update command to the clipboard"
        aria-label={`Copy ${command} to the clipboard`}
        onClick={copy}
      >
        <code>{command}</code>
        {copied ? <CheckIcon size={9} /> : <CopyIcon size={9} />}
      </button>
      <span className="cli-banner-spacer" />
    </div>
  )
}
