import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BUNDLED_MSI_ENV,
  BUNDLED_RESULT_PREFIX,
  MenubarCompanion,
  dockPrefsPath,
  findPackagedTrayExe,
  findStagedMsi,
  parseInstallResult,
  parseRunKeyValue,
  readCompanionSettings,
  readDockEnabled,
  runKeyArgs,
  system32Path,
  writeCompanionSettings,
  writeDockEnabled,
  type MenubarInstallResult,
} from './menubar'

const VERSION = '0.9.23'
const MSI_NAME = `CodeBurn.Menubar_${VERSION}_x64_en-US.msi`
const TRAY_EXE = 'C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe'

function result(overrides: Partial<MenubarInstallResult> = {}): MenubarInstallResult {
  return {
    action: 'installed',
    bundledVersion: VERSION,
    previousVersion: null,
    exePath: TRAY_EXE,
    uninstallString: 'MsiExec.exe /X{guid}',
    installedBy: 'desktop',
    ...overrides,
  }
}

describe('staged tray app discovery', () => {
  let sandbox: string

  beforeEach(() => { sandbox = mkdtempSync(join(tmpdir(), 'companion-')) })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('reads the version out of the staged asset name', () => {
    writeFileSync(join(sandbox, MSI_NAME), 'msi')
    expect(findStagedMsi(sandbox)).toEqual({ path: join(sandbox, MSI_NAME), version: VERSION })
  })

  it('ignores anything that is not the release asset, and a directory that is not there', () => {
    writeFileSync(join(sandbox, 'CodeBurn-Setup-0.9.23.exe'), 'nope')
    expect(findStagedMsi(sandbox)).toBeNull()
    expect(findStagedMsi(join(sandbox, 'missing'))).toBeNull()
  })

  it('finds the packaged tray executable only when it is there', () => {
    expect(findPackagedTrayExe(sandbox)).toBeNull()
    writeFileSync(join(sandbox, 'codeburn-menubar.exe'), 'exe')
    expect(findPackagedTrayExe(sandbox)).toBe(join(sandbox, 'codeburn-menubar.exe'))
  })
})

describe('parseInstallResult', () => {
  it('picks the one machine-readable line out of the installer prose', () => {
    const stdout = [
      'Verifying checksum...',
      'Installing...',
      `${BUNDLED_RESULT_PREFIX}${JSON.stringify(result())}`,
      'Installed CodeBurn Menubar 0.9.23.',
    ].join('\r\n')

    expect(parseInstallResult(stdout)).toEqual(result())
  })

  it('is null when the installer said nothing machine-readable, or said it badly', () => {
    expect(parseInstallResult('Installing...\n')).toBeNull()
    expect(parseInstallResult(`${BUNDLED_RESULT_PREFIX}{not json`)).toBeNull()
  })
})

describe('runKeyArgs', () => {
  it('writes and removes the same value the tray app\u2019s own toggle owns', () => {
    expect(runKeyArgs(true, TRAY_EXE)).toEqual([
      'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', 'CodeBurn', '/t', 'REG_SZ', '/d', `"${TRAY_EXE}"`, '/f',
    ])
    expect(runKeyArgs(false, TRAY_EXE)).toEqual([
      'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'CodeBurn', '/f',
    ])
  })
})

describe('parseRunKeyValue', () => {
  it('reads the value out of a reg query, and null when there is none', () => {
    const output = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      `    CodeBurn    REG_SZ    "${TRAY_EXE}"`,
      '',
    ].join('\r\n')

    expect(parseRunKeyValue(output)).toBe(`"${TRAY_EXE}"`)
    expect(parseRunKeyValue('ERROR: The system was unable to find the specified registry key')).toBeNull()
    // A different value under the same key is not this one.
    expect(parseRunKeyValue('    OneDrive    REG_SZ    "C:\\OneDrive.exe"')).toBeNull()
  })
})

