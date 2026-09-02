import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BUNDLED_MSI_ENV,
  BUNDLED_RESULT_PREFIX,
  WINDOWS_RELEASE,
  compareMenubarVersions,
  decideBundledInstall,
  installMenubarApp,
  menubarMarkerPath,
  parseInstalledWindowsMenubar,
  parseWindowsMsiVersion,
  resolveLatestMenubarReleaseAssets,
  resolveSystem32Path,
  resolveVersionedMenubarReleaseAssets,
  type BundledInstallResult,
  type ReleaseResponse,
} from '../src/menubar-installer.js'

function asset(name: string) {
  return { name, browser_download_url: `https://example.test/${name}` }
}

const MSI_URL =
  'https://github.com/getagentseal/codeburn/releases/download/windows-v0.9.20/CodeBurn.Menubar_0.9.20_x64_en-US.msi'
const MSI_BYTES = 'msi-bytes'

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text)).digest('hex')
}

function httpResponse(status: number, body?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: body === undefined ? null : new Response(body).body,
    text: async () => body ?? '',
  }
}

/** reg query /s output, one blank-line separated block per subkey. */
function regBlock(values: Record<string, string>, key = '{9c1e2f0a-0000-0000-0000-000000000001}'): string {
  const lines = Object.entries(values).map(([name, value]) => `    ${name}    REG_SZ    ${value}`)
  return [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{other}',
    '    DisplayName    REG_SZ    Some Other App',
    '',
    `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${key}`,
    ...lines,
    '',
  ].join('\r\n')
}

const INSTALLED_0_9_20 = regBlock({
  DisplayName: 'CodeBurn Menubar',
  DisplayVersion: '0.9.20',
  InstallLocation: 'C:\\Program Files\\CodeBurn Menubar\\',
  Publisher: 'AgentSeal',
})

describe('windows release asset resolution', () => {
  it('builds direct release asset URLs from the CLI version', () => {
    const resolved = resolveVersionedMenubarReleaseAssets('0.9.20', WINDOWS_RELEASE)

    expect(resolved.release.tag_name).toBe('windows-v0.9.20')
    expect(resolved.zip.name).toBe('CodeBurn.Menubar_0.9.20_x64_en-US.msi')
    expect(resolved.zip.browser_download_url).toBe(MSI_URL)
    expect(resolved.checksum.browser_download_url).toBe(`${MSI_URL}.sha256`)
  })

  it('normalizes a leading v', () => {
    expect(resolveVersionedMenubarReleaseAssets('v0.9.20', WINDOWS_RELEASE).release.tag_name).toBe('windows-v0.9.20')
  })

  it('scans for the newest windows-v release that has both assets', () => {
    const releases: ReleaseResponse[] = [
      { tag_name: 'mac-v0.9.20', assets: [asset('CodeBurnMenubar-v0.9.20.zip'), asset('CodeBurnMenubar-v0.9.20.zip.sha256')] },
      { tag_name: 'windows-v0.9.21', assets: [asset('CodeBurn.Menubar_0.9.21_x64_en-US.msi')] },
      {
        tag_name: 'windows-v0.9.20',
        assets: [asset('CodeBurn.Menubar_0.9.20_x64_en-US.msi'), asset('CodeBurn.Menubar_0.9.20_x64_en-US.msi.sha256')],
      },
    ]

    const resolved = resolveLatestMenubarReleaseAssets(releases, WINDOWS_RELEASE)

    expect(resolved.release.tag_name).toBe('windows-v0.9.20')
    expect(resolved.zip.name).toBe('CodeBurn.Menubar_0.9.20_x64_en-US.msi')
  })

  it('reports when no windows release carries both assets', () => {
    expect(() => resolveLatestMenubarReleaseAssets([{ tag_name: 'v0.9.20', assets: [] }], WINDOWS_RELEASE))
      .toThrow(/No windows-v\* release/)
  })
})

