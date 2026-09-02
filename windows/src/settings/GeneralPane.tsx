import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

import type { CurrencyState } from '../lib/currency'
import { CURRENCY_CODES, CURRENCY_NAMES, USD } from '../lib/currency'
import { ACCENT_PRESETS, accentById, applyAccent } from '../lib/accent'
import {
  DISPLAY_METRICS, MENUBAR_PERIODS, subscribeSettings, writeSettings,
  type AppSettings, type DisplayMetric, type MenubarPeriod, type MenubarScope, type ThemeChoice,
} from '../lib/appSettings'
import { applyTheme } from '../lib/settings'
import { TRAY_BADGE_SUPPORTED, homePath } from '../lib/platform'
import { summaryFor, type QuotaState } from '../lib/quota'
import {
  DEFAULT_DOCK_PREFS, DOCK_GAUGE_SHAPES, DOCK_SCALE_MAX, DOCK_SCALE_MIN, DOCK_SCALE_STEP,
  DOCK_THEMES, canDeselect, loadDockPrefs, manageableProviders, onDockPrefsChanged,
  writeDockPrefs, type DockPrefs,
} from '../lib/dockPrefs'
import { ProviderGlyph } from '../providerIcons'
import { Group, Note, Pane, Row, Select, Slider, Switch } from './controls'

/// The mac's GeneralSettingsTab. Display first, because it is what the reader came for; the
/// Windows-only rows (login item, tray badge) sit under System at the end, where the mac
/// keeps nothing because macOS handles both for it.

type Props = {
  quota: QuotaState
  /// A deep link's anchor, so "Capacity Dock Settings..." lands on that section.
  anchor: string | null
}

export function GeneralPane({ quota, anchor }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [currency, setCurrency] = useState<CurrencyState>(USD)
  const [currencyError, setCurrencyError] = useState<string | null>(null)
  const [loginItem, setLoginItem] = useState<boolean | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)

  useEffect(() => subscribeSettings(setSettings), [])

  useEffect(() => {
    invoke<boolean>('launch_at_login').then(setLoginItem).catch(() => setLoginItem(false))
    invoke<CurrencyState>('currency').then(setCurrency).catch(() => {})
  }, [])

  useEffect(() => {
    if (!anchor) return
    document.getElementById(`stg-${anchor}`)?.scrollIntoView({ block: 'start' })
  }, [anchor])

  if (!settings) return <Pane />

  const applyCurrency = async (code: string) => {
    setCurrencyError(null)
    try {
      setCurrency(await invoke<CurrencyState>('set_currency', { code }))
    } catch (err) {
      setCurrencyError(err instanceof Error ? err.message : String(err))
    }
  }

  const chooseAccent = (id: string) => {
    // Applied here as well as persisted: this window is tinted by the same tokens, so the
    // swatch has to take effect before the event comes back.
    applyAccent(accentById(id))
    void writeSettings({ accent: id })
  }

  const chooseTheme = (theme: ThemeChoice) => {
    applyTheme(theme === 'system' ? null : theme)
    void writeSettings({ theme })
  }

  const toggleLogin = async () => {
    if (loginItem === null) return
    setLoginError(null)
    try {
      setLoginItem(await invoke<boolean>('set_launch_at_login', { enabled: !loginItem }))
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Pane>
      <Group
        title="Display"
        footer={`The currency is shared with the CLI through ${homePath('.config', 'codeburn', 'config.json')}.`}
      >
        <Row
          label="Currency"
          control={
            <Select
              ariaLabel="Currency"
              value={currency.code}
              options={CURRENCY_CODES.map(code => ({ id: code as string, label: `${code} - ${CURRENCY_NAMES[code] ?? code}` }))}
              onChange={applyCurrency}
            />
          }
        />
        {currencyError && <Note><span className="stg-error">{currencyError}</span></Note>}
        <Row
          label="Metric"
          hint="What the number beside the tray flame counts."
          control={
            <Select
              ariaLabel="Metric"
              value={settings.metric}
              options={DISPLAY_METRICS}
              onChange={(metric: DisplayMetric) => writeSettings({ metric })}
            />
          }
        />
        <Row
          label="Period"
          hint="How far back that number reaches."
          control={
            <Select
              ariaLabel="Period"
              value={settings.menubarPeriod}
              options={MENUBAR_PERIODS}
              onChange={(menubarPeriod: MenubarPeriod) => writeSettings({ menubarPeriod })}
            />
          }
        />
        <Row
          label="Scope"
          hint="Combined adds every paired device the CLI can reach."
          control={
            <Select
              ariaLabel="Scope"
              value={settings.menubarScope}
              options={[{ id: 'local' as MenubarScope, label: 'Local' }, { id: 'combined' as MenubarScope, label: 'Combined' }]}
              onChange={(menubarScope: MenubarScope) => writeSettings({ menubarScope })}
            />
          }
        />
        <Row
          label="Accent"
          hint="Tints the popover, this window and the Capacity Dock."
          control={
            <div className="stg-swatches" role="radiogroup" aria-label="Accent">
              {ACCENT_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={settings.accent === preset.id}
                  aria-label={preset.label}
                  title={preset.label}
                  className={`stg-swatch ${settings.accent === preset.id ? 'stg-swatch-on' : ''}`}
                  style={{ background: preset.base }}
                  onClick={() => chooseAccent(preset.id)}
                />
              ))}
            </div>
          }
        />
      </Group>

      <CapacityDockSection quota={quota} />

      <Group title="System">
        <Row
          label="Theme"
          control={
            <Select
              ariaLabel="Theme"
              value={settings.theme}
              options={[
                { id: 'system' as ThemeChoice, label: 'System' },
                { id: 'light' as ThemeChoice, label: 'Light' },
                { id: 'dark' as ThemeChoice, label: 'Dark' },
              ]}
              onChange={chooseTheme}
            />
          }
        />
        <Row
          label="Launch at login"
          hint="Start CodeBurn in the tray when you sign in."
          control={
            <Switch
              ariaLabel="Launch at login"
              on={loginItem === true}
              disabled={loginItem === null}
              onToggle={toggleLogin}
            />
          }
        />
        {loginError && <Note><span className="stg-error">{loginError}</span></Note>}
        {TRAY_BADGE_SUPPORTED && (
          <Row
            label="Show today's figure in the tray"
            hint="A second tray icon carrying the number, next to the logo."
            control={
              <Switch
                ariaLabel="Show today's figure in the tray"
                on={settings.trayBadge}
                onToggle={() => writeSettings({ trayBadge: !settings.trayBadge })}
              />
            }
          />
        )}
      </Group>
    </Pane>
  )
}

