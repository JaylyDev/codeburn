import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { collectLauncherNotes, isNestedLauncherCodexHome } from '../src/launcher-homes.js'
import { collectDoctorReport, renderDoctorTable } from '../src/doctor.js'
import { createCodexProvider } from '../src/providers/codex.js'
import { emptyCache } from '../src/session-cache.js'

function sessionMeta(): string {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-04-14T10:00:00Z',
    payload: { cwd: '/Users/test/proj', originator: 'codex-cli', session_id: 'sess-001', model: 'gpt-5.3-codex' },
  })
}

async function writeCodexSession(codexDir: string, name = 'rollout-sess-001.jsonl'): Promise<void> {
  const dayDir = join(codexDir, 'sessions', '2026', '04', '14')
  await mkdir(dayDir, { recursive: true })
  await writeFile(join(dayDir, name), `${sessionMeta()}\n`)
}

function names(sources: { path: string }[]): string[] {
  return sources.map(s => s.path.split('/').pop()!)
}

describe('isNestedLauncherCodexHome', () => {
  it('skips a Codex home under .buzz when a distinct primary home exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'launch-'))
    const primary = join(root, 'real-codex')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await mkdir(primary, { recursive: true })
    await mkdir(nested, { recursive: true })
    expect(isNestedLauncherCodexHome(nested, { primaryDir: primary, launcherRoots: [buzz] })).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('does not skip the sole Codex home even if it sits under .buzz', async () => {
    const root = await mkdtemp(join(tmpdir(), 'launch-'))
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await mkdir(nested, { recursive: true })
    expect(isNestedLauncherCodexHome(nested, { primaryDir: nested, launcherRoots: [buzz] })).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  it('treats a realpath-equivalent nest as the same home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'launch-'))
    const primary = join(root, 'real-codex')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await mkdir(primary, { recursive: true })
    await mkdir(buzz, { recursive: true })
    await symlink(primary, nested)
    expect(isNestedLauncherCodexHome(nested, { primaryDir: primary, launcherRoots: [buzz] })).toBe(false)
    await rm(root, { recursive: true, force: true })
  })
})

describe('Codex discover overlap-only nest filter', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'codex-buzz-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('keeps a distinct nest rollout on the second factory', async () => {
    const primary = join(root, 'primary')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await writeCodexSession(primary, 'rollout-primary.jsonl')
    await writeCodexSession(nested, 'rollout-buzz.jsonl')
    const real = createCodexProvider(primary, { primaryDir: primary, launcherRoots: [buzz] })
    const nest = createCodexProvider(nested, { primaryDir: primary, launcherRoots: [buzz] })
    expect(names(await real.discoverSessions())).toEqual(['rollout-primary.jsonl'])
    expect(names(await nest.discoverSessions())).toEqual(['rollout-buzz.jsonl'])
  })

  it('filters only a nest rollout whose basename overlaps the primary tree', async () => {
    const primary = join(root, 'primary')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await writeCodexSession(primary, 'rollout-shared.jsonl')
    await writeCodexSession(nested, 'rollout-shared.jsonl')
    await writeCodexSession(nested, 'rollout-buzz-only.jsonl')
    const nest = createCodexProvider(nested, { primaryDir: primary, launcherRoots: [buzz] })
    expect(names(await nest.discoverSessions())).toEqual(['rollout-buzz-only.jsonl'])
  })

  it('default factory with CODEX_HOME=nest and a stub ~/.codex still discovers the nest', async () => {
    const home = root
    const primary = join(home, '.codex')
    const nested = join(home, '.buzz', '.codex')
    await mkdir(primary, { recursive: true })
    await writeCodexSession(nested, 'rollout-buzz.jsonl')
    const prevHome = process.env.HOME
    const prevCodex = process.env.CODEX_HOME
    process.env.HOME = home
    process.env.CODEX_HOME = nested
    try {
      const provider = createCodexProvider()
      expect(names(await provider.discoverSessions())).toEqual(['rollout-buzz.jsonl'])
      const roots = await provider.probeRoots!()
      expect(roots.map(r => r.path)).toEqual([
        join(nested, 'sessions'),
        join(nested, 'archived_sessions'),
      ])
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prevCodex
    }
  })

  it('default factory with CODEX_HOME=nest does not drop unique nest rollouts when ~/.codex has its own', async () => {
    const home = root
    const primary = join(home, '.codex')
    const nested = join(home, '.buzz', '.codex')
    await writeCodexSession(primary, 'rollout-primary.jsonl')
    await writeCodexSession(nested, 'rollout-buzz.jsonl')
    const prevHome = process.env.HOME
    const prevCodex = process.env.CODEX_HOME
    process.env.HOME = home
    process.env.CODEX_HOME = nested
    try {
      const provider = createCodexProvider()
      expect(names(await provider.discoverSessions())).toEqual(['rollout-buzz.jsonl'])
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prevCodex
    }
  })

  it('explicit nest path without second-factory opts is not silently emptied', async () => {
    const primary = join(root, 'primary')
    const nested = join(root, '.buzz', '.codex')
    await writeCodexSession(primary, 'rollout-primary.jsonl')
    await writeCodexSession(nested, 'rollout-buzz.jsonl')
    const provider = createCodexProvider(nested)
    expect(names(await provider.discoverSessions())).toEqual(['rollout-buzz.jsonl'])
  })
})

describe('doctor launchers', () => {
  it('lists Buzz as a launcher with no session count', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    await mkdir(join(home, '.buzz'), { recursive: true })
    const notes = collectLauncherNotes(home)
    expect(notes).toEqual([expect.objectContaining({ name: 'buzz', billedVia: 'codex' })])
    expect(notes[0]!.verdict).toMatch(/LAUNCHER/)
    expect(notes[0]!.verdict).not.toMatch(/\d+\s+session/)

    const report = await collectDoctorReport('all', {
      providers: [createCodexProvider(join(home, 'empty-codex'))],
      cache: emptyCache(),
      launchers: notes,
    })
    expect(report.launchers).toEqual(notes)
    const table = renderDoctorTable(report, { color: false })
    expect(table).toContain('Launchers')
    expect(table).toContain('buzz')
    expect(table).toContain('billed via Codex')
    const buzzLine = table.split('\n').find(line => /^\s*buzz\s/.test(line))
    expect(buzzLine).toBeDefined()
    expect(buzzLine).not.toMatch(/\d+\s+session/)
    await rm(home, { recursive: true, force: true })
  })
})
