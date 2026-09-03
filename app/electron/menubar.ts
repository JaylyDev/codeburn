// The tray app and the Capacity Dock, as the desktop app owns them on Windows.
//
// The desktop app ships the matching `windows-v*` build of the Tauri tray app
// (windows/) and puts it on the machine itself, so nobody has to know that
// `codeburn menubar` exists. Two switches in the sidebar turn each surface off:
// "Menu bar" is the tray process, "Sidebar" is the dock rail the tray app
// draws. Both default on.
//
// Two routes, and they share almost nothing:
//
//   NSIS   the staged `CodeBurn.Menubar_<version>_x64_en-US.msi` is installed
//          through the CLI's own installer (src/menubar-installer.ts, reached
//          with CODEBURN_MENUBAR_MSI). The MSI carries a fixed WiX upgrade
//          code, so a manual `codeburn menubar` install is upgraded in place
//          rather than duplicated, and a newer one is left alone. Launch at
//          login is an HKCU Run value.
//
//   AppX   msiexec is not available to a packaged app and would fight the
//          package manager anyway. The tray exe ships inside the package and
//          is launched from there; launch at login is the manifest's
//          windows.startupTask, so no Run value is written.
//
// The tray app is reached through its own argv: a second launch hands the
// running instance its arguments (windows/src-tauri/src/lib.rs), so `--quit`
// stops it and `--reload-settings` makes it re-read the dock preferences this
// module writes.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { spawnCliAction, type ActionResult } from './cli'
import {
  DEFAULT_TRAY_APP_PREFS, DEFAULT_TRAY_DOCK_PREFS,
  normalizedPreferred, parseTrayAppPrefs, parseTrayDockPrefs, patchTrayFile, readTrayFile,
  sanitizeAppPatch, sanitizeDockPatch, writeFileAtomic, type TrayAppPrefs, type TrayDockPrefs,
} from './tray-settings'

/** Env var the CLI's Windows installer reads; the source of truth is src/menubar-installer.ts. */
export const BUNDLED_MSI_ENV = 'CODEBURN_MENUBAR_MSI'
/** One machine-readable line the same installer prints, so this side need not read its prose. */
export const BUNDLED_RESULT_PREFIX = 'CODEBURN_MENUBAR_RESULT '
/** The release asset name, which is also the only version statement that cannot lie. */
const MSI_PATTERN = /^CodeBurn\.Menubar_(.+)_x64_en-US\.msi$/
/** What the Tauri bundle names its executable. */
const TRAY_EXE = 'codeburn-menubar.exe'
/** The tray app's own Run value name, so the two never write a second copy of each other's. */
const RUN_VALUE = 'CodeBurn'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
/** A `/passive` msiexec run waits on a UAC prompt, which is a person, not a process. */
const INSTALL_TIMEOUT_MS = 5 * 60_000
/** The env var the tray app honours before anything else it looks at (windows/src-tauri/src/cli.rs). */
export const TRAY_CLI_ENV = 'CODEBURN_BIN'
/** Where the desktop app records the launcher in the tray app's own settings file, so an
 *  autostarted tray app finds it with no desktop app running to tell it. */
export const TRAY_CLI_PATH_KEY = 'desktopCliPath'
/** Where main.ts points at the CLI copy shipped inside a packaged build. */
const BUNDLED_CLI_ENV = 'CODEBURN_BUNDLED_CLI'
/** The tray app's own data directory, which already holds its install marker. */
const COMPANION_DIR = 'codeburn-menubar'
/** A `.cmd`, because that is the one kind of script the tray app can start directly. */
const CLI_LAUNCHER_NAME = 'codeburn-cli.cmd'
/** How long a launch that follows a `--quit` waits for the old process to be gone. */
const QUIT_SETTLE_MS = 4_000

/** Mirrors BundledInstallResult in src/menubar-installer.ts. */
export type MenubarInstallResult = {
  action: 'installed' | 'up-to-date' | 'kept-newer' | 'cancelled'
  bundledVersion: string
  previousVersion: string | null
  exePath: string
  uninstallString: string | null
  installedBy: 'desktop' | 'manual' | null
}

