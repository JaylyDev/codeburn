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
import type { QuotaState } from '../lib/quota'
import { Group, Note, Pane, Row, Select, Switch } from './controls'

/// The mac's GeneralSettingsTab. Display first, because it is what the reader came for; the
/// Windows-only rows (login item, tray badge) sit under System at the end, where the mac
/// keeps nothing because macOS handles both for it.

type Props = {
  quota: QuotaState
  /// A deep link's anchor, so "Capacity Dock Settings..." lands on that section.
  anchor: string | null
}

export function GeneralPane({ anchor }: Props) {
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
