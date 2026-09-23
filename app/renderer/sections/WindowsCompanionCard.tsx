import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Icon } from '../components/icons'
import { t } from '../i18n'
import { codeburn } from '../lib/ipc'
import type { CompanionStatus } from '../lib/types'
import { MenuBarAboutModal } from './MenuBarAbout'
import styles from './Plugins.module.css'
import menubarArt from '../assets/menubar-card-art.jpg'
import menubarArtLight from '../assets/menubar-card-art-light.jpg'

/**
 * The Windows tray app ("Menu bar") and the Capacity Dock rail it draws, as one card on the
 * Plugins page, so Windows configures its companion the same place macOS does (MenuBarCard).
 * The discrete actions map to windows/ semantics: Install/Reinstall stages and runs the bundled
 * MSI; Open shows the tray popover (a bare relaunch); Quit stops the process without uninstalling
 * or dropping launch-at-login; Uninstall runs msiexec /x; Settings opens the desktop app's own
 * Menu bar pane (the tray's settings live there on Windows, not in a separate window). Update is
 * the same Install path against a newer bundled MSI, not the tray's own GitHub self-updater,
 * which the Windows distribution policy leaves off.
 */
const POLL_MS = 4000

type Action = 'install' | 'open' | 'dock' | 'quit' | 'uninstall' | 'update'

/** Polls only while mounted and visible, and never sets state to a value equal to the one held,
 *  so a still machine re-renders zero times. Mirrors the macOS card's hook. */