/** The desktop app's own record of the two switches, in its userData directory. */
export type CompanionSettings = {
  menuBar: boolean
  sidebar: boolean
  /** Where the tray app ended up, so starting and stopping it costs no registry read. */
  trayExePath: string | null
  /** The tray app version the last install reported at `trayExePath`. A launch whose staged
   *  .msi carries that same version has nothing to install and nothing to ask, so it skips
   *  the probe entirely rather than spawning a CLI to be told so. */
  trayExeVersion: string | null
  /** The staged .msi version whose install was declined or failed. The same file put in
   *  front of the same person at the next launch is the same admin prompt, and answering it
   *  is their decision rather than something to re-ask until they give in. Cleared when a
   *  newer version is staged, or when they turn Menu bar on themselves. */
  installDeclinedVersion: string | null
  /** False until the first launch has applied the defaults, which is what keeps a later
   *  manual "dock off" from being seeded back on at every launch. */
  seeded: boolean
}

export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = {
  menuBar: true,
  sidebar: true,
  trayExePath: null,
  trayExeVersion: null,
  installDeclinedVersion: null,
  seeded: false,
}

export type MenubarDeps = {
  /** Where the packaged app keeps its extraResources, or null in a build that has none. */
  resourcesPath: string | null
  /** The desktop app's userData directory, which holds the companion settings file. */
  stateDir: string
  /** True inside an AppX package: no msiexec, no Run value, the exe ships with the package. */
  store: boolean
  platform: string
  env: NodeJS.ProcessEnv
  /** The desktop app's own executable, which is also the Node that runs the bundled CLI. */
  execPath?: string
  /** Injected so tests never spawn: the CLI action, a detached launch, and a `reg.exe` run. */
  runCli?: (args: string[], opts: { timeoutMs?: number; extraEnv?: NodeJS.ProcessEnv }) => Promise<ActionResult>
  launch?: (exePath: string, args: string[], extraEnv?: NodeJS.ProcessEnv) => void
  runReg?: (args: string[]) => Promise<void>
  /** The tray app's existing Run value, or null when there is none. */
  readRunKey?: () => Promise<string | null>
  /** Whether the tray app has a process right now. Injected so tests never spawn. */
  isRunning?: () => Promise<boolean>
  /** Whether a path is on disk. Injected so the stale-path handling is testable. */
  exists?: (path: string) => boolean
  home?: string
}

// Where things are ----------------------------------------------------------------------------

/** The staged tray app: `resources/menubar` in a packaged build, `build/menubar` in dev. */
export function menubarResourcesDir(deps: Pick<MenubarDeps, 'resourcesPath'>): string {
  return deps.resourcesPath
    ? join(deps.resourcesPath, 'menubar')
    : join(__dirname, '..', '..', 'build', 'menubar')
}

/** The staged .msi and the version its name declares, or null when nothing was staged. */
export function findStagedMsi(dir: string): { path: string; version: string } | null {
  let names: string[]
  try { names = readdirSync(dir) } catch { return null }
  for (const name of names) {
    const version = MSI_PATTERN.exec(name)?.[1]
    if (version) return { path: join(dir, name), version }
  }
  return null
}

/** The tray executable shipped inside an AppX package, or null when it is not there. */
export function findPackagedTrayExe(dir: string): string | null {
  const exe = join(dir, TRAY_EXE)
  return existsSync(exe) ? exe : null
}

/** `~/.config/codeburn/windows-dock.json`, which is where the tray app's dock reads its
 *  preferences from before its page exists (windows/src-tauri/src/dock.rs). */
export function dockPrefsPath(home = homedir()): string {
  return join(home, '.config', 'codeburn', 'windows-dock.json')
}

function companionSettingsPath(stateDir: string): string {
  return join(stateDir, 'companion.v1.json')
}

// The CLI the tray app runs -----------------------------------------------------------------

// The tray app gets everything it shows by spawning `codeburn`, which it looks for on PATH
// and in the usual npm, pnpm, Volta, fnm, scoop and bun locations. Someone who installed only
// the desktop app never ran `npm install -g codeburn`, so there is nothing in any of them, and
// the tray app they were just given has no data to show.
//
// The desktop app has a CLI: the version-matched copy under `resources/cli`, which it runs
// through its own executable with `ELECTRON_RUN_AS_NODE=1` (app/electron/cli.ts). That is not
// something the tray app could spawn on its own, so this side writes a one-line `.cmd` that
// does it and forwards every argument, and records where it put it.
//
// A file rather than an environment variable because the tray app is also started at login, by
// a Run value or the package's startup task, with no desktop app anywhere to hand it an
// environment. The recorded path is consulted last (windows/src-tauri/src/cli.rs), so a real
// global install still wins.

