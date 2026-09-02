/// The one update source the page has. The header badge, the CLI banner and the About pane
/// all read this store, so one answer feeds them all rather than each asking Rust its own
/// question.
///
/// Port of the observable half of mac/.../Data/UpdateChecker.swift. The check itself lives
/// in Rust (`src-tauri/src/update.rs`): it talks to GitHub, keeps the answer on disk and
/// only spends a request once the two-day interval is up, so asking on every mount is free.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/// UpdateFailureStage: which half of the sequence failed, or which one is running.
export type UpdateStage = 'check' | 'cliUpdate' | 'menubarUpdate'

export type UpdateStatus = {
  currentVersion: string
  latestVersion: string | null
  latestCliVersion: string | null
  installedCliVersion: string | null
  updateAvailable: boolean
  cliUpdateAvailable: boolean
  /// Too old to install the app, whether or not it is also behind the latest release.
  cliTooOld: boolean
  cliUpdateCommand: string
  checkedAt: number | null
  failureStage: UpdateStage | null
  error: string | null
}

export type UpdateState = {
  status: UpdateStatus | null
  checking: boolean
  updating: boolean
  /// The stage the running update is on, for the label while it works.
  stage: UpdateStage | null
}

export const EMPTY_UPDATE: UpdateState = {
  status: null,
  checking: false,
  updating: false,
  stage: null,
}

/// Rust decides whether a check costs a request; this only decides how often it is offered
/// the chance. Well inside the two-day interval, so an app left running for a week still
/// learns about a release, and far enough apart that the `codeburn --version` each ask
/// spawns is nothing beside the usage refresh.
const ASK_INTERVAL_MS = 12 * 60 * 60_000

type Listener = (state: UpdateState) => void

let state: UpdateState = EMPTY_UPDATE
let listeners: Listener[] = []
let timer: number | undefined
let inFlight: Promise<void> | null = null
let inFlightForced = false
let stageListener: Promise<() => void> | null = null

function publish(next: Partial<UpdateState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener(state)
}

/// `force` skips the two-day gate, which is what the buttons that say Check for Updates do.
export async function checkUpdates(force: boolean): Promise<void> {
  if (inFlight) {
    // Coalescing is right for two mounts asking the same question, and wrong for a reader
    // who pressed the button: a forced check must not be answered by the cached one that
    // was already on its way, so it waits for it and then asks properly.
    if (!force || inFlightForced) return inFlight
    return inFlight.then(() => checkUpdates(true))
  }
  inFlightForced = force
  publish({ checking: true })
  inFlight = (async () => {
    try {
      const status = await invoke<UpdateStatus>('check_updates', { force })
      publish({ status, checking: false })
    } catch (err) {
      // A command that refuses to run at all is still a failed check, and the badge says so
      // rather than staying silent about a question nobody answered.
      publish({
        checking: false,
        status: {
          ...(state.status ?? blankStatus()),
          failureStage: 'check',
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  })().finally(() => { inFlight = null })
  return inFlight
}

/// One click, both updates: Rust runs the CLI update and then the app install, and reports
/// the status the sequence ended on.
export async function performUpdate(): Promise<void> {
  if (state.updating) return
  publish({ updating: true, stage: 'cliUpdate' })
  try {
    const status = await invoke<UpdateStatus>('perform_update')
    publish({ status, updating: false, stage: null })
  } catch (err) {
    publish({
      updating: false,
      stage: null,
      status: {
        ...(state.status ?? blankStatus()),
        failureStage: 'menubarUpdate',
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
}

function blankStatus(): UpdateStatus {
  return {
    currentVersion: '',
    latestVersion: null,
    latestCliVersion: null,
    installedCliVersion: null,
    updateAvailable: false,
    cliUpdateAvailable: false,
    cliTooOld: false,
    cliUpdateCommand: 'npm update -g codeburn',
    checkedAt: null,
    failureStage: null,
    error: null,
  }
}

export function subscribeUpdate(listener: Listener): () => void {
  listeners.push(listener)
  listener(state)
  if (listeners.length === 1) {
    if (state.status === null) void checkUpdates(false)
    timer = window.setInterval(() => { void checkUpdates(false) }, ASK_INTERVAL_MS)
    // The running stage is what turns "Updating..." into something that says which half.
    stageListener = listen<UpdateStage>('codeburn://update-stage', event => {
      if (state.updating) publish({ stage: event.payload })
    })
  }
  return () => {
    listeners = listeners.filter(l => l !== listener)
    if (listeners.length === 0) {
      window.clearInterval(timer)
      stageListener?.then(fn => fn())
      stageListener = null
    }
  }
}

/// UpdateChecker.updateBadgeLabel.
export function badgeLabel(state: UpdateState): string {
  if (state.updating) return 'Updating...'
  switch (state.status?.failureStage) {
    case 'check': return 'Update Check Failed'
    case 'cliUpdate': return 'CLI Update Failed'
    case 'menubarUpdate': return 'Menubar Update Failed'
    default: return 'Update'
  }
}

const STAGE_SUMMARY: Record<UpdateStage, string> = {
  check: 'CodeBurn could not check GitHub for updates.',
  cliUpdate: 'CodeBurn could not update the CLI.',
  menubarUpdate: 'CodeBurn could not update the tray app.',
}

const STAGE_RETRY: Record<UpdateStage, string> = {
  check: 'Click to retry the update check.',
  cliUpdate: 'Click to retry the update.',
  menubarUpdate: 'Click to retry the update.',
}

/// UpdateChecker.updateHelpText.
export function helpText(state: UpdateState): string {
  const stage = state.status?.failureStage
  const error = state.status?.error
  if (!stage || !error) return 'Update the CLI and the tray app to the latest release'
  return `${STAGE_SUMMARY[stage]}\n\n${error}\n\n${STAGE_RETRY[stage]}`
}

/// What a click on the badge does, from the mac's UpdateBadge: a failed check retries the
/// check, an offered update installs it, and anything else asks again.
export function badgeAction(state: UpdateState): 'check' | 'update' {
  if (state.status?.failureStage === 'check') return 'check'
  if (state.status?.updateAvailable || state.status?.cliUpdateAvailable) return 'update'
  return 'check'
}

export function badgeVisible(state: UpdateState): boolean {
  const status = state.status
  if (!status) return false
  return status.updateAvailable || status.cliUpdateAvailable || status.error !== null
}
