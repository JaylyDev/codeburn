/// Anonymous, consent-gated product telemetry, from the page's side.
///
/// Every decision lives in Rust (`src-tauri/src/telemetry.rs`): whether there is consent at
/// all, whose consent it is, what a prop may contain, when a batch is sent. This file only
/// names the events and gets them across, which is why `track` neither asks whether it is
/// allowed nor reports when it was not: a page that had to know the current decision before
/// reporting anything would be one more place for that decision to go stale.
///
/// Nothing here is queued before a decision has been made, and nothing is sent from a debug
/// build. See the module doc in telemetry.rs for the whole set of invariants.

import { invoke } from '@tauri-apps/api/core'

/// What the desktop app's consent screen links to, so both apps explain themselves in the
/// same place.
export const TELEMETRY_DOCS_URL = 'https://www.codeburn.app/telemetry'

/// The events the pages send. Rust drops anything not on its own list, so this type is here
/// to catch a typo at build time rather than to be the gate.
export type TelemetryEvent =
  | 'popover_open'
  | 'settings_open'
  | 'update_click'
  | 'glance_open'
  | 'dock_provider_switch'
  | 'dock_drag_end'

/// Which app made the decision this app is running under. `desktop` means the desktop app's
/// state file is present and answering for both, so the toggle here is a readout.
export type TelemetrySource = 'desktop' | 'app'

export type TelemetryStatus = {
  enabled: boolean
  onboarded: boolean
  source: TelemetrySource
  /// The region the default came from, or null when the locale does not name one.
  country: string | null
  defaultEnabled: boolean
}

/// Fire and forget. A failed report is not worth an error path in the caller: it is a
/// metric, and the queue on the Rust side is what makes one worth keeping at all.
export function track(name: TelemetryEvent, props?: Record<string, unknown>): void {
  void invoke('telemetry_track', { name, props: props ?? null }).catch(() => {})
}

/// Null when Rust has not finished setting up, which is only ever the first moment of a
/// launch; the caller shows nothing rather than guessing at a decision.
export async function telemetryStatus(): Promise<TelemetryStatus | null> {
  try {
    return await invoke<TelemetryStatus | null>('telemetry_status')
  } catch {
    return null
  }
}

export async function setTelemetryEnabled(enabled: boolean): Promise<TelemetryStatus | null> {
  try {
    return await invoke<TelemetryStatus | null>('telemetry_set_enabled', { enabled })
  } catch {
    return null
  }
}

/// The one-time notice's answer. Both answers count as an answer, which is what stops the
/// notice coming back and what unlocks sending.
export async function completeTelemetryConsent(enabled: boolean): Promise<TelemetryStatus | null> {
  try {
    return await invoke<TelemetryStatus | null>('telemetry_consent', { enabled })
  } catch {
    return null
  }
}