/** `%LOCALAPPDATA%\codeburn-menubar`, the directory the tray app's install marker is in. */
export function companionDataDir(env: NodeJS.ProcessEnv, home: string): string {
  const local = env.LOCALAPPDATA
  const base = local && /^[a-zA-Z]:[\\/]/.test(local) ? local.replace(/[\\/]+$/, '') : join(home, 'AppData', 'Local')
  return join(base, COMPANION_DIR)
}

export function cliLauncherPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(companionDataDir(env, home), CLI_LAUNCHER_NAME)
}

/**
 * Anything `cmd.exe` would read rather than pass along. Both paths come from the app's own
 * install location, so this never fires in practice; it is here because the alternative to
 * failing is writing a batch file that means something other than what it says.
 */
const CMD_UNQUOTABLE = /["%\r\n]/

/** The launcher's contents. `%*` forwards the arguments verbatim, stdio is inherited, and
 *  the CLI's exit code becomes the launcher's. */
export function cliLauncherScript(execPath: string, entry: string): string | null {
  if (!execPath || !entry || CMD_UNQUOTABLE.test(execPath) || CMD_UNQUOTABLE.test(entry)) return null
  return [
    '@echo off',
    'rem Written by the CodeBurn desktop app, and rewritten at every one of its launches.',
    'rem It runs the CLI the desktop app carries, through the desktop app\'s own executable.',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${execPath}" "${entry}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

/**
 * Write the launcher and hand back its path, or null when there is nothing to point it at:
 * off Windows, or in a dev build, where `CODEBURN_BUNDLED_CLI` is unset because the repo's
 * own CLI is used instead and is already on the machine.
 */
export function writeCliLauncher(opts: {
  platform: string
  env: NodeJS.ProcessEnv
  home: string
  execPath: string
  exists?: (path: string) => boolean
}): string | null {
  if (opts.platform !== 'win32') return null
  const entry = opts.env[BUNDLED_CLI_ENV]
  const exists = opts.exists ?? existsSync
  if (!entry || !exists(entry)) return null
  const script = cliLauncherScript(opts.execPath, entry)
  if (!script) return null

  const path = cliLauncherPath(opts.env, opts.home)
  try {
    // Rewritten at every launch while an autostarted tray app may be reading it.
    writeFileAtomic(path, script)
    return path
  } catch (err) {
    console.error('the tray app could not be given a CLI to run:', err)
    return null
  }
}

// Settings -------------------------------------------------------------------------------------

export function readCompanionSettings(stateDir: string): CompanionSettings {
  try {
    // An unreadable file falls back to the defaults, which means seeding again: reinstalling
    // the tray app and re-enabling the rail. A byte order mark is not a good enough reason
    // for that, and anything that edits this file by hand on Windows tends to leave one.
    const text = readFileSync(companionSettingsPath(stateDir), 'utf8').replace(/^﻿/, '')
    const raw = JSON.parse(text) as Partial<CompanionSettings>
    return {
      menuBar: raw.menuBar ?? DEFAULT_COMPANION_SETTINGS.menuBar,
      sidebar: raw.sidebar ?? DEFAULT_COMPANION_SETTINGS.sidebar,
      trayExePath: typeof raw.trayExePath === 'string' ? raw.trayExePath : null,
      trayExeVersion: typeof raw.trayExeVersion === 'string' ? raw.trayExeVersion : null,
      installDeclinedVersion: typeof raw.installDeclinedVersion === 'string' ? raw.installDeclinedVersion : null,
      seeded: raw.seeded === true,
    }
  } catch {
    return { ...DEFAULT_COMPANION_SETTINGS }
  }
}

export function writeCompanionSettings(stateDir: string, settings: CompanionSettings): void {
  try {
    writeFileAtomic(companionSettingsPath(stateDir), `${JSON.stringify(settings, null, 2)}\n`)
  } catch (err) {
    console.error('companion settings could not be saved:', err)
  }
}

/** Whether the tray app already has an opinion about the rail, or undefined when nobody has
 *  said. The difference matters exactly once: a default is for a machine that has made no
 *  choice, never an override of one already made. */
export function readDockEnabled(home = homedir()): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const enabled = (parsed as Record<string, unknown>).enabled
    return typeof enabled === 'boolean' ? enabled : undefined
  } catch {
    return undefined
  }
}

/** Read, change one key, write back. The tray app owns every other key in this file (the
 *  rail's placement, size and provider set), so the whole object is preserved. */
export function writeDockEnabled(enabled: boolean, home = homedir()): void {
  const path = dockPrefsPath(home)
  let prefs: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed as Record<string, unknown>
  } catch { /* a missing or unreadable file simply starts from nothing */ }
  prefs.enabled = enabled
  writeFileAtomic(path, `${JSON.stringify(prefs, null, 2)}\n`)
}

