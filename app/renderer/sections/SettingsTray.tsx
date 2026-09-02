// The tray app's own settings, inside the desktop app's Settings.
//
// The tray app (windows/) has a settings window of its own, and everything here writes the
// same two files it reads: `windows-settings.json` and `windows-dock.json`. Only the settings
// the desktop app does not already have appear; currency, period, scope and the daily budget
// are shared through the CLI config and live in General.
//
// Both panes are Windows only, and each is shown only while its switch in the sidebar corner
// is on: there is nothing to configure about a tray app that is not running, and the rail is
// one of its windows.

import { useCallback, useEffect, useState } from 'react'

import { Dropdown } from '../components/Dropdown'
import { ProviderLogo } from '../components/ProviderLogo'
import { usePolled } from '../hooks/usePolled'
import { codeburn } from '../lib/ipc'
import { PROVIDER_NAMES, QUOTA_PROVIDERS } from '../lib/providers'
import type { QuotaProvider, TrayPrefs } from '../lib/types'

/// The nine presets from the tray app's Theme/ThemeState.swift port
/// (windows/src/lib/accent.ts). Only the base shade is needed to draw a swatch.
const ACCENTS: Array<{ id: string; label: string; base: string }> = [
  { id: 'ember', label: 'Ember', base: '#C9521D' },
  { id: 'blue', label: 'Blue', base: '#0A84FF' },
  { id: 'purple', label: 'Purple', base: '#BF5AF2' },
  { id: 'pink', label: 'Pink', base: '#FF375F' },
  { id: 'red', label: 'Red', base: '#FF453A' },
  { id: 'orange', label: 'Orange', base: '#FF9F0A' },
  { id: 'yellow', label: 'Yellow', base: '#FFD60A' },
  { id: 'green', label: 'Green', base: '#30D158' },
  { id: 'graphite', label: 'Graphite', base: '#98989D' },
]

const METRICS = [
  { value: 'cost', label: 'Cost ($)' },
  { value: 'tokens', label: 'Tokens (up/down)' },
  { value: 'totalTokens', label: 'Total tokens' },
  { value: 'iconOnly', label: 'Icon only' },
]

const MENUBAR_PERIODS = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'all', label: '6 months' },
]

// The cadences are seconds, and the dropdown speaks strings, so they travel as strings and
// are turned back into numbers on the way to the file.
const USAGE_CADENCES = [
  { value: '-1', label: 'Auto' },
  { value: '0', label: 'Manual' },
  { value: '60', label: '1 minute' },
  { value: '300', label: '5 minutes' },
  { value: '900', label: '15 minutes' },
]

const QUOTA_CADENCES = [
  { value: '0', label: 'Manual' },
  { value: '60', label: '1 minute' },
  { value: '120', label: '2 minutes' },
  { value: '300', label: '5 minutes' },
  { value: '900', label: '15 minutes' },
]

const TERMINALS = [
  { value: 'windowsTerminal', label: 'Windows Terminal' },
  { value: 'powershell', label: 'Windows PowerShell' },
  { value: 'commandPrompt', label: 'Command Prompt' },
]

const DOCK_THEMES = [
  { value: 'graphite', label: 'Graphite' },
  { value: 'glass', label: 'Glass' },
]

const DOCK_GAUGE_SHAPES = [
  { value: 'circle', label: 'Circle' },
  { value: 'squircle', label: 'Squircle' },
]

const SCALE_MIN = 0.6
const SCALE_MAX = 1.2
const SCALE_STEP = 0.05

/**
 * One read of the tray app's settings, and one writer per file. Every setter answers with the
 * whole set, because the main process is what decides what a value ends up as: an unreadable
 * one collapses to a default, and a provider set moves the resting provider with it.
 */
