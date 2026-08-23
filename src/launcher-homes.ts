import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'

export type LauncherNote = {
  name: string
  path: string
  billedVia: string
  verdict: string
}

function resolveHome(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

/** True when two Codex homes are the same physical tree. */
export function sameCodexHome(a: string, b: string): boolean {
  return resolveHome(a) === resolveHome(b)
}

/** True when `dir` is a Codex home nested under a launcher nest, and a distinct
 *  primary Codex home exists. Gate for overlap-only filtering on a *second*
 *  provider instance — it does not by itself drop sessions. */
export function isNestedLauncherCodexHome(
  dir: string,
  opts: { primaryDir: string; launcherRoots: string[] },
): boolean {
  const resolved = resolveHome(dir)
  const primary = resolveHome(opts.primaryDir)
  if (resolved === primary) return false
  const underLauncher = opts.launcherRoots.some(root => {
    const r = resolveHome(root)
    return resolved === r || resolved.startsWith(r + sep)
  })
  if (!underLauncher) return false
  return existsSync(primary)
}

/** Session id from the first `session_meta` line of a Codex rollout file.
 *  Missing / unreadable files return undefined — callers must not drop those. */
export function rolloutFileSessionId(filePath: string): string | undefined {
  try {
    const fd = openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const n = readSync(fd, buf, 0, buf.length, 0)
      const line = buf.subarray(0, n).toString('utf8').split('\n', 1)[0] ?? ''
      if (!line) return undefined
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') return undefined
      const payload = (parsed as { payload?: { session_id?: unknown } }).payload
      const id = payload?.session_id
      return typeof id === 'string' && id.length > 0 ? id : undefined
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

function walkRolloutFiles(codexDir: string, visit: (filePath: string) => void): void {
  const take = (dir: string, file: string) => {
    if (file.startsWith('rollout-') && file.endsWith('.jsonl')) visit(join(dir, file))
  }
  const sessionsDir = join(codexDir, 'sessions')
  try {
    for (const year of readdirSync(sessionsDir)) {
      if (!/^\d{4}$/.test(year)) continue
      const yearDir = join(sessionsDir, year)
      for (const month of readdirSync(yearDir)) {
        if (!/^\d{2}$/.test(month)) continue
        const monthDir = join(yearDir, month)
        for (const day of readdirSync(monthDir)) {
          if (!/^\d{2}$/.test(day)) continue
          const dayDir = join(monthDir, day)
          for (const file of readdirSync(dayDir)) take(dayDir, file)
        }
      }
    }
  } catch {
    // missing tree
  }
  const archivedDir = join(codexDir, 'archived_sessions')
  try {
    for (const file of readdirSync(archivedDir)) take(archivedDir, file)
  } catch {
    // missing archive
  }
}

/** Session ids under a Codex home (sessions/YYYY/MM/DD + archived).
 *  Identity is the rollout's `payload.session_id`, not the filename: Codex
 *  names embed a timestamp+uuid so basename collisions are rare, but a
 *  dollar-protecting dedup cannot treat 'unlikely' as identity. */
export function listRolloutSessionIds(codexDir: string): Set<string> {
  const ids = new Set<string>()
  walkRolloutFiles(codexDir, filePath => {
    const id = rolloutFileSessionId(filePath)
    if (id) ids.add(id)
  })
  return ids
}

export function defaultBilledCodexHome(): string {
  return join(homedir(), '.codex')
}

export function defaultLauncherRoots(): string[] {
  return [join(homedir(), '.buzz')]
}

/** Surfaces that drive another billed store. Not providers. No session count.
 *  Presence of `~/.buzz` is the heuristic — we do not inspect a nested Codex
 *  tree here (that store is billed via the Codex provider). */
export function collectLauncherNotes(home = homedir()): LauncherNote[] {
  const notes: LauncherNote[] = []
  const buzz = join(home, '.buzz')
  if (existsSync(buzz)) {
    notes.push({
      name: 'buzz',
      path: buzz,
      billedVia: 'codex',
      verdict: 'LAUNCHER (billed via Codex)',
    })
  }
  const grokStore = join(home, '.grok')
  const grokBot = join(home, 'Library', 'Application Support', 'Grok Bot')
  if (existsSync(grokBot) && existsSync(grokStore)) {
    notes.push({
      name: 'grok-bot',
      path: grokBot,
      billedVia: 'grok',
      verdict: 'LAUNCHER (Electron cache; billed via ~/.grok)',
    })
  }
  return notes
}