// Talking to the tray app ----------------------------------------------------------------------

/** The CLI's install path prints one JSON line; everything else it says is for a person. */
export function parseInstallResult(stdout: string): MenubarInstallResult | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(BUNDLED_RESULT_PREFIX)) continue
    try { return JSON.parse(line.slice(BUNDLED_RESULT_PREFIX.length)) as MenubarInstallResult } catch { return null }
  }
  return null
}

/** `reg.exe` argv for the tray app's launch-at-login value. The tray app's own toggle writes
 *  the same value name (windows/src-tauri/src/autostart.rs), so the two agree by construction
 *  instead of leaving two entries behind. */
export function runKeyArgs(enabled: boolean, exePath: string): string[] {
  return enabled
    ? ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${exePath}"`, '/f']
    : ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']
}

/** `reg query <key> /v CodeBurn` prints the value on its own indented line. Null means the
 *  value is not there, which is the only thing the caller acts on. */
export function parseRunKeyValue(regOutput: string): string | null {
  const match = new RegExp(`^\\s+${RUN_VALUE}\\s{4}REG_\\w+\\s{4}(.*)$`, 'm').exec(regOutput)
  const value = match?.[1]?.trim()
  return value ? value : null
}

/** The executable a Run value points at: it is stored quoted, and only the file matters. */
export function runKeyTarget(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1')
}

/** Windows searches the current directory before PATH, so `reg` by bare name lets anything
 *  dropped beside the app impersonate it. Same rule as src/menubar-installer.ts. */
export function system32Path(exe: string, env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot
  const base = root && /^[a-zA-Z]:[\\/]/.test(root) ? root.replace(/[\\/]+$/, '') : 'C:\\Windows'
  return `${base}\\System32\\${exe}`
}

function detachedLaunch(exePath: string, args: string[], extraEnv?: NodeJS.ProcessEnv): void {
  try {
    const child = spawn(exePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    })
    child.on('error', err => console.error(`could not launch ${exePath}: ${err.message}`))
    child.unref()
  } catch (err) {
    console.error(`could not launch ${exePath}:`, err)
  }
}

function regRun(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise(resolve => {
    const child = spawn(system32Path('reg.exe', env), args, { stdio: 'ignore', windowsHide: true })
    // Deleting a value that is not there is the state we wanted anyway, so no exit code is
    // read: a failure here must never stop a toggle the person just flipped.
    child.on('error', () => resolve())
    child.on('close', () => resolve())
  })
}

/** `tasklist` filtered to the tray exe prints its name when it is running and a "No tasks"
 *  line when it is not. Anything going wrong reads as not running, which only shortens a wait. */
function trayHasProcess(env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn(system32Path('tasklist.exe', env), ['/FI', `IMAGENAME eq ${TRAY_EXE}`, '/NH'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { out += chunk })
      child.on('error', () => resolve(false))
      child.on('close', () => resolve(out.toLowerCase().includes(TRAY_EXE)))
    } catch {
      resolve(false)
    }
  })
}

function regQueryRunValue(env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(system32Path('reg.exe', env), ['query', RUN_KEY, '/v', RUN_VALUE], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { out += chunk })
    child.on('error', () => resolve(null))
    // reg exits non-zero for a value that is not there, which is the answer rather than a
    // failure; anything else that goes wrong reads the same way, and the only cost of
    // guessing "absent" is one write of a value that already said the same thing.
    child.on('close', code => resolve(code === 0 ? parseRunKeyValue(out) : null))
  })
}

// The controller ---------------------------------------------------------------------------------

/** What the two tray panes in the desktop app's Settings render from. */
export type TrayPrefs = {
  app: TrayAppPrefs
  dock: TrayDockPrefs
  launchAtLogin: boolean
  /**
   * True where launch at login is not this app's to set. The Store package declares it as a
   * `windows.startupTask` (app/build/appx-extensions.xml) and Windows owns both the state and
   * the switch, in Settings > Apps > Startup. Reaching a startup task from here would take
   * the WinRT `Windows.ApplicationModel.StartupTask` API, which Electron has no binding for
   * and which this app ships no native code to reach; and a Run value written beside the
   * startup task would start the tray app twice. So the pane names the owner and points at
   * that page rather than offering a switch that moves nothing.
   */
  launchAtLoginManaged: boolean
}

