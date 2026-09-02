import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import type { MenubarPayload } from './lib/payload'
import type { CurrencyState } from './lib/currency'
import { USD, formatCurrency, plural, trayBadgeText } from './lib/currency'
import { PayloadCache, sameSelection, selectionKey, type Selection } from './lib/cache'
import { relativePast } from './lib/dates'
import { applyTheme, currentTheme, readSetting, writeSetting } from './lib/settings'
import { TRAY_BADGE_SUPPORTED } from './lib/platform'
import { EMPTY_QUOTA, refreshQuota, subscribeQuota, worstSeverity, type QuotaState } from './lib/quota'
import { AgentTabStrip, ALL_PROVIDER, providerLabel, providerTabs } from './components/AgentTabStrip'
import type { Provider } from './components/AgentTabStrip'
import { ModelsSection } from './components/ModelsSection'
import { InsightPills, INSIGHT_ORDER, isInsightMode, type InsightMode } from './components/InsightPills'
import { TrendInsight, trendDayCount } from './components/TrendInsight'
import { CalendarInsight } from './components/CalendarInsight'
import { OptimizeInsight } from './components/OptimizeInsight'
import { ForecastInsight } from './components/ForecastInsight'
import { PulseInsight } from './components/PulseInsight'
import { StatsInsight } from './components/StatsInsight'
import { PlanInsight, planTarget } from './components/PlanInsight'
import { FindingsSection } from './components/FindingsSection'
import { PullRequestsSection } from './components/PullRequestsSection'
import { ToolingSection } from './components/ToolingSection'
import { ActivitySection } from './components/ActivitySection'
import { LoadingOverlay } from './components/LoadingOverlay'
import { EmptyProviderState } from './components/EmptyProviderState'
import { NoDataState } from './components/NoDataState'
import { SetupState, type CliStatus } from './components/SetupState'
import { StarBanner } from './components/StarBanner'
import { HeroSection } from './components/HeroSection'
import { PeriodTabs, PERIOD_LABELS, daySelectionLabel } from './components/PeriodTabs'
import type { DaySelection, Period } from './components/PeriodTabs'
import { FooterBar } from './components/FooterBar'
import { ErrorToast } from './components/ErrorToast'
import { Header } from './components/Header'
import { applyAccent, savedAccent, type AccentPreset } from './lib/accent'
import { SettingsPanel, type SettingsSection, type ThemeChoice } from './components/SettingsPanel'

const payloadCache = new PayloadCache<MenubarPayload>()

/// The tray badge, the tooltip and the tab strip costs all read this one key, whatever
/// the popover is showing.
const TODAY_ALL: Selection = { period: 'today', provider: 'all', days: [] }

/// Background cadence, mirroring mac/Sources/CodeBurnMenubar/RefreshCadence.swift: every
/// fetch is a full Node process, so the popover being closed has to cost less than it being
/// open. Visible, a tick refreshes today/all plus the selected period/provider with optimize
/// findings; hidden, a slower tick refreshes only today/all and skips optimize, since the
/// tray badge and tooltip are the only things anyone can see. Entries younger than STALE_MS
/// are left alone when the popover is re-opened.
const REFRESH_ACTIVE_MS = 60_000
const REFRESH_IDLE_MS = 120_000
const STALE_MS = 60_000

type FetchOptions = {
  includeOptimize: boolean
  showOverlay: boolean
}

