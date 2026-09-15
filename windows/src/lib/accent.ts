/// The accent presets from mac/Sources/CodeBurnMenubar/Theme/ThemeState.swift: Apple's
/// dark-mode system accent colours plus the CodeBurn ember. Each preset carries the four
/// shades the popover paints with, which map one to one onto the CSS tokens in styles.css.

import { readSetting, writeSetting } from './settings'

export type AccentPreset = {
  id: string
  label: string
  base: string
  light: string
  deep: string
  glow: string
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'ember', label: 'Ember', base: '#C9521D', light: '#E8774A', deep: '#8B3E13', glow: '#F0A070' },
  { id: 'blue', label: 'Blue', base: '#0A84FF', light: '#409CFF', deep: '#0652B3', glow: '#80C0FF' },
  { id: 'purple', label: 'Purple', base: '#BF5AF2', light: '#DA8FF7', deep: '#7C38A8', glow: '#E0B8FA' },
  { id: 'pink', label: 'Pink', base: '#FF375F', light: '#FF6E8C', deep: '#B32642', glow: '#FF99B0' },
  { id: 'red', label: 'Red', base: '#FF453A', light: '#FF6E63', deep: '#B33028', glow: '#FF9990' },
  { id: 'orange', label: 'Orange', base: '#FF9F0A', light: '#FFBD4A', deep: '#B36F06', glow: '#FFD080' },
  { id: 'yellow', label: 'Yellow', base: '#FFD60A', light: '#FFE04A', deep: '#B39606', glow: '#FFEA80' },
  { id: 'green', label: 'Green', base: '#30D158', light: '#5AE078', deep: '#20923D', glow: '#80F098' },
  { id: 'graphite', label: 'Graphite', base: '#98989D', light: '#AEAEB2', deep: '#5E5E62', glow: '#C8C8CC' },
]

export const DEFAULT_ACCENT = ACCENT_PRESETS[0]

export function accentById(id: string | null): AccentPreset {
  return ACCENT_PRESETS.find(p => p.id === id) ?? DEFAULT_ACCENT
}

export function savedAccent(): AccentPreset {
  return accentById(readSetting('accent'))
}

/// Writes the preset over the tokens the stylesheet declares on :root. An inline style on
/// the same element outranks both theme blocks, so one write covers light and dark.
export function applyAccent(preset: AccentPreset): void {
  const style = document.documentElement.style
  style.setProperty('--brand-accent', preset.base)
  style.setProperty('--brand-accent-dark', preset.light)
  style.setProperty('--ember-deep', preset.deep)
  style.setProperty('--ember-glow', preset.glow)
  writeSetting('accent', preset.id)
}