/** The Windows Settings page listing every startup app, the Store package's own included.
 *  Named here because the desktop app's external-open guard allows it by exact value. */
export const STARTUP_APPS_SETTINGS_URL = 'ms-settings:startupapps'

/**
 * What the four tray-preference methods answer where there is no tray app. Every one of them
 * reads or writes `~/.config/codeburn/windows-*.json` or `reg.exe`, all of which belong to a
 * Windows tray app that a macOS or Linux build has never installed; their IPC handlers are
 * registered on every platform, so the guard has to be here rather than at the call site.
 * The defaults are what the same files parse to when they are not there, so a pane rendering
 * this shows the same thing it would on a Windows machine with nothing written yet.
 */
export function unsupportedTrayPrefs(): TrayPrefs {
  return {
    app: { ...DEFAULT_TRAY_APP_PREFS },
    dock: { ...DEFAULT_TRAY_DOCK_PREFS },
    launchAtLogin: false,
    launchAtLoginManaged: false,
  }
}

export type CompanionStatus = {
  /** False on every platform but Windows, and on a Windows build with nothing staged. */
  supported: boolean
  menuBar: boolean
  sidebar: boolean
  /** The Store route, where launch at login is the package's own startup task. */
  store: boolean
}

export class MenubarCompanion {
  private settings: CompanionSettings
  /** When `--quit` was last sent, so a launch right after it can wait for the exit. */
  private quitAskedAt = 0
  /** The launcher written for the tray app this run, or null when there is no bundled CLI
   *  to point one at. Handed to every tray app this side starts. */
  private cliLauncher: string | null = null

  constructor(private readonly deps: MenubarDeps) {
    this.settings = readCompanionSettings(deps.stateDir)
  }

  private get home(): string { return this.deps.home ?? homedir() }
  private get launch(): (exe: string, args: string[], extraEnv?: NodeJS.ProcessEnv) => void {
    return this.deps.launch ?? detachedLaunch
  }

  /**
   * What a tray app started from here inherits. The recorded path in the settings file is
   * what an autostarted tray app reads, and it is read after PATH; this makes the very first
   * launch work too, before the tray app has read anything at all.
   */
  private launchEnv(): NodeJS.ProcessEnv | undefined {
    return this.cliLauncher ? { [TRAY_CLI_ENV]: this.cliLauncher } : undefined
  }

  /**
   * Rewrite the launcher and record where it is. Runs at every bootstrap, so a desktop app
   * that has been updated points the tray app at its new copy of the CLI rather than at the
   * one the previous version installed.
   */
  private refreshCliLauncher(): void {
    this.cliLauncher = writeCliLauncher({
      platform: this.deps.platform,
      env: this.deps.env,
      home: this.home,
      execPath: this.deps.execPath ?? process.execPath,
      exists: this.exists,
    })
    if (!this.cliLauncher) return
    try {
      patchTrayFile('app', { [TRAY_CLI_PATH_KEY]: this.cliLauncher }, this.home)
    } catch (err) {
      console.error('the tray app could not be told where its CLI is:', err)
    }
  }
  private get isRunning(): () => Promise<boolean> {
    return this.deps.isRunning ?? (() => trayHasProcess(this.deps.env))
  }