export function useTrayPrefs(): {
  prefs: TrayPrefs | null
  setApp: (patch: Record<string, unknown>) => void
  setDock: (patch: Record<string, unknown>) => void
  setLaunchAtLogin: (enabled: boolean) => void
} {
  const [prefs, setPrefs] = useState<TrayPrefs | null>(null)

  useEffect(() => {
    let live = true
    void codeburn?.trayPrefs?.()
      .then(next => { if (live) setPrefs(next) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  const apply = useCallback((run: (() => Promise<TrayPrefs | null>) | undefined) => {
    if (!run) return
    void run().then(next => { if (next) setPrefs(next) }).catch(() => {})
  }, [])

  return {
    prefs,
    setApp: patch => apply(codeburn.setTrayAppPref && (() => codeburn.setTrayAppPref!(patch))),
    setDock: patch => apply(codeburn.setTrayDockPref && (() => codeburn.setTrayDockPref!(patch))),
    setLaunchAtLogin: enabled => apply(codeburn.setLaunchAtLogin && (() => codeburn.setLaunchAtLogin!(enabled))),
  }
}

function Switch({ on, label, disabled, onToggle }: {
  on: boolean
  label: string
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={on ? 'switch on' : 'switch'}
      onClick={onToggle}
    >
      <span className="switch-knob" />
    </button>
  )
}

export function MenuBarPane() {
  const { prefs, setApp, setLaunchAtLogin } = useTrayPrefs()
  if (!prefs) return <section className="set-p on"><p className="set-cap">Loading menu bar settings…</p></section>
  const app = prefs.app

  return (
    <section className="set-p on">
      <div>
        <h3 className="set-h">Menu bar</h3>
        <p className="set-sub">The CodeBurn icon in the Windows notification area. These are its own settings; currency, period and the daily budget are shared and live in General.</p>
      </div>
      <div className="card">
        <div className="about-sec">
          <div className="about-sec-h">Tray figure</div>
          <div className="about-row"><label className="tx" htmlFor="tray-metric">Metric<small>What the tray shows beside the flame.</small></label><span className="r">
            <Dropdown id="tray-metric" ariaLabel="Tray metric" value={app.metric} options={METRICS} onChange={value => setApp({ metric: value })} width={168} />
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="tray-period">Period<small>The span the tray figure is measured over.</small></label><span className="r">
            <Dropdown id="tray-period" ariaLabel="Tray period" value={app.menubarPeriod} options={MENUBAR_PERIODS} onChange={value => setApp({ menubarPeriod: value })} width={120} />
          </span></div>
          <div className="about-row"><span className="tx">Show today's figure<small>A second tray icon carrying the number. Off keeps it in the tooltip and the menu.</small></span><span className="r">
            <Switch on={app.trayBadge} label="Show today's figure in the tray" onToggle={() => setApp({ trayBadge: !app.trayBadge })} />
          </span></div>
        </div>

        <div className="about-sec">
          <div className="about-sec-h">Appearance</div>
          <div className="about-row"><span className="tx">Accent<small>Tints the popover, the settings window and the Capacity Dock.</small></span><span className="r">
            <span className="tray-accents" role="radiogroup" aria-label="Accent">
              {ACCENTS.map(accent => (
                <button
                  key={accent.id}
                  type="button"
                  role="radio"
                  aria-checked={app.accent === accent.id}
                  aria-label={accent.label}
                  title={accent.label}
                  className={app.accent === accent.id ? 'tray-accent on' : 'tray-accent'}
                  style={{ background: accent.base }}
                  onClick={() => setApp({ accent: accent.id })}
                />
              ))}
            </span>
          </span></div>
        </div>

        <div className="about-sec">
          <div className="about-sec-h">Refresh</div>
          <div className="about-row"><label className="tx" htmlFor="tray-usage">Usage<small>Auto follows the popover and the power state. Manual never refreshes on its own.</small></label><span className="r">
            <Dropdown id="tray-usage" ariaLabel="Usage refresh" value={String(app.usageRefreshSeconds)} options={USAGE_CADENCES} onChange={value => setApp({ usageRefreshSeconds: Number(value) })} width={124} />
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="tray-quota">Quota<small>One run answers for every provider, so this is one setting rather than ten.</small></label><span className="r">
            <Dropdown id="tray-quota" ariaLabel="Quota refresh" value={String(app.quotaCadenceSeconds)} options={QUOTA_CADENCES} onChange={value => setApp({ quotaCadenceSeconds: Number(value) })} width={124} />
          </span></div>
        </div>

        <div className="about-sec set-last-sec">
          <div className="about-sec-h">System</div>
          <div className="about-row"><label className="tx" htmlFor="tray-terminal">Terminal<small>Where Open Full Report runs.</small></label><span className="r">
            <Dropdown id="tray-terminal" ariaLabel="Terminal" value={app.terminal} options={TERMINALS} onChange={value => setApp({ terminal: value })} width={168} />
          </span></div>
          <div className="about-row"><span className="tx">Launch at login<small>Starts the menu bar app when you sign in.</small></span><span className="r">
            <Switch on={prefs.launchAtLogin} label="Launch at login" onToggle={() => setLaunchAtLogin(!prefs.launchAtLogin)} />
          </span></div>
        </div>
      </div>
    </section>
  )
}

export function CapacityDockPane({ refreshToken }: { refreshToken?: number }) {
  const { prefs, setDock } = useTrayPrefs()
  const quota = usePolled<QuotaProvider[]>(() => codeburn.getQuota(), [refreshToken])

  if (!prefs) return <section className="set-p on"><p className="set-cap">Loading Capacity Dock settings…</p></section>
  const dock = prefs.dock

  const connected = (quota.data ?? [])
    .filter(entry => entry.connection === 'connected')
    .map(entry => entry.provider as string)
  // Everything connected, plus anything already on the rail, so a provider whose connection
  // later fails can still be taken off it.
  const manageable = QUOTA_PROVIDERS.filter(id => dock.providers.includes(id) || connected.includes(id))
  // The rail must never end up with nothing to show, so the last connected provider stays on.
  const canDeselect = (id: string) =>
    !dock.providers.includes(id)
    || !connected.includes(id)
    || dock.providers.filter(entry => connected.includes(entry)).length > 1

  const toggleProvider = (id: string) => {
    const on = dock.providers.includes(id)
    if (on && !canDeselect(id)) return
    setDock({ providers: on ? dock.providers.filter(entry => entry !== id) : [...dock.providers, id] })
  }

  const restingOptions = (dock.providers.length > 0 ? dock.providers : manageable)
    .map(id => ({ value: id, label: PROVIDER_NAMES[id as keyof typeof PROVIDER_NAMES] ?? id }))

  return (
    <section className="set-p on">
      <div>
        <h3 className="set-h">Capacity Dock</h3>
        <p className="set-sub">The rail on the screen edge. Drag it to move it; these are the settings the menu bar app keeps for it.</p>
      </div>
      <div className="card">
        <div className="about-sec">
          <div className="about-sec-h">Rail</div>
          <div className="about-row"><span className="tx">Show the rail<small>The same switch as Sidebar in the corner.</small></span><span className="r">
            <Switch on={dock.enabled} label="Show the Capacity Dock" onToggle={() => setDock({ enabled: !dock.enabled })} />
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="dock-resting">Resting provider<small>The one row the rail shows until you hover it.</small></label><span className="r">
            {restingOptions.length > 0
              ? <Dropdown id="dock-resting" ariaLabel="Resting provider" value={dock.preferred ?? restingOptions[0]!.value} options={restingOptions} onChange={value => setDock({ preferred: value })} width={140} />
              : <span className="set-cap">No providers yet</span>}
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="dock-scale">Size<small>{Math.round(dock.scale * 100)} percent.</small></label><span className="r">
            <input
              id="dock-scale"
              className="set-range"
              type="range"
              aria-label="Capacity Dock size"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={SCALE_STEP}
              value={dock.scale}
              onChange={event => setDock({ scale: Number(event.target.value) })}
            />
          </span></div>
        </div>

        <div className="about-sec">
          <div className="about-sec-h">Appearance</div>
          <div className="about-row"><label className="tx" htmlFor="dock-theme">Surface<small>Graphite is opaque. Glass is translucent, painted inside the rail's own outline.</small></label><span className="r">
            <Dropdown id="dock-theme" ariaLabel="Capacity Dock appearance" value={dock.theme} options={DOCK_THEMES} onChange={value => setDock({ theme: value })} width={124} />
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="dock-gauge">Gauge<small>The shape of the ring around each provider glyph.</small></label><span className="r">
            <Dropdown id="dock-gauge" ariaLabel="Gauge shape" value={dock.gaugeShape} options={DOCK_GAUGE_SHAPES} onChange={value => setDock({ gaugeShape: value })} width={124} />
          </span></div>
        </div>

        <div className="about-sec set-last-sec">
          <div className="about-sec-h">Providers</div>
          {manageable.length === 0
            ? <p className="set-cap">No providers are connected yet. The rail follows whatever signs in.</p>
            : manageable.map(id => {
              const on = dock.providers.includes(id)
              const locked = on && !canDeselect(id)
              return (
                <div className="about-row" key={id}>
                  <span className="tx set-dock-prov">
                    <ProviderLogo provider={id} />
                    {PROVIDER_NAMES[id as keyof typeof PROVIDER_NAMES] ?? id}
                    {locked && <small>The rail needs at least one connected provider.</small>}
                    {!connected.includes(id) && <small>Not connected.</small>}
                  </span>
                  <span className="r">
                    <Switch on={on} disabled={locked} label={`${PROVIDER_NAMES[id as keyof typeof PROVIDER_NAMES] ?? id} on the Capacity Dock`} onToggle={() => toggleProvider(id)} />
                  </span>
                </div>
              )
            })}
        </div>
      </div>
    </section>
  )
}