/// The mac's CapacityDockSettingsSection. These preferences live in windows-dock.json beside
/// the rail's placement, because the dock reads that file from Rust before its page exists.
function CapacityDockSection({ quota }: { quota: QuotaState }) {
  const [prefs, setPrefs] = useState<DockPrefs>(DEFAULT_DOCK_PREFS)

  useEffect(() => {
    void loadDockPrefs().then(setPrefs)
    return onDockPrefsChanged(setPrefs)
  }, [])

  const apply = (patch: Partial<DockPrefs>) => {
    // Optimistic, so a slider stays under the pointer; the event corrects it either way.
    setPrefs(current => ({ ...current, ...patch }))
    void writeDockPrefs(patch).then(setPrefs)
  }

  const isConnected = (id: string) => {
    const summary = summaryFor(quota, id)
    return summary !== null && (summary.connection === 'connected' || summary.connection === 'stale')
  }
  const nameOf = (id: string) => quota.providers.find(p => p.id === id)?.name ?? id

  const all = quota.providers.map(p => p.id)
  const manageable = manageableProviders(all, prefs.providers, isConnected)
  // The rail can only rest on a provider it is actually showing. With nothing chosen yet it
  // shows everything connected, which is what an empty selection means.
  const restable = (prefs.providers.length > 0 ? prefs.providers : all).filter(isConnected)
  const resting = restable.includes(prefs.preferred ?? '') ? prefs.preferred! : restable[0] ?? ''

  const toggleProvider = (id: string, on: boolean) => {
    const base = prefs.providers.length > 0 ? prefs.providers : all.filter(isConnected)
    const next = on ? [...base.filter(p => p !== id), id] : base.filter(p => p !== id)
    // Ordered as the CLI reports them, so the rail reads the same top to bottom whichever
    // order the switches were flipped in.
    apply({ providers: all.filter(p => next.includes(p)), manualSelection: true })
  }

  return (
    <Group
      id="stg-dock"
      title="Capacity Dock"
      footer="Connected providers, and anything already in the dock, appear here, so a provider can always be removed even after its connection fails."
    >
      <Row
        label="Show Capacity Dock"
        hint="A slim quota rail docked to a screen edge."
        control={
          <Switch
            ariaLabel="Show Capacity Dock"
            on={prefs.enabled}
            onToggle={() => apply({ enabled: !prefs.enabled })}
          />
        }
      />
      {restable.length > 0 && (
        <Row
          label="Resting provider"
          hint="The one the rail shows before you hover it."
          control={
            <Select
              ariaLabel="Resting provider"
              value={resting}
              options={restable.map(id => ({ id, label: nameOf(id) }))}
              onChange={preferred => apply({ preferred })}
            />
          }
        />
      )}
      <Row
        label="Size"
        control={
          <>
            <Slider
              ariaLabel="Capacity Dock size"
              value={prefs.scale}
              min={DOCK_SCALE_MIN}
              max={DOCK_SCALE_MAX}
              step={DOCK_SCALE_STEP}
              onChange={scale => apply({ scale })}
            />
            <span className="stg-readout">{Math.round(prefs.scale * 100)}%</span>
          </>
        }
      />
      <Row
        label="Appearance"
        control={
          <Select
            ariaLabel="Capacity Dock appearance"
            value={prefs.theme}
            options={DOCK_THEMES}
            onChange={theme => apply({ theme })}
          />
        }
      />
      <Row
        label="Gauge shape"
        control={
          <Select
            ariaLabel="Capacity Dock gauge shape"
            value={prefs.gaugeShape}
            options={DOCK_GAUGE_SHAPES}
            onChange={gaugeShape => apply({ gaugeShape })}
          />
        }
      />
      {manageable.length === 0 ? (
        <Note>Connect a provider from its page in the sidebar to make it available here.</Note>
      ) : (
        manageable.map(id => {
          const on = prefs.providers.length > 0 ? prefs.providers.includes(id) : isConnected(id)
          return (
            <Row
              key={id}
              label={
                <span className="stg-provider">
                  <ProviderGlyph id={id} size={14} />
                  <span>{nameOf(id)}</span>
                  {!isConnected(id) && <span className="stg-attention">Needs attention</span>}
                </span>
              }
              control={
                <Switch
                  ariaLabel={nameOf(id)}
                  on={on}
                  disabled={on && !canDeselect(id, prefs.providers.length > 0 ? prefs.providers : all.filter(isConnected), isConnected)}
                  onToggle={() => toggleProvider(id, !on)}
                />
              }
            />
          )
        })
      )}
      <Note>
        Size, appearance and gauge shape are stored now and the rail picks them up with the
        Capacity Dock work that follows this one.
      </Note>
    </Group>
  )
}