export function App() {
  const [period, setPeriod] = useState<Period>('today')
  // Days picked in the calendar. Non-empty overrides the period, as isDayMode does on
  // the mac; the period stays put so clearing the picker returns to it.
  const [days, setDays] = useState<DaySelection>([])
  const [provider, setProvider] = useState<Provider>(ALL_PROVIDER)
  const [payload, setPayload] = useState<MenubarPayload | null>(null)
  const [todayPayload, setTodayPayload] = useState<MenubarPayload | null>(null)
  const [currency, setCurrency] = useState<CurrencyState>(USD)
  const [overlay, setOverlay] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [insight, setInsight] = useState<InsightMode>(() => {
    const saved = readSetting('insight')
    return isInsightMode(saved) ? saved : 'trend'
  })
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null)
  const [cliChecking, setCliChecking] = useState(false)
  const [version, setVersion] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [theme, setTheme] = useState(() => currentTheme())
  const [trayBadge, setTrayBadge] = useState(() => TRAY_BADGE_SUPPORTED && readSetting('trayBadge') !== 'off')
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [quota, setQuota] = useState<QuotaState>(EMPTY_QUOTA)
  // The window starts hidden and is shown by a tray click, which emits `codeburn://shown`.
  const [popoverVisible, setPopoverVisible] = useState(false)
  const [accent, setAccent] = useState<AccentPreset>(savedAccent)
  const [dailyBudget, setDailyBudget] = useState<number | null>(null)
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => {
    const saved = readSetting('theme')
    return saved === 'dark' || saved === 'light' ? saved : 'system'
  })

  const current: Selection = { period, provider, days }
  const selection = useRef(current)
  selection.current = current

  const fetchKey = useCallback(async (key: Selection, opts: FetchOptions) => {
    if (payloadCache.isInFlight(key)) return
    payloadCache.markInFlight(key)
    const isSelected = () => sameSelection(selection.current, key)
    if (opts.showOverlay && isSelected()) setOverlay(true)
    try {
      const json = await invoke<MenubarPayload>('fetch_payload', {
        period: key.period,
        provider: key.provider,
        days: key.days,
        includeOptimize: opts.includeOptimize,
      })
      // A quiet (no-optimize) refresh must not wipe findings a previous full fetch had.
      if (!opts.includeOptimize) {
        const previous = payloadCache.get(key)
        if (previous) json.optimize = previous.optimize
      }
      payloadCache.set(key, json)
      if (isSelected()) {
        setPayload(json)
        // "updated Xs ago" describes what the user is looking at, so only a fetch of the
        // visible key may stamp it - a background today/all tick must not.
        setLastUpdated(new Date())
      }
      if (sameSelection(key, TODAY_ALL)) setTodayPayload(json)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('CLI not found')) {
        const status = await invoke<CliStatus>('cli_status').catch(() => null)
        if (status) setCliStatus(status)
      } else if (isSelected()) {
        setError(message)
      }
    } finally {
      payloadCache.clearInFlight(key)
      if (isSelected()) setOverlay(false)
    }
  }, [])

  const refreshAll = useCallback(async (opts: FetchOptions) => {
    const key = selection.current
    if (!sameSelection(key, TODAY_ALL)) {
      fetchKey(TODAY_ALL, { includeOptimize: false, showOverlay: false })
    }
    void refreshQuota()
    await fetchKey(key, opts)
  }, [fetchKey])

  /// The single source of truth for the CLI gate. Nothing else writes a "compatible"
  /// verdict: a payload that happens to parse does not prove the CLI is new enough, and a
  /// probe from the settings panel must not be able to invent one either.
  const checkCli = useCallback(async () => {
    setCliChecking(true)
    try {
      const status = await invoke<CliStatus>('cli_status')
      setCliStatus(status)
      if (status.found && status.compatible) {
        refreshAll({ includeOptimize: true, showOverlay: true })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCliChecking(false)
    }
  }, [refreshAll])

  const cliReady = cliStatus !== null && cliStatus.found && cliStatus.compatible

  // Probe the gate before the first fetch: an old CLI emits a payload missing fields the
  // popover reads, which used to blank the whole window instead of showing the setup screen.
  useEffect(() => {
    invoke<string>('app_version').then(setVersion).catch(() => {})
    checkCli()
    // Startup only; checkCli is re-run from the setup screen and settings on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!cliReady) return
    const tick = popoverVisible
      ? () => refreshAll({ includeOptimize: true, showOverlay: false })
      : () => fetchKey(TODAY_ALL, { includeOptimize: false, showOverlay: false })
    const id = setInterval(tick, popoverVisible ? REFRESH_ACTIVE_MS : REFRESH_IDLE_MS)
    return () => clearInterval(id)
  }, [cliReady, popoverVisible, refreshAll, fetchKey])

  const selectionKeyValue = selectionKey(current)
  useEffect(() => {
    const key = selection.current
    const cached = payloadCache.get(key)
    setPayload(cached)
    if (!cliReady) return
    if (!cached) {
      fetchKey(key, { includeOptimize: true, showOverlay: true })
    } else if (payloadCache.age(key) > STALE_MS) {
      fetchKey(key, { includeOptimize: true, showOverlay: false })
    }
    // The selection is a fresh object each render, so the key string is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKeyValue, cliReady, fetchKey])

  useEffect(() => {
    const unlistenRefresh = listen('codeburn://refresh', () => refreshAll({ includeOptimize: true, showOverlay: true }))
    const unlistenShown = listen('codeburn://shown', () => {
      setPopoverVisible(true)
      readDailyBudget()
      if (payloadCache.age(selection.current) > STALE_MS) {
        refreshAll({ includeOptimize: true, showOverlay: false })
      }
    })
    const unlistenHidden = listen('codeburn://hidden', () => setPopoverVisible(false))
    const unlistenTheme = listen('codeburn://toggle-theme', () => toggleTheme())
    // The tray's Settings, Capacity Dock Settings and About all land in the settings panel
    // for now; package C gives each its own pane in a real settings window.
    const unlistenPanel = listen<string>('codeburn://open-panel', event => {
      // Capacity Dock Settings lands in General, as it does on the mac.
      setSettingsSection(event.payload === 'about' ? 'about' : 'general')
      setShowSettings(true)
    })
    return () => {
      unlistenRefresh.then(fn => fn())
      unlistenShown.then(fn => fn())
      unlistenHidden.then(fn => fn())
      unlistenTheme.then(fn => fn())
      unlistenPanel.then(fn => fn())
    }
  }, [refreshAll])

  // The limit lives in the CLI config, which package C's settings window will write, so
  // it is re-read whenever the popover comes back rather than cached for the session.
  const readDailyBudget = () => {
    invoke<number | null>('daily_budget').then(setDailyBudget).catch(() => {})
  }
  useEffect(readDailyBudget, [])

  // The quota store polls only while something is watching it, so it starts here and stops
  // with the page. A manual Refresh asks it for a fresh answer too.
  useEffect(() => subscribeQuota(setQuota), [])

  useEffect(() => {
    const saved = readSetting('theme')
    if (saved === 'dark' || saved === 'light') applyTheme(saved)
    setTheme(currentTheme())
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setTheme(currentTheme())
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') invoke('hide_popover').catch(() => {})
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const todayCost = todayPayload?.current?.cost ?? null

  useEffect(() => {
    if (todayCost === null) return
    const text = `CodeBurn · ${formatCurrency(todayCost, currency)} today`
    invoke('set_tray_tooltip', { text }).catch(() => {})
  }, [todayCost, currency])

  useEffect(() => {
    if (!TRAY_BADGE_SUPPORTED) return
    // Before the first payload there is nothing to say, and the badge restored from the last
    // session is already on screen: clearing it here would blank the tray on every launch.
    if (trayBadge && todayCost === null) return
    const text = trayBadge && todayCost !== null ? trayBadgeText(todayCost, currency) : null
    invoke('set_tray_badge', { text }).catch(err => setError(`Tray badge: ${String(err)}`))
  }, [todayCost, currency, trayBadge])

  // The flame carries the worst connected provider's quota severity. Rust decides whether
  // today's spend is over the daily budget, since the limit lives in the CLI's config.
  useEffect(() => {
    invoke('set_tray_severity', { severity: worstSeverity(quota), todayCost }).catch(() => {})
  }, [quota, todayCost])

  useEffect(() => {
    const text = todayPayload?.current
      ? `Today · ${formatCurrency(todayPayload.current.cost, currency)} · ${plural(todayPayload.current.calls, 'call')}`
      : 'Today · no usage yet'
    invoke('set_tray_usage', { text }).catch(() => {})
  }, [todayPayload, currency])


  const chooseAccent = (preset: AccentPreset) => {
    applyAccent(preset)
    setAccent(preset)
  }

  const chooseTheme = (choice: ThemeChoice) => {
    applyTheme(choice === 'system' ? null : choice)
    setThemeChoice(choice)
    setTheme(currentTheme())
  }

  const toggleTheme = () => {
    chooseTheme(currentTheme() === 'dark' ? 'light' : 'dark')
  }

  const setTrayBadgePref = (on: boolean) => {
    setTrayBadge(on)
    writeSetting('trayBadge', on ? 'on' : 'off')
  }

  const applyCurrency = async (code: string) => {
    try {
      setCurrency(await invoke<CurrencyState>('set_currency', { code }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const openTerminal = (args: string[]) => {
    invoke('open_terminal_command', { args }).catch(err => setError(String(err)))
  }
  const connectClaude = () => {
    invoke('open_claude_login').catch(err => setError(String(err)))
  }

  const selectInsight = (mode: InsightMode) => {
    setInsight(mode)
    writeSetting('insight', mode)
  }

  const tabs = providerTabs(todayPayload)
  // The Plan pill is offered exactly when there is one plan to show. All aggregates several
  // providers and so has no plan of its own, as on the mac.
  const planVisible = planTarget(quota, provider) !== null
  const visibleModes = useMemo(
    () => INSIGHT_ORDER.filter(m => m !== 'plan' || planVisible),
    [planVisible],
  )
  const activeInsight = visibleModes.includes(insight) ? insight : 'trend'

  const cliBlocked = cliStatus !== null && (!cliStatus.found || !cliStatus.compatible)
  // The version gate above is what keeps these fields present; the optional reads are the
  // backstop that turns a surprising payload into an empty state rather than a blank window.
  const isFilteredEmpty = payload !== null && provider !== ALL_PROVIDER
    && (payload.current?.cost ?? 0) <= 0 && (payload.current?.calls ?? 0) === 0
  const neverAnyData = payload !== null && provider === ALL_PROVIDER
    && (payload.current?.calls ?? 0) === 0 && (payload.current?.sessions ?? 0) === 0
    && (payload.history?.daily?.length ?? 0) === 0

  const footnote = [version ? `CodeBurn v${version}` : 'CodeBurn', lastUpdated ? `updated ${relativePast(lastUpdated)}` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="popover">
      <Header
        quota={quota}
        showQuota={!cliBlocked && !showSettings}
        accent={accent}
        onAccent={chooseAccent}
        animate={popoverVisible}
      />

      {!cliBlocked && !showSettings && (
        <AgentTabStrip selected={provider} onSelect={setProvider} payload={todayPayload} currency={currency} quota={quota} />
      )}

      <div className="main-content">
        {showSettings ? (
          <SettingsPanel
            section={settingsSection}
            onBack={() => setShowSettings(false)}
            version={version}
            currency={currency}
            onCurrency={applyCurrency}
            themeChoice={themeChoice}
            onThemeChoice={chooseTheme}
            trayBadge={trayBadge}
            onTrayBadge={setTrayBadgePref}
            cliStatus={cliStatus}
            onCheckCli={checkCli}
            cliChecking={cliChecking}
            onQuit={() => invoke('quit_app').catch(() => {})}
          />
        ) : cliBlocked && cliStatus ? (
          <SetupState status={cliStatus} checking={cliChecking} onCheckAgain={checkCli} />
        ) : (
          <>
            <HeroSection
              payload={payload}
              currency={currency}
              periodLabel={daySelectionLabel(days) ?? PERIOD_LABELS[period]}
              isToday={days.length === 0 && period === 'today'}
              dailyBudget={dailyBudget}
            />
            <PeriodTabs
              selected={period}
              days={days}
              onSelect={p => { setDays([]); setPeriod(p) }}
              onSelectDays={setDays}
            />

            {isFilteredEmpty ? (
              <EmptyProviderState label={providerLabel(tabs, provider)} period={period} />
            ) : neverAnyData ? (
              <NoDataState onRefresh={() => refreshAll({ includeOptimize: true, showOverlay: true })} />
            ) : (
              <>
                <div className="insight-area">
                  <InsightPills selected={activeInsight} onSelect={selectInsight} modes={visibleModes} />
                  {activeInsight === 'plan' && (
                    <PlanInsight
                      payload={payload}
                      currency={currency}
                      provider={provider}
                      quota={quota}
                      onOpenTerminal={openTerminal}
                      onConnectClaude={connectClaude}
                    />
                  )}
                  {activeInsight === 'trend' && (
                    <TrendInsight
                      days={payload?.history?.daily ?? []}
                      currency={currency}
                      dayCount={trendDayCount(period, days, payload?.history?.daily?.length ?? 0)}
                    />
                  )}
                  {activeInsight === 'forecast' && <ForecastInsight days={payload?.history?.daily ?? []} currency={currency} />}
                  {activeInsight === 'calendar' && <CalendarInsight days={payload?.history?.daily ?? []} currency={currency} />}
                  {activeInsight === 'pulse' && payload && <PulseInsight payload={payload} currency={currency} />}
                  {activeInsight === 'stats' && payload && <StatsInsight payload={payload} currency={currency} period={period} />}
                  {activeInsight === 'optimize' && payload && <OptimizeInsight payload={payload} currency={currency} />}
                </div>
                {payload?.current && (
                  <>
                    <ActivitySection payload={payload} currency={currency} />
                    <ModelsSection
                      models={payload.current.topModels}
                      inputTokens={payload.current.inputTokens}
                      outputTokens={payload.current.outputTokens}
                      cacheHitPercent={payload.current.cacheHitPercent}
                      currency={currency}
                    />
                    <PullRequestsSection payload={payload} currency={currency} />
                    <ToolingSection payload={payload} currency={currency} />
                    <FindingsSection payload={payload} currency={currency} onOpenTerminal={openTerminal} />
                  </>
                )}
              </>
            )}
            {overlay && <LoadingOverlay periodLabel={daySelectionLabel(days) ?? PERIOD_LABELS[period]} />}
          </>
        )}
      </div>

      <FooterBar
        currency={currency}
        onCurrency={applyCurrency}
        loading={overlay}
        onRefresh={() => refreshAll({ includeOptimize: true, showOverlay: true })}
        onExport={format => openTerminal(['export', '-f', format])}
        onOpenReport={() => openTerminal(['report'])}
        onToggleTheme={toggleTheme}
        onQuit={() => invoke('quit_app').catch(() => {})}
        themeLabel={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        trayBadge={trayBadge}
        onToggleTrayBadge={() => setTrayBadgePref(!trayBadge)}
        onOpenSettings={() => { setSettingsSection('general'); setShowSettings(s => !s) }}
        settingsOpen={showSettings}
        footnote={footnote}
      />

      <StarBanner />

      {error && <ErrorToast message={error} onDismiss={() => setError(null)} />}
    </div>
  )
}