function useCompanionStatus(): [CompanionStatus | null, (next: CompanionStatus) => void, () => void] {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const held = useRef<string>('')

  const apply = (next: CompanionStatus) => {
    const key = JSON.stringify(next)
    if (key === held.current) return
    held.current = key
    setStatus(next)
  }

  const refresh = () => {
    void codeburn?.companionStatus?.().then(apply).catch(() => {})
  }

  useEffect(() => {
    let live = true
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void codeburn?.companionStatus?.().then(next => { if (live) apply(next) }).catch(() => {})
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => { live = false; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return [status, apply, refresh]
}

export function WindowsCompanionCard({ onOpenSettings, art = menubarArt, artLight = menubarArtLight }: {
  onOpenSettings?: () => void
  art?: string
  artLight?: string
} = {}) {
  const [status, apply, refresh] = useCompanionStatus()
  const [busy, setBusy] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Quit and Uninstall confirm in the card, the same way removing a plugin does on this page.
  const [confirming, setConfirming] = useState<'quit' | 'uninstall' | null>(null)
  const [about, setAbout] = useState(false)

  if (!status?.supported) return null

  const act = async (kind: Action, call: () => Promise<void>) => {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      await call()
    } catch {
      setError(t('plugins.menuBar.errorGeneric'))
    } finally {
      setBusy(null)
      setConfirming(null)
      refresh()
    }
  }

  const install = (kind: 'install' | 'update') => act(kind, async () => {
    const result = await codeburn.companionInstall?.()
    if (!result) return
    apply(result.status)
    if (!result.ok) setError(result.error ?? t('plugins.menuBar.errorInstall'))
  })

  const open = () => act('open', async () => {
    const next = await codeburn.companionOpen?.()
    if (next) apply(next)
  })

  const toggleDock = () => act('dock', async () => {
    const next = await codeburn.companionSetDock?.(!status.sidebar)
    if (next) apply(next)
  })

  const quit = () => act('quit', async () => {
    const result = await codeburn.companionQuit?.()
    if (!result) return
    apply(result.status)
    if (!result.ok) setError(result.error ?? t('plugins.menuBar.errorQuit'))
  })

  const uninstall = () => act('uninstall', async () => {
    const result = await codeburn.companionUninstall?.()
    if (!result) return
    apply(result.status)
    if (!result.ok) setError(result.error ?? t('plugins.menuBar.errorUninstall'))
  })

  const restartHint = status.restartRequired ? t('shell.sidebar.restartRequired') : ''

  return (
    <div
      className={`${styles.row} ${styles.art} ${styles.companionCard}`}
      style={{
        '--card-art': `url(${art})`,
        '--card-art-light': `url(${artLight})`,
        '--art-light-wash': .84,
      } as CSSProperties}
      data-status="loaded"
    >
      <div className={`${styles.info} ${styles.menubarInfo}`}>
        <div className={styles.nameRow}>
          <div className={styles.name}>{t('plugins.menuBar.name')}</div>
          <button
            type="button"
            className={`ov-info ${styles.infoDot}`}
            aria-label={t('plugins.menuBar.aboutAria')}
            onClick={() => setAbout(true)}
          >
            <Icon name="info" />
          </button>
        </div>
        <div className={`${styles.reason} ${styles.reasonFull}`}>
          {t('shell.sidebar.menuBarHint')}
        </div>
        {/* One note row, always present, so the card is the same height in every state. An error
            answers something the person just pressed, so it wins over the restart hint. */}
        <div className={styles.note} data-kind={error ? 'error' : 'hint'} title={error ?? undefined}>
          {error ?? restartHint}
        </div>
        <div className={styles.caps}>
          {status.running && (
            <span className={styles.running}><span className={styles.runningDot} />{t('plugins.menuBar.running')}</span>
          )}
          {status.version && <span>v{status.version}</span>}
        </div>
      </div>
      <div className={styles.controls}>
        {status.installed && (
          <label className={styles.dockToggle}>
            <span>{t('plugins.menuBar.capacityDock')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={status.sidebar}
              aria-label={t('plugins.menuBar.capacityDock')}
              disabled={busy !== null || !status.running || status.restartRequired}
              title={status.running ? t('plugins.menuBar.dockShowTitle') : t('plugins.menuBar.dockOpenTitle')}
              className={status.sidebar ? 'switch sm on' : 'switch sm'}
              onClick={toggleDock}
            >
              <span className="switch-knob" />
            </button>
          </label>
        )}
        <div className={styles.actions}>
          {status.installed ? (
            <>
              {status.outdated && status.canInstall && (
                <button className={`btnp ${styles.primary}`} onClick={() => install('update')} disabled={busy !== null}>
                  {busy === 'update' ? `${t('plugins.menuBar.updating')}…` : t('plugins.menuBar.update')}
                </button>
              )}
              {/* No window to bring forward while it is up, so Open shows only while it is down;
                  Settings and Quit while it is up. Uninstall shows in both. */}
              {!status.running && (
                <button
                  type="button"
                  className={`btnp ${styles.iconBtn}`}
                  aria-label={t('plugins.menuBar.openAria')}
                  title={t('plugins.menuBar.openTitle')}
                  disabled={busy !== null || status.restartRequired}
                  onClick={open}
                >
                  <Icon name="arrow-up-right" />
                </button>
              )}
              {status.running && onOpenSettings && (
                <button
                  type="button"
                  className={`btnp ${styles.iconBtn}`}
                  aria-label={t('plugins.menuBar.settingsAria')}
                  title={t('plugins.menuBar.settingsTitle')}
                  disabled={busy !== null}
                  onClick={onOpenSettings}
                >
                  <Icon name="settings" />
                </button>
              )}
              {/* Destructive, so a light guard: the first click arms the icon (it swaps to a
                  check), a second confirms, and moving focus away disarms it. */}
              {status.running && (
                <button
                  type="button"
                  className={confirming === 'quit' ? `btnp ${styles.iconBtn} ${styles.confirming}` : `btnp ${styles.iconBtn}`}
                  aria-label={confirming === 'quit' ? t('plugins.menuBar.confirmQuit') : t('plugins.menuBar.quit')}
                  title={confirming === 'quit' ? t('plugins.menuBar.clickAgainQuit') : t('plugins.menuBar.quit')}
                  disabled={busy !== null}
                  onClick={() => (confirming === 'quit' ? quit() : setConfirming('quit'))}
                  onBlur={() => setConfirming(current => (current === 'quit' ? null : current))}
                >
                  <Icon name={confirming === 'quit' ? 'circle-check' : 'x'} />
                </button>
              )}
              {status.canInstall && (
                <button
                  type="button"
                  className={confirming === 'uninstall' ? `btnp ${styles.iconBtn} ${styles.confirming}` : `btnp ${styles.iconBtn}`}
                  aria-label={confirming === 'uninstall' ? t('plugins.menuBar.confirmUninstall') : t('plugins.menuBar.uninstall')}
                  title={confirming === 'uninstall' ? t('plugins.menuBar.clickAgainUninstall') : t('plugins.menuBar.uninstall')}
                  disabled={busy !== null}
                  onClick={() => (confirming === 'uninstall' ? uninstall() : setConfirming('uninstall'))}
                  onBlur={() => setConfirming(current => (current === 'uninstall' ? null : current))}
                >
                  <Icon name={confirming === 'uninstall' ? 'circle-check' : 'trash-2'} />
                </button>
              )}
            </>
          ) : status.canInstall ? (
            <button className={`btnp ${styles.primary}`} onClick={() => install('install')} disabled={busy !== null}>
              {busy === 'install' ? `${t('plugins.menuBar.installing')}…` : t('plugins.menuBar.install')}
            </button>
          ) : (
            <span className={styles.website}>{t('plugins.menuBar.website')}</span>
          )}
        </div>
      </div>
      {about && <MenuBarAboutModal onClose={() => setAbout(false)} />}
    </div>
  )
}
