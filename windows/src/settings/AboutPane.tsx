import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

import { Group, Note, Pane, Row } from './controls'
import { ArrowUpRight, FLAME_PATH } from '../components/Icons'
import { relativePast } from '../lib/dates'
import {
  EMPTY_UPDATE, checkUpdates, performUpdate, subscribeUpdate, type UpdateState,
} from '../lib/update'

/// The mac's AboutSettingsTab: a brand hero, the version with a Check for Updates button,
/// the three links, and the licence line. Unlike the mac, which sends the reader back to the
/// menu to install what the check found, the button that installs it is right here.

const LINKS = [
  { title: 'GitHub', url: 'https://github.com/getagentseal/codeburn' },
  { title: 'Website', url: 'https://codeburn.app' },
  { title: 'Issues', url: 'https://github.com/getagentseal/codeburn/issues' },
]

type Props = {
  /// A deep link's anchor. The tray's "Check for Updates" lands here on `about#check`, and
  /// a check the reader asked for from a menu should not wait for a second click.
  anchor?: string | null
}

export function AboutPane({ anchor }: Props) {
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateState>(EMPTY_UPDATE)

  useEffect(() => {
    invoke<string>('app_version').then(setVersion).catch(() => {})
  }, [])
  useEffect(() => subscribeUpdate(setUpdate), [])
  useEffect(() => {
    if (anchor === 'check') void checkUpdates(true)
  }, [anchor])

  const status = update.status
  const canInstall = (status?.updateAvailable || status?.cliUpdateAvailable) ?? false
  const busy = update.checking || update.updating

  return (
    <Pane>
      <div className="stg-hero">
        <div className="stg-hero-mark" aria-hidden="true">
          <svg width="56" height="56" viewBox="0 0 16 16">
            <path fill="url(#about-flame)" d={FLAME_PATH} />
            <defs>
              <linearGradient id="about-flame" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--ember-glow)" />
                <stop offset="55%" stopColor="var(--brand-accent)" />
                <stop offset="100%" stopColor="var(--ember-deep)" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div className="stg-hero-name">CodeBurn</div>
        <div className="stg-hero-version">{version ? `Version ${version}` : 'Version'}</div>
        <div className="stg-hero-tagline">Your AI Bill, Itemized</div>
      </div>

      <Group title="Updates">
        <Row
          label={version ? `Version ${version}` : 'Version'}
          hint={lastChecked(update)}
          control={
            <>
              {canInstall && (
                <button
                  type="button"
                  className="btn btn-prominent"
                  disabled={busy}
                  onClick={() => { void performUpdate() }}
                >
                  {update.updating ? 'Updating...' : 'Update Now'}
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => { void checkUpdates(true) }}
              >
                {update.checking ? 'Checking...' : 'Check for Updates'}
              </button>
            </>
          }
        />
        <Note>{resultNote(update)}</Note>
      </Group>

      <Group
        title="Links"
        footer="Copyright 2026 Resham Joshi (iamtoruk) - AgentSeal. MIT License."
      >
        {LINKS.map(link => (
          <button
            key={link.title}
            type="button"
            className="stg-link-row"
            onClick={() => openUrl(link.url)}
          >
            <span className="stg-row-label">{link.title}</span>
            <span className="stg-link-arrow"><ArrowUpRight size={11} /></span>
          </button>
        ))}
      </Group>
    </Pane>
  )
}

/// The three answers the mac's Check for Updates alert gives, in the pane rather than a
/// modal: up to date, an update is available, or the check failed and why.
function resultNote(update: UpdateState): string {
  const status = update.status
  if (update.updating) {
    return update.stage === 'cliUpdate'
      ? 'Updating the codeburn CLI...'
      : 'Installing the tray app. Windows will ask to run the installer.'
  }
  if (!status) return update.checking ? 'Checking GitHub for a newer release...' : ''
  if (status.error) {
    return status.failureStage === 'check'
      ? `Check failed. ${status.error}`
      : `Update failed. ${status.error}`
  }
  const parts: string[] = []
  if (status.updateAvailable && status.latestVersion) {
    parts.push(`Version ${status.latestVersion} is available.`)
  }
  if (status.cliUpdateAvailable && status.latestCliVersion) {
    parts.push(`CLI ${status.latestCliVersion} is available (you have ${status.installedCliVersion ?? 'none'}).`)
  }
  if (parts.length === 0) {
    return `You are on the latest version (${status.currentVersion}).`
  }
  parts.push('Update Now installs the CLI first, then the app.')
  return parts.join(' ')
}

/// When GitHub last answered, cached or fresh. The check only spends a request every two
/// days, so a reader looking at an old date should be able to see that it is old.
function lastChecked(update: UpdateState): string {
  const at = update.status?.checkedAt
  if (!at) return ''
  return `Checked ${relativePast(new Date(at * 1000))}`
}