describe('system32Path', () => {
  it('never resolves a system tool by bare name', () => {
    expect(system32Path('reg.exe', { SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\reg.exe')
    expect(system32Path('reg.exe', {})).toBe('C:\\Windows\\System32\\reg.exe')
  })
})

describe('the dock preference file', () => {
  let home: string

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'companion-home-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('creates the file the tray app reads before its page exists', () => {
    writeDockEnabled(true, home)
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: true })
  })

  it('reports whether the tray app has already said something about the rail', () => {
    expect(readDockEnabled(home)).toBeUndefined()

    mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
    writeFileSync(dockPrefsPath(home), JSON.stringify({ scale: 1.2 }))
    expect(readDockEnabled(home)).toBeUndefined()

    writeFileSync(dockPrefsPath(home), JSON.stringify({ enabled: false, scale: 1.2 }))
    expect(readDockEnabled(home)).toBe(false)

    writeFileSync(dockPrefsPath(home), '{ broken')
    expect(readDockEnabled(home)).toBeUndefined()
  })

  it('keeps every key the tray app owns', () => {
    mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
    writeFileSync(dockPrefsPath(home), JSON.stringify({ enabled: true, scale: 1.2, preferred: 'claude' }))

    writeDockEnabled(false, home)

    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8')))
      .toEqual({ enabled: false, scale: 1.2, preferred: 'claude' })
  })
})

describe('companion settings', () => {
  let stateDir: string

  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'companion-state-')) })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('defaults both switches on before anything has been written', () => {
    expect(readCompanionSettings(stateDir)).toEqual({ menuBar: true, sidebar: true, trayExePath: null, seeded: false })
  })

  it('round-trips, and falls back to the defaults on an unreadable file', () => {
    writeCompanionSettings(stateDir, { menuBar: false, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    expect(readCompanionSettings(stateDir)).toEqual({ menuBar: false, sidebar: true, trayExePath: TRAY_EXE, seeded: true })

    writeFileSync(join(stateDir, 'companion.v1.json'), '{ broken')
    expect(readCompanionSettings(stateDir).menuBar).toBe(true)
  })

  // Falling back to the defaults means seeding again, which reinstalls the tray app and
  // re-enables the rail. A byte order mark, which anything editing this file by hand on
  // Windows tends to leave, is not a good enough reason for that.
  it('reads a file that was saved with a byte order mark', () => {
    const settings = { menuBar: false, sidebar: false, trayExePath: TRAY_EXE, seeded: true }
    writeFileSync(join(stateDir, 'companion.v1.json'), `﻿${JSON.stringify(settings)}`)

    expect(readCompanionSettings(stateDir)).toEqual(settings)
  })
})

