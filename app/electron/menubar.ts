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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { spawnCliAction, type ActionResult } from './cli'

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
  /** False until the first launch has applied the defaults, which is what keeps a later
   *  manual "dock off" from being seeded back on at every launch. */
  seeded: boolean
}

export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = {
  menuBar: true,
  sidebar: true,
  trayExePath: null,
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
  /** Injected so tests never spawn: the CLI action, a detached launch, and a `reg.exe` run. */
  runCli?: (args: string[], opts: { timeoutMs?: number; extraEnv?: NodeJS.ProcessEnv }) => Promise<ActionResult>
  launch?: (exePath: string, args: string[]) => void
  runReg?: (args: string[]) => Promise<void>
  /** The tray app's existing Run value, or null when there is none. */
  readRunKey?: () => Promise<string | null>
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
      seeded: raw.seeded === true,
    }
  } catch {
    return { ...DEFAULT_COMPANION_SETTINGS }
  }
}

export function writeCompanionSettings(stateDir: string, settings: CompanionSettings): void {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(companionSettingsPath(stateDir), `${JSON.stringify(settings, null, 2)}\n`)
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
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(prefs, null, 2)}\n`)
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

function detachedLaunch(exePath: string, args: string[]): void {
  try {
    const child = spawn(exePath, args, { detached: true, stdio: 'ignore', windowsHide: true })
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

  constructor(private readonly deps: MenubarDeps) {
    this.settings = readCompanionSettings(deps.stateDir)
  }

  private get home(): string { return this.deps.home ?? homedir() }
  private get launch(): (exe: string, args: string[]) => void { return this.deps.launch ?? detachedLaunch }
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
   * installed.
   */
  async bootstrap(): Promise<void> {
    if (!this.supported()) return

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

    // The install runs on every launch, not only when a path is missing: it is what carries a
    // desktop-app update forward, and it costs nothing when the versions already match.
    const exePath = this.deps.store
      ? findPackagedTrayExe(menubarResourcesDir(this.deps))
      : await this.install()
    if (!exePath) return
    if (!this.exists(exePath)) {
      // Storing a path to nothing is what made the switches send arguments into the void.
      console.error(`the tray app was reported at ${exePath}, which is not there`)
      return
    }
    this.save({ trayExePath: exePath })

    if (firstRun && existingDock === undefined && this.settings.sidebar) this.applyDockSetting(true)
    await this.reconcileRunKey(firstRun)
    this.launch(exePath, ['--reload-settings'])
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
    const resolved = await this.install()
    return resolved && this.exists(resolved) ? resolved : null
  }

  /** The install itself belongs to the CLI: it owns the registry read, the checksum, the
   *  msiexec call and the never-downgrade rule, and this side only stages the file. */
  private async install(): Promise<string | null> {
    const staged = findStagedMsi(menubarResourcesDir(this.deps))
    if (!staged) return null

    const result = await this.runCli(['menubar'], {
      timeoutMs: INSTALL_TIMEOUT_MS,
      extraEnv: { [BUNDLED_MSI_ENV]: staged.path },
    })
    const parsed = parseInstallResult(result.stdout)
    if (!parsed) {
      console.error(`menubar install did not report a result: ${result.stderr.trim() || `exit ${String(result.code)}`}`)
      // A failed install must not orphan a working tray app that was already there.
      return this.settings.trayExePath
    }
    if (parsed.action === 'cancelled') return null
    return parsed.exePath || this.settings.trayExePath
  }

  /** Menu bar off stops the process and drops the Run value; on installs if it has to, then
   *  starts it again. The dock preference is left exactly as it was, so turning the tray back
   *  on restores the rail the person had. */
  async setMenuBarEnabled(enabled: boolean): Promise<CompanionStatus> {
    this.save({ menuBar: enabled })
    if (!this.supported()) return this.status()

    if (!enabled) {
      await this.setRunKey(false)
      const exePath = this.settings.trayExePath
      if (exePath && this.exists(exePath)) this.launch(exePath, ['--quit'])
      return this.status()
    }

    const exePath = await this.resolveTrayExe()
    if (!exePath) return this.status()
    this.save({ trayExePath: exePath })
    await this.setRunKey(true)
    this.launch(exePath, ['--reload-settings'])
    return this.status()
  }

  /** The rail is the tray app's window, so this writes the preference and asks a running tray
   *  app to notice. With the tray off there is nothing to tell, and the file is enough. */
  async setSidebarEnabled(enabled: boolean): Promise<CompanionStatus> {
    this.save({ sidebar: enabled })
    if (!this.supported()) return this.status()
    this.applyDockSetting(enabled)
    if (!this.settings.menuBar) return this.status()
    // The file is written either way; this only decides whether a running rail hears about
    // it now or at the next launch, so a tray app that cannot be found is not worth an
    // install here.
    const exePath = await this.resolveTrayExe()
    if (exePath) {
      this.save({ trayExePath: exePath })
      this.launch(exePath, ['--reload-settings'])
    }
    return this.status()
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
