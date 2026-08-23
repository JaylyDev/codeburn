import { existsSync, readdirSync, realpathSync } from 'fs'
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

/** Rollout basenames under a Codex home (sessions/YYYY/MM/DD + archived). */
export function listRolloutBasenames(codexDir: string): Set<string> {
  const names = new Set<string>()
  const take = (file: string) => {
    if (file.startsWith('rollout-') && file.endsWith('.jsonl')) names.add(file)
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
          for (const file of readdirSync(join(monthDir, day))) take(file)
        }
      }
    }
  } catch {
    // missing tree
  }
  try {
    for (const file of readdirSync(join(codexDir, 'archived_sessions'))) take(file)
  } catch {
    // missing archive
  }
  return names
}

export function defaultBilledCodexHome(): string {
  return join(homedir(), '.codex')
}

export function defaultLauncherRoots(): string[] {
  return [join(homedir(), '.buzz')]
}

/** Surfaces that drive another billed store. Not providers. No session count. */
export function collectLauncherNotes(home = homedir()): LauncherNote[] {
  const notes: LauncherNote[] = []
  const buzz = join(home, '.buzz')
  if (existsSync(buzz)) {
    notes.push({
      name: 'buzz',
      path: buzz,
      billedVia: 'codex',
      verdict: 'LAUNCHER (no usage store; billed via Codex)',
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
