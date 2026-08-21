import { execFileSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'

/// WSL discovery (#1059). Claude Code / Codex run *inside* a WSL distro write
/// their history to the distro's Linux home, which lives on a 9P share Windows
/// exposes as `\\wsl$\<distro>\...` — never under the Windows user profile. A
/// Windows-only scan therefore reports zero sessions for those users.
///
/// `CODEBURN_WSL` is deliberately NOT in PROVIDER_ENV_VARS (src/session-cache.ts):
/// WSL homes are purely *additive* discovery roots and the cache is keyed by
/// source path, so flipping this var can only add or drop paths — never make a
/// cached entry stale. Declaring it would instead force a full re-parse on every
/// toggle. Same reasoning as CODEBURN_CACHE_SCOPE.

export type WslMode = 'off' | 'all' | 'running'

export function wslMode(env: NodeJS.ProcessEnv = process.env): WslMode {
  const value = (env['CODEBURN_WSL'] ?? '').trim().toLowerCase()
  return value === 'off' || value === 'all' ? value : 'running'
}

/// Windows' CreateProcess searches the current directory before PATH, so
/// spawning `wsl.exe` by bare name lets anything dropped next to the CLI
/// impersonate it. Same rule as src/menubar-installer.ts: resolveSystem32Path.
function wslExePath(env: NodeJS.ProcessEnv): string {
  const root = env['SystemRoot']
  const base = root && /^[a-zA-Z]:[\\/]/.test(root) ? root.replace(/[\\/]+$/, '') : 'C:\\Windows'
  return `${base}\\System32\\wsl.exe`
}

// Distros that exist to back a container runtime; they hold no user history.
const UTILITY_DISTROS = /^(docker-desktop|podman-machine|rancher-desktop)/

/// `wsl.exe --list --quiet` writes UTF-16LE (no BOM on some builds) with CRLF
/// line ends; piping it through a UTF-8 decode yields NUL-separated garbage.
/// Detect the encoding from the interleaved NULs rather than trusting either.
export function parseWslDistros(raw: Buffer): string[] {
  const text = raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8')
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.replace(/\0/g, '').trim())
    .filter(name => name.length > 0 && !UTILITY_DISTROS.test(name))
}

const UNC_PREFIXES = ['\\\\wsl.localhost\\', '\\\\wsl$\\']

export function isWslUncPath(path: string): boolean {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(path)
}

function homesUnder(base: string): string[] {
  const homes: string[] = []
  try {
    for (const entry of readdirSync(`${base}\\home`, { withFileTypes: true })) {
      if (entry.isDirectory()) homes.push(`${base}\\home\\${entry.name}`)
    }
  } catch {}
  try {
    if (existsSync(`${base}\\root`)) homes.push(`${base}\\root`)
  } catch {}
  return homes
}

function discoverWslHomes(): string[] {
  if (process.platform !== 'win32') return []
  const mode = wslMode()
  if (mode === 'off') return []

  // Default is running-only: touching `\\wsl$\<distro>` for a *stopped* distro
  // boots it, which is both intrusive and slow. `CODEBURN_WSL=all` opts in.
  const args = mode === 'all' ? ['--list', '--quiet'] : ['--list', '--quiet', '--running']
  let raw: Buffer
  try {
    raw = execFileSync(wslExePath(process.env), args, {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return []
  }

  const homes: string[] = []
  for (const distro of parseWslDistros(raw)) {
    for (const prefix of UNC_PREFIXES) {
      const found = homesUnder(prefix + distro)
      if (found.length > 0) {
        homes.push(...found)
        break
      }
    }
  }
  return homes
}

let cached: string[] | undefined

/// Every WSL home directory to treat as an extra provider root, memoized for
/// the process (spawning wsl.exe and walking a 9P share is not free).
export function wslHomes(): string[] {
  if (cached === undefined) cached = discoverWslHomes()
  return cached
}

/// Test seam: discovery shells out to wsl.exe and stats a 9P share, neither of
/// which exists on CI. Pass `undefined` to restore real discovery.
export function setWslHomes(homes: string[] | undefined): void {
  cached = homes
}