  /**
   * A `--quit` takes the tray app a moment to act on, and a launch that arrives while the old
   * process is still on its way out hands its request to that process (its single-instance
   * window is still there) and exits with it, leaving the switch on and nothing running. So a
   * launch that follows a quit waits for the process to be gone first, within reason.
   */
  private async awaitQuit(): Promise<void> {
    if (Date.now() - this.quitAskedAt > QUIT_SETTLE_MS) return
    const deadline = Date.now() + QUIT_SETTLE_MS
    while (Date.now() < deadline && await this.isRunning()) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  private get runCli() { return this.deps.runCli ?? spawnCliAction }
  private runReg(args: string[]): Promise<void> {
    return this.deps.runReg ? this.deps.runReg(args) : regRun(args, this.deps.env)
  }

  /** Windows only, and only where a tray app was actually staged into the build. */
  supported(): boolean {
    if (this.deps.platform !== 'win32') return false
    const dir = menubarResourcesDir(this.deps)
    return this.deps.store ? findPackagedTrayExe(dir) !== null : findStagedMsi(dir) !== null
  }

  status(): CompanionStatus {
    return {
      supported: this.supported(),
      menuBar: this.settings.menuBar,
      sidebar: this.settings.sidebar,
      store: this.deps.store,
    }
  }

  private save(patch: Partial<CompanionSettings>): void {
    this.settings = { ...this.settings, ...patch }
    writeCompanionSettings(this.deps.stateDir, this.settings)
  }

  /**
   * Put the tray app on the machine and bring both surfaces in line with the switches. Runs
   * at every launch, which is also what covers a desktop-app update: the staged .msi moves
   * with the app, and the installer decides for itself whether it is newer than what is
   * installed. The install itself is not re-run at every launch; see
   * {@link MenubarCompanion.installIfNeeded}.
   */
  async bootstrap(): Promise<void> {
    if (!this.supported()) return

    // Before anything else, and whether or not the switch is on: a tray app started at the
    // next login has to find a CLI without this process being there to tell it.
    this.refreshCliLauncher()

    // The defaults are seeded once, and only onto a machine that has made no choice. A tray
    // app someone installed by hand has preferences of its own, and a default that overrode
    // them would be this app deciding something the person already decided.
    const firstRun = !this.settings.seeded
    const existingDock = firstRun ? readDockEnabled(this.home) : undefined
    if (firstRun) {
      // An existing rail preference is mirrored into the switch rather than overwritten, so
      // the corner opens saying what the rail is actually doing.
      this.save({ seeded: true, ...(existingDock === undefined ? {} : { sidebar: existingDock }) })
    }

    if (!this.settings.menuBar) return

    const exePath = this.deps.store
      ? findPackagedTrayExe(menubarResourcesDir(this.deps))
      : await this.installIfNeeded()
    if (!exePath) return
    if (!this.exists(exePath)) {
      // Storing a path to nothing is what made the switches send arguments into the void.
      console.error(`the tray app was reported at ${exePath}, which is not there`)
      return
    }
    this.save({ trayExePath: exePath })

    if (firstRun && existingDock === undefined && this.settings.sidebar) this.applyDockSetting(true)
    await this.reconcileRunKey(firstRun)
    this.launch(exePath, ['--reload-settings'], this.launchEnv())
  }

  /**
   * Launch at login, without overriding a choice. An existing Run value was written by the
   * tray app's own toggle or by an earlier launch of this one, so it is left alone; only a
   * first run seeds one. The exception is a value pointing at a file that is not there, which
   * is not a preference but the old wrong path, and would fail silently at every login.
   */
  private async reconcileRunKey(firstRun: boolean): Promise<void> {
    const existing = await this.existingRunKey()
    if (existing === null) {
      if (firstRun) await this.setRunKey(true)
      return
    }
    if (!this.exists(runKeyTarget(existing))) await this.setRunKey(true)
  }

  private existingRunKey(): Promise<string | null> {
    if (this.deps.readRunKey) return this.deps.readRunKey()
    // The Store route has no Run value at all, so there is nothing to ask about.
    return this.deps.store ? Promise.resolve(null) : regQueryRunValue(this.deps.env)
  }

  private get exists(): (path: string) => boolean {
    return this.deps.exists ?? existsSync
  }

  /**
   * Where the tray app actually is, checked rather than remembered. A stored path can be
   * wrong: written by a build that derived the binary name from the product name, or left
   * behind by a tray app that has since been uninstalled. Re-resolving costs one
   * `codeburn menubar`, which re-reads the registry and installs nothing when the version
   * already matches.
   */
  private async resolveTrayExe(): Promise<string | null> {
    if (this.deps.store) return findPackagedTrayExe(menubarResourcesDir(this.deps))
    const stored = this.settings.trayExePath
    if (stored && this.exists(stored)) return stored
    const resolved = await this.installIfNeeded()
    return resolved && this.exists(resolved) ? resolved : null
  }

  /**
   * The install, minus the launches that have nothing to install.
   *
   * `codeburn menubar` is not free and it is not quiet: a real install runs msiexec
   * `/passive`, which puts an admin prompt in front of the person. Two launches are skipped
   * outright:
   *
   *   - the tray app recorded on this machine is already the version this build stages, and
   *     it is still on disk, so the CLI would read the registry and answer "up to date";
   *   - this exact staged version was already declined or failed. Putting the same prompt up
   *     again at every launch is asking the same question until the answer changes, and the
   *     first answer was theirs to give.
   *
   * A newer staged version is a different question and is always asked. So is the Menu bar
   * switch going on by hand, which clears the record before it gets here.
   */
  private async installIfNeeded(): Promise<string | null> {
    const staged = findStagedMsi(menubarResourcesDir(this.deps))
    if (!staged) return null

    const stored = this.settings.trayExePath
    if (stored && this.settings.trayExeVersion === staged.version && this.exists(stored)) return stored
    if (this.settings.installDeclinedVersion === staged.version) return stored

    return this.install(staged)
  }

  /** The install itself belongs to the CLI: it owns the registry read, the checksum, the
   *  msiexec call and the never-downgrade rule, and this side only stages the file and
   *  records what came back. */
  private async install(staged: { path: string; version: string }): Promise<string | null> {
    const result = await this.runCli(['menubar'], {
      timeoutMs: INSTALL_TIMEOUT_MS,
      extraEnv: { [BUNDLED_MSI_ENV]: staged.path },
    })
    const parsed = parseInstallResult(result.stdout)
    if (!parsed) {
      console.error(`menubar install did not report a result: ${result.stderr.trim() || `exit ${String(result.code)}`}`)
      // A failure is remembered the same way a refusal is: whatever went wrong will go wrong
      // again with the same file, and retrying it at every launch only repeats the prompt.
      this.save({ installDeclinedVersion: staged.version })
      // A failed install must not orphan a working tray app that was already there.
      return this.settings.trayExePath
    }
    if (parsed.action === 'cancelled') {
      this.save({ installDeclinedVersion: staged.version })
      return null
    }
    const exePath = parsed.exePath || this.settings.trayExePath
    this.save({
      installDeclinedVersion: null,
      // What is actually on disk now, which is the staged version except under
      // 'kept-newer', where a newer tray app was left alone.
      trayExeVersion: exePath ? (parsed.action === 'kept-newer' ? parsed.previousVersion : staged.version) : null,
    })
    return exePath
  }

  /**
   * Menu bar off stops the process and drops the Run value; on installs if it has to, then
   * starts it again.
   *
   * The rail is a window of the tray app, so it cannot outlive it: turning Menu bar off turns
   * Sidebar off with it. The preference is written before the process is asked to quit, so
   * what the tray app finds the next time it starts is the state the switches are showing,
   * rather than a rail that comes back on its own.
   */
  async setMenuBarEnabled(enabled: boolean): Promise<CompanionStatus> {
    this.save({ menuBar: enabled })
    if (!this.supported()) return this.status()

    if (!enabled) {
      this.save({ sidebar: false })
      this.applyDockSetting(false)
      await this.setRunKey(false)
      const exePath = this.settings.trayExePath
      if (exePath && this.exists(exePath)) {
        this.launch(exePath, ['--quit'])
        this.quitAskedAt = Date.now()
      }
      return this.status()
    }

    // Turning the switch on by hand is the retry: an install that was declined or failed is
    // offered again, because this time they asked for it rather than being asked.
    this.save({ installDeclinedVersion: null })
    const exePath = await this.resolveTrayExe()
    if (!exePath) {
      // Nothing to turn on. The switch says so rather than claiming a tray app that is not
      // there, and Sidebar cannot be on without one either.
      this.save({ menuBar: false })
      return this.status()
    }
    this.save({ trayExePath: exePath })
    await this.setRunKey(true)
    await this.awaitQuit()
    this.launch(exePath, ['--reload-settings'], this.launchEnv())
    return this.status()
  }

  /**
   * The rail is a window of the tray app and every setting it reads belongs to the tray app,
   * so there is no rail without one. Turning Sidebar on with Menu bar off turns Menu bar on
   * first, installing and starting the tray app if it has to; if that cannot be done there is
   * nothing to show a rail in, and the switch stays off.
   */
  async setSidebarEnabled(enabled: boolean): Promise<CompanionStatus> {
    if (!this.supported()) {
      this.save({ sidebar: enabled })
      return this.status()
    }

    if (enabled && !this.settings.menuBar) {
      await this.setMenuBarEnabled(true)
      if (!this.settings.menuBar) return this.status()
    }

    this.save({ sidebar: enabled })
    this.applyDockSetting(enabled)
    if (!this.settings.menuBar) return this.status()
    // The file is written either way; this only decides whether a running rail hears about
    // it now or at the next launch, so a tray app that cannot be found is not worth an
    // install here.
    const exePath = await this.resolveTrayExe()
    if (exePath) {
      this.save({ trayExePath: exePath })
      this.launch(exePath, ['--reload-settings'], this.launchEnv())
    }
    return this.status()
  }

  // The tray app's own settings ------------------------------------------------------------

  /** Everything the two tray panes render from, read straight out of the files the tray app
   *  reads them from, so the panes and the tray app can never be showing different answers. */
  async trayPrefs(): Promise<TrayPrefs> {
    if (!this.supported()) return unsupportedTrayPrefs()
    return {
      app: parseTrayAppPrefs(readTrayFile('app', this.home)),
      dock: parseTrayDockPrefs(readTrayFile('dock', this.home)),
      // On the Store route there is no Run value and no way to ask Windows about the
      // package's startup task, so this is not a state to render: `launchAtLoginManaged`
      // is what the pane goes by there.
      launchAtLogin: (await this.existingRunKey()) !== null,
      launchAtLoginManaged: this.deps.store,
    }
  }

  /** A setting the tray app keeps in `windows-settings.json`. Every other key in that file
   *  is left alone, and the running tray app is told to re-read it. */
  async setTrayAppPref(patch: Record<string, unknown>): Promise<TrayPrefs> {
    if (!this.supported()) return unsupportedTrayPrefs()
    const clean = sanitizeAppPatch(patch)
    if (Object.keys(clean).length > 0) {
      try {
        patchTrayFile('app', clean, this.home)
        await this.nudgeTray()
      } catch (err) {
        console.error('tray settings could not be saved:', err)
      }
    }
    return this.trayPrefs()
  }

  /**
   * A Capacity Dock setting. `enabled` is the Sidebar switch under another name, so it goes
   * through the same path and keeps the rule that the rail cannot outlive the tray app.
   * A provider set that no longer holds the resting provider moves it, as the rail would.
   */
  async setTrayDockPref(patch: Record<string, unknown>): Promise<TrayPrefs> {
    if (!this.supported()) return unsupportedTrayPrefs()
    if ('enabled' in patch) {
      await this.setSidebarEnabled(patch.enabled === true)
      return this.trayPrefs()
    }
    const clean = sanitizeDockPatch(patch)
    if (Object.keys(clean).length > 0) {
      try {
        if (Array.isArray(clean.providers)) {
          const current = parseTrayDockPrefs(readTrayFile('dock', this.home))
          clean.preferred = normalizedPreferred(current.preferred, clean.providers as string[])
        }
        patchTrayFile('dock', clean, this.home)
        await this.nudgeTray()
      } catch (err) {
        console.error('Capacity Dock settings could not be saved:', err)
      }
    }
    return this.trayPrefs()
  }

  /** Launch at login is the one tray setting that is not in a file: it is the Run value, and
   *  this app owns it, so the pane writes it here rather than through the tray app. Not on
   *  the Store route, where Windows owns it: see {@link TrayPrefs.launchAtLoginManaged}. */
  async setLaunchAtLogin(enabled: boolean): Promise<TrayPrefs> {
    if (!this.supported()) return unsupportedTrayPrefs()
    if (!this.deps.store) await this.setRunKey(enabled)
    return this.trayPrefs()
  }

  /** Makes a running tray app re-read both preference files and repaint. Nothing to do when
   *  the switch is off or the executable is not there; the files are read at the next start. */
  private async nudgeTray(): Promise<void> {
    if (!this.settings.menuBar) return
    const exePath = this.settings.trayExePath
    if (exePath && this.exists(exePath)) this.launch(exePath, ['--reload-settings'], this.launchEnv())
  }

  private applyDockSetting(enabled: boolean): void {
    try {
      writeDockEnabled(enabled, this.home)
    } catch (err) {
      console.error('Capacity Dock preference could not be saved:', err)
    }
  }

  /** One Run value for the tray app, owned here. The Store route has the manifest's own
   *  startup task instead, and writing a Run value beside it would start it twice. */
  private async setRunKey(enabled: boolean): Promise<void> {
    if (this.deps.store) return
    const exePath = this.settings.trayExePath
    if (enabled && !exePath) return
    await this.runReg(runKeyArgs(enabled, exePath ?? ''))
  }
}
