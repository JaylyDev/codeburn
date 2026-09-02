/// The background usage loop asks Rust how long to wait before its next tick rather than
/// working it out here: the cadence follows the machine's power state, which is a Win32 read
/// and which changes under a loop that has already been armed.
///
/// Port of mac/.../RefreshCadence.swift; the arithmetic and its tests live in
/// `src-tauri/src/refresh.rs`.

import { invoke } from '@tauri-apps/api/core'

export type RefreshPlan = {
  /// `null` is Manual: nothing spawns on a timer, so the loop stops until the setting or the
  /// popover changes.
  intervalMs: number | null
  power: { onBattery: boolean; batterySaver: boolean }
}

export function usageRefreshPlan(mode: number, popoverOpen: boolean): Promise<RefreshPlan> {
  return invoke<RefreshPlan>('usage_refresh_plan', { mode, popoverOpen })
}