describe('MenubarCompanion', () => {
  let sandbox: string
  let resources: string
  let stateDir: string
  let home: string
  let launches: Array<{ exe: string; args: string[] }>
  let regCalls: string[][]
  let cliCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }>
  let installResult: MenubarInstallResult | null
  let existingRunKey: string | null
  /** What is on disk, as far as the companion is concerned. TRAY_EXE is there by default. */
  let present: Set<string>

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      resourcesPath: resources,
      stateDir,
      store: false,
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      home,
      launch: (exe: string, args: string[]) => { launches.push({ exe, args }) },
      runReg: async (args: string[]) => { regCalls.push(args) },
      readRunKey: async () => existingRunKey,
      exists: (path: string) => present.has(path),
      runCli: async (args: string[], opts: { extraEnv?: NodeJS.ProcessEnv }) => {
        cliCalls.push({ args, env: opts.extraEnv })
        return {
          ok: true,
          stdout: installResult ? `Installing...\n${BUNDLED_RESULT_PREFIX}${JSON.stringify(installResult)}\n` : 'Installing...\n',
          stderr: '',
          code: 0,
        }
      },
      ...overrides,
    }
  }

  function stageMsi(): void {
    mkdirSync(join(resources, 'menubar'), { recursive: true })
    writeFileSync(join(resources, 'menubar', MSI_NAME), 'msi')
  }

  function stageExe(): string {
    mkdirSync(join(resources, 'menubar'), { recursive: true })
    const exe = join(resources, 'menubar', 'codeburn-menubar.exe')
    writeFileSync(exe, 'exe')
    present.add(exe)
    return exe
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'companion-app-'))
    resources = join(sandbox, 'resources')
    stateDir = join(sandbox, 'state')
    home = join(sandbox, 'home')
    mkdirSync(resources, { recursive: true })
    launches = []
    regCalls = []
    cliCalls = []
    installResult = result()
    existingRunKey = null
    present = new Set([TRAY_EXE])
  })

  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('is unsupported off Windows and on a build with nothing staged', () => {
    expect(new MenubarCompanion(deps()).status().supported).toBe(false)
    stageMsi()
    expect(new MenubarCompanion(deps({ platform: 'darwin' })).status().supported).toBe(false)
    expect(new MenubarCompanion(deps()).status().supported).toBe(true)
    // The Store route wants the executable itself; an .msi it cannot run is not support.
    expect(new MenubarCompanion(deps({ store: true })).status().supported).toBe(false)
  })

  it('installs through the CLI, naming the staged file in the environment', async () => {
    stageMsi()
    await new MenubarCompanion(deps()).bootstrap()

    expect(cliCalls).toEqual([{
      args: ['menubar'],
      env: { [BUNDLED_MSI_ENV]: join(resources, 'menubar', MSI_NAME) },
    }])
    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
    expect(readCompanionSettings(stateDir)).toMatchObject({ trayExePath: TRAY_EXE, seeded: true })
  })

  it('seeds the Capacity Dock on first run only', async () => {
    stageMsi()
    await new MenubarCompanion(deps()).bootstrap()
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: true })

    // A person turning the rail off in the tray app's own settings must not find it back on.
    writeDockEnabled(false, home)
    await new MenubarCompanion(deps()).bootstrap()
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: false })
  })

  it('leaves a rail preference that was already there, and mirrors it into the switch', async () => {
    stageMsi()
    // A tray app installed by hand, with the rail deliberately off.
    mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
    writeFileSync(dockPrefsPath(home), JSON.stringify({ enabled: false, scale: 1.2 }))
    const companion = new MenubarCompanion(deps())

    await companion.bootstrap()

    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: false, scale: 1.2 })
    expect(companion.status().sidebar).toBe(false)
    expect(readCompanionSettings(stateDir).sidebar).toBe(false)
  })

  it('still seeds when the file exists but has never mentioned the rail', async () => {
    stageMsi()
    mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
    writeFileSync(dockPrefsPath(home), JSON.stringify({ scale: 1.2 }))

    await new MenubarCompanion(deps()).bootstrap()

    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: true, scale: 1.2 })
  })

  it('leaves an existing launch-at-login value alone', async () => {
    stageMsi()
    existingRunKey = `"${TRAY_EXE}"`

    await new MenubarCompanion(deps()).bootstrap()

    expect(regCalls).toEqual([])
    // Everything else still happens: the install is what carries a version forward.
    expect(cliCalls).toHaveLength(1)
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
  })

  it('writes the launch-at-login value on the first run only', async () => {
    stageMsi()
    await new MenubarCompanion(deps()).bootstrap()
    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])

    // A person turning launch at login off in the tray app's settings must not find it back on.
    regCalls = []
    await new MenubarCompanion(deps()).bootstrap()
    expect(regCalls).toEqual([])
  })

  it('does nothing at all with the Menu bar switch off', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: false, sidebar: true, trayExePath: null, seeded: true })

    await new MenubarCompanion(deps()).bootstrap()

    expect(cliCalls).toEqual([])
    expect(launches).toEqual([])
    expect(regCalls).toEqual([])
  })

  it('launches the packaged executable and writes no Run value on the Store route', async () => {
    const exe = stageExe()
    await new MenubarCompanion(deps({ store: true })).bootstrap()

    expect(cliCalls).toEqual([])
    // Launch at login is the package manifest's own startup task there.
    expect(regCalls).toEqual([])
    expect(launches).toEqual([{ exe, args: ['--reload-settings'] }])
  })

  it('keeps the switch where it was when the install was cancelled', async () => {
    stageMsi()
    installResult = result({ action: 'cancelled', exePath: '', installedBy: null })

    await new MenubarCompanion(deps()).bootstrap()

    expect(launches).toEqual([])
    expect(regCalls).toEqual([])
    expect(readCompanionSettings(stateDir).trayExePath).toBeNull()
  })

  it('keeps a working tray app when the installer reports nothing at all', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    installResult = null
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await new MenubarCompanion(deps()).bootstrap()

    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
    error.mockRestore()
  })

  // A stored path can be wrong: written by a build that derived the binary name from the
  // product name, or left behind by a tray app that has since been uninstalled.
  const STALE_EXE = 'C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe'

  it('re-resolves a stored path that is not on disk rather than launching it', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: false, sidebar: true, trayExePath: STALE_EXE, seeded: true })

    await new MenubarCompanion(deps()).setMenuBarEnabled(true)

    // The install re-reads the registry and installs nothing when the version matches.
    expect(cliCalls).toHaveLength(1)
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
    expect(readCompanionSettings(stateDir).trayExePath).toBe(TRAY_EXE)
  })

  it('does not send --quit into the void when the stored path is stale', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: true, sidebar: true, trayExePath: STALE_EXE, seeded: true })

    await new MenubarCompanion(deps()).setMenuBarEnabled(false)

    expect(launches).toEqual([])
    expect(regCalls).toEqual([runKeyArgs(false, STALE_EXE)])
  })

  it('gives up rather than storing a path the installer reported but nothing is at', async () => {
    stageMsi()
    installResult = result({ exePath: STALE_EXE })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await new MenubarCompanion(deps()).bootstrap()

    expect(launches).toEqual([])
    expect(regCalls).toEqual([])
    expect(readCompanionSettings(stateDir).trayExePath).toBeNull()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('repairs a Run value that points at a file which is not there', async () => {
    stageMsi()
    // Not a first run, so the seed rule would normally leave an existing value alone.
    writeCompanionSettings(stateDir, { menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    existingRunKey = `"${STALE_EXE}"`

    await new MenubarCompanion(deps()).bootstrap()

    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])
  })

  it('still leaves a Run value alone when it points at something real', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    const other = 'C:\\Somewhere\\else.exe'
    present.add(other)
    existingRunKey = `"${other}"`

    await new MenubarCompanion(deps()).bootstrap()

    expect(regCalls).toEqual([])
  })

  it('Menu bar off quits the tray app and drops the Run value', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    const companion = new MenubarCompanion(deps())

    const status = await companion.setMenuBarEnabled(false)

    expect(status).toEqual({ supported: true, menuBar: false, sidebar: false, store: false })
    expect(regCalls).toEqual([runKeyArgs(false, TRAY_EXE)])
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--quit'] }])
  })

  it('Menu bar on installs if it has to, then starts the tray app again', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: false, sidebar: true, trayExePath: null, seeded: true })

    const status = await new MenubarCompanion(deps()).setMenuBarEnabled(true)

    expect(status.menuBar).toBe(true)
    expect(cliCalls).toHaveLength(1)
    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
  })

  // The rail is a window of the tray app, so the two switches cannot disagree.
  it('Menu bar off turns Sidebar off with it, writing the preference before the quit', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    writeDockEnabled(true, home)
    const companion = new MenubarCompanion(deps())

    const status = await companion.setMenuBarEnabled(false)

    expect(status).toEqual({ supported: true, menuBar: false, sidebar: false, store: false })
    // Written before --quit, so what the tray app finds next time is what the switches show.
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: false })
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--quit'] }])
    expect(readCompanionSettings(stateDir).sidebar).toBe(false)
  })

  it('Sidebar on with Menu bar off turns the tray app on first', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: false, sidebar: false, trayExePath: null, seeded: true })

    const status = await new MenubarCompanion(deps()).setSidebarEnabled(true)

    expect(status).toMatchObject({ menuBar: true, sidebar: true })
    expect(cliCalls).toHaveLength(1)
    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: true })
    // Started for the Menu bar switch, then nudged again for the rail.
    expect(launches).toEqual([
      { exe: TRAY_EXE, args: ['--reload-settings'] },
      { exe: TRAY_EXE, args: ['--reload-settings'] },
    ])
  })

  it('leaves both switches off when the tray app cannot be turned on', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: false, sidebar: false, trayExePath: null, seeded: true })
    installResult = result({ action: 'cancelled', exePath: '', installedBy: null })

    const status = await new MenubarCompanion(deps()).setSidebarEnabled(true)

    expect(status).toMatchObject({ menuBar: false, sidebar: false })
    expect(launches).toEqual([])
    expect(() => readFileSync(dockPrefsPath(home), 'utf8')).toThrow()
  })

  it('Sidebar off writes the preference and asks a running tray app to notice', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })

    const status = await new MenubarCompanion(deps()).setSidebarEnabled(false)

    expect(status.sidebar).toBe(false)
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: false })
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
  })

  it('Sidebar off with the tray app off writes the preference and tells nobody', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { menuBar: false, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    writeDockEnabled(true, home)

    await new MenubarCompanion(deps()).setSidebarEnabled(false)

    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: false })
    // Nothing is running to be told, and turning the rail off never starts the tray app.
    expect(launches).toEqual([])
    expect(cliCalls).toEqual([])
  })
})
