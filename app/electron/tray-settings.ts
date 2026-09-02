// The tray app's own preferences, read and written from the desktop app.
//
// The tray app (windows/) keeps them in two files that it reads from Rust before any of its
// windows exist, so those files are the interface rather than any running process:
//
//   ~/.config/codeburn/windows-settings.json   everything only the tray app cares about
//   ~/.config/codeburn/windows-dock.json       the Capacity Dock, whose placement lives here too
//
// Both hold keys this side has no business touching (the rail's placement, the tray app's
// theme cache), so every write is a merge of the named keys into whatever is already there.
// And every value is checked against the same closed set the tray app parses it with
// (windows/src/lib/appSettings.ts, windows/src/lib/dockPrefs.ts): a value it cannot
// understand collapses to a default there, so sending one would silently lose the setting.
//
// After a write the tray app is nudged with `--reload-settings`, which makes it re-read both
// files and broadcast to its own windows. That is done by the caller, which owns the process.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type TraySettingsFile = 'app' | 'dock'

function filePath(file: TraySettingsFile, home: string): string {
  return join(home, '.config', 'codeburn', file === 'app' ? 'windows-settings.json' : 'windows-dock.json')
}

export function readTrayFile(file: TraySettingsFile, home = homedir()): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath(file, home), 'utf8').replace(/^﻿/, ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Merge the given keys into the file, leaving every other key the tray app owns alone. */
export function patchTrayFile(
  file: TraySettingsFile,
  patch: Record<string, unknown>,
  home = homedir(),
): Record<string, unknown> {
  const merged = { ...readTrayFile(file, home), ...patch }
  const path = filePath(file, home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

// What each setting may be -----------------------------------------------------------------

export const DISPLAY_METRICS = ['cost', 'tokens', 'totalTokens', 'iconOnly'] as const
export const MENUBAR_PERIODS = ['today', 'week', 'month', 'all'] as const
export const ACCENTS = ['ember', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'graphite'] as const
export const USAGE_CADENCES = [-1, 0, 60, 300, 900] as const
export const QUOTA_CADENCES = [0, 60, 120, 300, 900] as const
export const TERMINALS = ['windowsTerminal', 'powershell', 'commandPrompt'] as const
export const DOCK_THEMES = ['graphite', 'glass'] as const
export const DOCK_GAUGE_SHAPES = ['circle', 'squircle'] as const
export const DOCK_SCALE_MIN = 0.6
export const DOCK_SCALE_MAX = 1.2
export const DOCK_SCALE_STEP = 0.05

export type TrayAppPrefs = {
  metric: string
  menubarPeriod: string
  accent: string
  trayBadge: boolean
  usageRefreshSeconds: number
  quotaCadenceSeconds: number
  terminal: string
}

export type TrayDockPrefs = {
  enabled: boolean
  preferred: string | null
  scale: number
  theme: string
  gaugeShape: string
  providers: string[]
  manualSelection: boolean
}

export const DEFAULT_TRAY_APP_PREFS: TrayAppPrefs = {
  metric: 'cost',
  menubarPeriod: 'today',
  accent: 'ember',
  trayBadge: false,
  usageRefreshSeconds: -1,
  quotaCadenceSeconds: 120,
  terminal: 'windowsTerminal',
}

export const DEFAULT_TRAY_DOCK_PREFS: TrayDockPrefs = {
  enabled: false,
  preferred: null,
  scale: DOCK_SCALE_MIN,
  theme: 'graphite',
  gaugeShape: 'circle',
  providers: [],
  manualSelection: false,
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback
}

/** The same reading the tray app does, so what the pane shows is what the tray app sees. */
export function parseTrayAppPrefs(raw: Record<string, unknown>): TrayAppPrefs {
  return {
    metric: oneOf(raw.metric, DISPLAY_METRICS, DEFAULT_TRAY_APP_PREFS.metric),
    menubarPeriod: oneOf(raw.menubarPeriod, MENUBAR_PERIODS, DEFAULT_TRAY_APP_PREFS.menubarPeriod),
    accent: oneOf(raw.accent, ACCENTS, DEFAULT_TRAY_APP_PREFS.accent),
    trayBadge: typeof raw.trayBadge === 'boolean' ? raw.trayBadge : DEFAULT_TRAY_APP_PREFS.trayBadge,
    usageRefreshSeconds: oneOf(raw.usageRefreshSeconds, USAGE_CADENCES, DEFAULT_TRAY_APP_PREFS.usageRefreshSeconds),
    quotaCadenceSeconds: oneOf(raw.quotaCadenceSeconds, QUOTA_CADENCES, DEFAULT_TRAY_APP_PREFS.quotaCadenceSeconds),
    terminal: oneOf(raw.terminal, TERMINALS, DEFAULT_TRAY_APP_PREFS.terminal),
  }
}

/** The rail's scale is a slider, so it is clamped and snapped rather than picked from a set. */
export function normalizeScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TRAY_DOCK_PREFS.scale
  const clamped = Math.min(DOCK_SCALE_MAX, Math.max(DOCK_SCALE_MIN, value))
  const steps = Math.round((clamped - DOCK_SCALE_MIN) / DOCK_SCALE_STEP)
  return Number((DOCK_SCALE_MIN + steps * DOCK_SCALE_STEP).toFixed(2))
}

export function parseTrayDockPrefs(raw: Record<string, unknown>): TrayDockPrefs {
  return {
    enabled: raw.enabled === true,
    preferred: typeof raw.preferred === 'string' ? raw.preferred : null,
    scale: normalizeScale(raw.scale),
    // `acrylic` is the spelling the setting had before the appearance was renamed Glass.
    theme: raw.theme === 'glass' || raw.theme === 'acrylic' ? 'glass' : 'graphite',
    gaugeShape: oneOf(raw.gaugeShape, DOCK_GAUGE_SHAPES, DEFAULT_TRAY_DOCK_PREFS.gaugeShape),
    providers: Array.isArray(raw.providers) ? raw.providers.filter((id): id is string => typeof id === 'string') : [],
    manualSelection: raw.manualSelection === true,
  }
}

/** Provider ids are the CLI's own, and they end up in a file the tray app parses. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Keep only the keys this pane is allowed to write, each checked against what the tray app
 * can read back. Anything else in the patch is dropped rather than merged, so a renderer
 * cannot reach the rail's placement or any other key the tray app owns.
 */
export function sanitizeAppPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if ('metric' in patch) out.metric = oneOf(patch.metric, DISPLAY_METRICS, DEFAULT_TRAY_APP_PREFS.metric)
  if ('menubarPeriod' in patch) out.menubarPeriod = oneOf(patch.menubarPeriod, MENUBAR_PERIODS, DEFAULT_TRAY_APP_PREFS.menubarPeriod)
  if ('accent' in patch) out.accent = oneOf(patch.accent, ACCENTS, DEFAULT_TRAY_APP_PREFS.accent)
  if ('trayBadge' in patch) out.trayBadge = patch.trayBadge === true
  if ('usageRefreshSeconds' in patch) out.usageRefreshSeconds = oneOf(patch.usageRefreshSeconds, USAGE_CADENCES, DEFAULT_TRAY_APP_PREFS.usageRefreshSeconds)
  if ('quotaCadenceSeconds' in patch) out.quotaCadenceSeconds = oneOf(patch.quotaCadenceSeconds, QUOTA_CADENCES, DEFAULT_TRAY_APP_PREFS.quotaCadenceSeconds)
  if ('terminal' in patch) out.terminal = oneOf(patch.terminal, TERMINALS, DEFAULT_TRAY_APP_PREFS.terminal)
  return out
}

export function sanitizeDockPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if ('enabled' in patch) out.enabled = patch.enabled === true
  if ('scale' in patch) out.scale = normalizeScale(patch.scale)
  if ('theme' in patch) out.theme = patch.theme === 'glass' ? 'glass' : 'graphite'
  if ('gaugeShape' in patch) out.gaugeShape = oneOf(patch.gaugeShape, DOCK_GAUGE_SHAPES, DEFAULT_TRAY_DOCK_PREFS.gaugeShape)
  if ('preferred' in patch) {
    out.preferred = typeof patch.preferred === 'string' && PROVIDER_ID.test(patch.preferred) ? patch.preferred : null
  }
  if ('providers' in patch) {
    const providers = Array.isArray(patch.providers)
      ? patch.providers.filter((id): id is string => typeof id === 'string' && PROVIDER_ID.test(id))
      : []
    out.providers = providers
    // Editing the set by hand is what stops the tray app auto-seeding it from whatever is
    // connected, exactly as its own settings window latches it.
    out.manualSelection = true
  }
  return out
}

/**
 * The rail can only rest on a provider it is showing, so a resting provider that has left the
 * set gives way to the first one still in it. CapacityDockPreferences.normalizedPreferred.
 */
export function normalizedPreferred(preferred: string | null, selected: string[]): string | null {
  if (preferred !== null && selected.includes(preferred)) return preferred
  return selected[0] ?? null
}

/**
 * The rail must never end up with nothing to show, so the last connected provider in the set
 * cannot be switched off. CapacityDockProviderSelection.canDeselect.
 */
export function canDeselect(id: string, selected: string[], connected: readonly string[]): boolean {
  if (!selected.includes(id)) return true
  if (!connected.includes(id)) return true
  return selected.filter(entry => connected.includes(entry)).length > 1
}