describe('resolveSystem32Path', () => {
  it('uses an absolute SystemRoot', () => {
    expect(resolveSystem32Path('msiexec.exe', { SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\msiexec.exe')
  })

  it('falls back to the documented default when SystemRoot is missing or relative', () => {
    expect(resolveSystem32Path('reg.exe', {})).toBe('C:\\Windows\\System32\\reg.exe')
    expect(resolveSystem32Path('reg.exe', { SystemRoot: 'Windows' })).toBe('C:\\Windows\\System32\\reg.exe')
  })
})

describe('parseInstalledWindowsMenubar', () => {
  it('reads the version and joins the exe onto InstallLocation', () => {
    expect(parseInstalledWindowsMenubar(INSTALLED_0_9_20)).toEqual({
      version: '0.9.20',
      exePath: 'C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe',
    })
  })

  it('falls back to DisplayIcon when there is no InstallLocation', () => {
    const output = regBlock({
      DisplayName: 'CodeBurn Menubar',
      DisplayVersion: '0.9.20',
      DisplayIcon: 'C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe,0',
    })

    expect(parseInstalledWindowsMenubar(output)?.exePath).toBe('C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe')
  })

  it('returns undefined when the product is not installed', () => {
    expect(parseInstalledWindowsMenubar(regBlock({ DisplayName: 'Something Else', DisplayVersion: '1.0' }))).toBeUndefined()
  })
})

describe('installMenubarApp on windows', () => {
  let sandbox: string
  let logs: string[]
  let launched: string[]
  let installerCalls: Array<{ exe: string; args: string[] }>

  function hooks(overrides: Record<string, unknown> = {}) {
    return {
      stagingDir: sandbox,
      env: { SystemRoot: 'C:\\Windows' },
      log: (message: string) => { logs.push(message) },
      launch: (exePath: string) => { launched.push(exePath) },
      queryRegistry: async () => INSTALLED_0_9_20,
      runInstaller: async (exe: string, args: string[]) => { installerCalls.push({ exe, args }); return 0 },
      fetchOptions: {
        sleep: async () => {},
        log: (message: string) => { logs.push(message) },
        fetchImpl: async (url: string) => httpResponse(200, url.endsWith('.sha256')
          ? `${sha256(MSI_BYTES)}  CodeBurn.Menubar_0.9.20_x64_en-US.msi`
          : MSI_BYTES),
      },
      ...overrides,
    }
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'menubar-windows-'))
    logs = []
    launched = []
    installerCalls = []
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('skips the download and just launches when the pinned version is already installed', async () => {
    let fetches = 0
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({ fetchOptions: { fetchImpl: async () => { fetches++; return httpResponse(500) } } }),
    })

    expect(fetches).toBe(0)
    expect(installerCalls).toEqual([])
    expect(launched).toEqual(['C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe'])
    expect(result).toEqual({ installedPath: 'C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe', launched: true })
  })

  it('downloads, verifies, runs msiexec from System32 and launches the installed app', async () => {
    let queries = 0
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_20),
      }),
    })

    expect(installerCalls).toEqual([{
      exe: 'C:\\Windows\\System32\\msiexec.exe',
      args: ['/i', join(sandbox, 'CodeBurn.Menubar_0.9.20_x64_en-US.msi'), '/passive', '/norestart'],
    }])
    expect(launched).toEqual(['C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe'])
    expect(result.launched).toBe(true)
    expect(logs).toContain('Downloading CodeBurn.Menubar_0.9.20_x64_en-US.msi...')
    expect(logs).toContain('Verifying checksum...')
    expect(logs).toContain('Installing...')
    expect(logs).toContain('Launched CodeBurn Menubar.')
  })

  it('reinstalls the same version when --force is passed', async () => {
    await installMenubarApp({ platform: 'win32', cliVersion: '0.9.20', force: true, windows: hooks() })

    expect(installerCalls).toHaveLength(1)
  })

  it('aborts on a checksum mismatch without running the installer', async () => {
    await expect(installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryRegistry: async () => '',
        fetchOptions: {
          sleep: async () => {},
          log: () => {},
          fetchImpl: async (url: string) =>
            httpResponse(200, url.endsWith('.sha256') ? `${sha256('other-bytes')}  x.msi` : MSI_BYTES),
        },
      }),
    })).rejects.toThrow(/Checksum mismatch/)

    expect(installerCalls).toEqual([])
    expect(launched).toEqual([])
  })

  it('treats 3010 as installed and says a restart is pending', async () => {
    let queries = 0
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_20),
        runInstaller: async (exe: string, args: string[]) => { installerCalls.push({ exe, args }); return 3010 },
      }),
    })

    expect(result.launched).toBe(true)
    expect(logs.some(line => line.includes('restart'))).toBe(true)
  })

  it('treats 1602 as a cancelled install: no launch, no error', async () => {
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryRegistry: async () => '',
        runInstaller: async () => 1602,
      }),
    })

    expect(result).toEqual({ installedPath: '', launched: false })
    expect(launched).toEqual([])
    expect(logs.some(line => line.includes('cancelled'))).toBe(true)
  })

  it('fails with the exit code for any other msiexec failure', async () => {
    await expect(installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({ queryRegistry: async () => '', runInstaller: async () => 1603 }),
    })).rejects.toThrow(/msiexec exited with 1603/)

    expect(launched).toEqual([])
  })

  it('falls back to the release API when the pinned assets are missing', async () => {
    let queries = 0
    const requested: string[] = []
    const latest: ReleaseResponse[] = [{
      tag_name: 'windows-v0.9.19',
      assets: [
        { name: 'CodeBurn.Menubar_0.9.19_x64_en-US.msi', browser_download_url: 'https://example.test/msi' },
        { name: 'CodeBurn.Menubar_0.9.19_x64_en-US.msi.sha256', browser_download_url: 'https://example.test/msi.sha256' },
      ],
    }]

    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_20),
        apiFetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => latest }),
        fetchOptions: {
          sleep: async () => {},
          log: () => {},
          fetchImpl: async (url: string) => {
            requested.push(url)
            if (url.startsWith(MSI_URL)) return httpResponse(404)
            return httpResponse(200, url.endsWith('.sha256') ? `${sha256(MSI_BYTES)}  msi` : MSI_BYTES)
          },
        },
      }),
    })

    expect(requested[0]).toBe(MSI_URL)
    expect(requested).toContain('https://example.test/msi')
    expect(installerCalls[0]?.args[1]).toBe(join(sandbox, 'CodeBurn.Menubar_0.9.19_x64_en-US.msi'))
    expect(result.launched).toBe(true)
  })
})

describe('compareMenubarVersions', () => {
  it('compares field by field, numerically', () => {
    expect(compareMenubarVersions('0.9.9', '0.9.10')).toBe(-1)
    expect(compareMenubarVersions('0.10.0', '0.9.30')).toBe(1)
    expect(compareMenubarVersions('v0.9.23', '0.9.23')).toBe(0)
  })

  it('treats a missing or unreadable field as the oldest thing there is', () => {
    expect(compareMenubarVersions('', '0.0.1')).toBe(-1)
    expect(compareMenubarVersions('0.9', '0.9.0')).toBe(0)
  })
})

describe('parseWindowsMsiVersion', () => {
  it('reads the version out of the release asset name', () => {
    expect(parseWindowsMsiVersion('CodeBurn.Menubar_0.9.23_x64_en-US.msi')).toBe('0.9.23')
    expect(parseWindowsMsiVersion('CodeBurn-Setup-0.9.23.exe')).toBeUndefined()
  })
})

describe('decideBundledInstall', () => {
  it('installs onto a machine that has no menubar', () => {
    expect(decideBundledInstall(undefined, '0.9.23')).toBe('installed')
  })

  it('upgrades an older install and leaves an equal one alone', () => {
    expect(decideBundledInstall('0.9.20', '0.9.23')).toBe('installed')
    expect(decideBundledInstall('0.9.23', '0.9.23')).toBe('up-to-date')
  })

  it('never downgrades', () => {
    expect(decideBundledInstall('0.9.30', '0.9.23')).toBe('kept-newer')
  })

  it('reinstalls the same version under force', () => {
    expect(decideBundledInstall('0.9.23', '0.9.23', true)).toBe('installed')
  })
})

describe('installMenubarApp from a staged msi', () => {
  const BUNDLED_VERSION = '0.9.23'
  const MSI_NAME = `CodeBurn.Menubar_${BUNDLED_VERSION}_x64_en-US.msi`
  const INSTALLED_0_9_23 = regBlock({
    DisplayName: 'CodeBurn Menubar',
    DisplayVersion: '0.9.23',
    InstallLocation: 'C:\\Program Files\\CodeBurn Menubar\\',
    UninstallString: 'MsiExec.exe /X{9c1e2f0a-0000-0000-0000-000000000001}',
  })
  const INSTALLED_0_9_30 = regBlock({
    DisplayName: 'CodeBurn Menubar',
    DisplayVersion: '0.9.30',
    InstallLocation: 'C:\\Program Files\\CodeBurn Menubar\\',
  })

  let sandbox: string
  let msiPath: string
  let logs: string[]
  let installerCalls: Array<{ exe: string; args: string[] }>

  function env(): NodeJS.ProcessEnv {
    return { SystemRoot: 'C:\\Windows', LOCALAPPDATA: join(sandbox, 'Local'), [BUNDLED_MSI_ENV]: msiPath }
  }

  function hooks(overrides: Record<string, unknown> = {}) {
    return {
      env: env(),
      log: (message: string) => { logs.push(message) },
      queryRegistry: async () => '',
      runInstaller: async (exe: string, args: string[]) => { installerCalls.push({ exe, args }); return 0 },
      fetchOptions: { fetchImpl: async () => { throw new Error('a staged install must not reach the network') } },
      ...overrides,
    }
  }

  function reported(): BundledInstallResult {
    const line = logs.find(entry => entry.startsWith(BUNDLED_RESULT_PREFIX))
    if (!line) throw new Error(`no result line in:\n${logs.join('\n')}`)
    return JSON.parse(line.slice(BUNDLED_RESULT_PREFIX.length)) as BundledInstallResult
  }

  async function marker(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(menubarMarkerPath(env()), 'utf8')) as Record<string, unknown>
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'menubar-staged-'))
    msiPath = join(sandbox, MSI_NAME)
    logs = []
    installerCalls = []
    await writeFile(msiPath, MSI_BYTES)
    await writeFile(`${msiPath}.sha256`, `${sha256(MSI_BYTES)}  ${MSI_NAME}\n`)
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('verifies the staged file, installs it and credits the desktop app', async () => {
    let queries = 0
    const result = await installMenubarApp({
      platform: 'win32',
      windows: hooks({ queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_23) }),
    })

    expect(installerCalls).toEqual([{
      exe: 'C:\\Windows\\System32\\msiexec.exe',
      args: ['/i', msiPath, '/passive', '/norestart'],
    }])
    expect(result.installedPath).toBe('C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe')
    // The caller that staged the MSI owns the tray app's process, so nothing is launched here.
    expect(result.launched).toBe(false)
    expect(reported()).toMatchObject({
      action: 'installed',
      bundledVersion: BUNDLED_VERSION,
      previousVersion: null,
      installedBy: 'desktop',
      uninstallString: 'MsiExec.exe /X{9c1e2f0a-0000-0000-0000-000000000001}',
    })
    expect(await marker()).toMatchObject({ installedBy: 'desktop', version: '0.9.23' })
  })

  it('upgrades a manual install in place without claiming it', async () => {
    let queries = 0
    await installMenubarApp({
      platform: 'win32',
      windows: hooks({ queryRegistry: async () => (queries++ === 0 ? INSTALLED_0_9_20 : INSTALLED_0_9_23) }),
    })

    expect(installerCalls).toHaveLength(1)
    expect(reported()).toMatchObject({ action: 'installed', previousVersion: '0.9.20', installedBy: 'manual' })
    expect(await marker()).toMatchObject({ installedBy: 'manual' })
  })

  it('keeps a newer install and runs no installer', async () => {
    await installMenubarApp({
      platform: 'win32',
      windows: hooks({ queryRegistry: async () => INSTALLED_0_9_30 }),
    })

    expect(installerCalls).toEqual([])
    expect(reported()).toMatchObject({ action: 'kept-newer', previousVersion: '0.9.30', installedBy: 'manual' })
    expect(logs.some(line => line.includes('newer than the bundled'))).toBe(true)
  })

  it('does nothing when the bundled version is already installed', async () => {
    await installMenubarApp({
      platform: 'win32',
      windows: hooks({ queryRegistry: async () => INSTALLED_0_9_23 }),
    })

    expect(installerCalls).toEqual([])
    expect(reported()).toMatchObject({ action: 'up-to-date' })
  })

  it('never rewrites a marker that already credits the desktop app', async () => {
    let queries = 0
    await installMenubarApp({
      platform: 'win32',
      windows: hooks({ queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_23) }),
    })
    logs = []
    await installMenubarApp({
      platform: 'win32',
      windows: hooks({ queryRegistry: async () => INSTALLED_0_9_23 }),
    })

    expect(reported()).toMatchObject({ action: 'up-to-date', installedBy: 'desktop' })
  })

  it('refuses a staged file whose digest does not match', async () => {
    await writeFile(`${msiPath}.sha256`, `${sha256('other-bytes')}  ${MSI_NAME}\n`)

    await expect(installMenubarApp({ platform: 'win32', windows: hooks() })).rejects.toThrow(/Checksum mismatch/)
    expect(installerCalls).toEqual([])
  })

  it('refuses a staged file with no digest beside it', async () => {
    await rm(`${msiPath}.sha256`)

    await expect(installMenubarApp({ platform: 'win32', windows: hooks() })).rejects.toThrow(/Missing checksum file/)
    expect(installerCalls).toEqual([])
  })

  it('reports a cancelled install rather than failing', async () => {
    const result = await installMenubarApp({
      platform: 'win32',
      windows: hooks({ runInstaller: async () => 1602 }),
    })

    expect(result).toEqual({ installedPath: '', launched: false })
    expect(reported()).toMatchObject({ action: 'cancelled', installedBy: null })
  })
})
