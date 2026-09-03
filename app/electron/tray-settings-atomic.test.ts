// @vitest-environment node
// How the tray app's settings files are written, as opposed to what goes in them.
//
// The tray app reads `windows-settings.json` and `windows-dock.json` on a cadence of its own
// and again on every `--reload-settings`, while this side writes them. A plain
// `writeFileSync` truncates the target and then fills it, so a read landing between the two
// sees an empty or half-written file, parses it as no preferences at all, and every setting
// in it collapses to a default.
//
// Its own file because pinning the write and the rename means mocking `node:fs` wholesale,
// which the rest of the tray-settings suite runs against for real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = actualFs

// vi.mock factories are hoisted above the module body, so the spies they close over have to
// be hoisted with them. Each defaults to the real thing and is redirected per test.
const { writeMock, renameMock } = vi.hoisted(() => ({
  writeMock: vi.fn(),
  renameMock: vi.fn(),
}))

vi.mock('node:fs', async orig => {
  const actual = await orig<typeof import('node:fs')>()
  writeMock.mockImplementation(actual.writeFileSync)
  renameMock.mockImplementation(actual.renameSync)
  return { ...actual, writeFileSync: writeMock, renameSync: renameMock }
})

const { patchTrayFile, writeFileAtomic } = await import('./tray-settings')

let home: string
const dockPath = () => join(home, '.config', 'codeburn', 'windows-dock.json')

/** Every path `writeFileSync` was given, which must never include the target itself. */
function written(): string[] {
  return writeMock.mock.calls.map(call => String((call as [string])[0]))
}

beforeEach(() => {
  home = mkdtempSync(join(actualFs.realpathSync(tmpdir()), 'tray-atomic-'))
  mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
  writeMock.mockClear()
  renameMock.mockClear()
  writeMock.mockImplementation(actualFs.writeFileSync)
  renameMock.mockImplementation(actualFs.renameSync)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('writing a file the tray app reads', () => {
  it('writes a temp file in the same directory and renames it over the target', () => {
    patchTrayFile('dock', { scale: 1.1 }, home)

    expect(written()).toHaveLength(1)
    const temp = written()[0]!
    // The target is never opened for writing, so it is never briefly empty.
    expect(temp).not.toBe(dockPath())
    // The same directory, because a rename across volumes is a copy, and a copy is not atomic.
    expect(dirname(temp)).toBe(dirname(dockPath()))
    expect(renameMock).toHaveBeenCalledWith(temp, dockPath())
    expect(JSON.parse(readFileSync(dockPath(), 'utf8'))).toEqual({ scale: 1.1 })
    expect(readdirSync(dirname(dockPath()))).toEqual(['windows-dock.json'])
  })

  it('still merges into what the tray app already wrote', () => {
    writeFileSync(dockPath(), JSON.stringify({ enabled: true, placement: { docked: 'right' } }))

    expect(patchTrayFile('dock', { scale: 1.1 }, home)).toEqual({
      enabled: true,
      placement: { docked: 'right' },
      scale: 1.1,
    })
    expect(JSON.parse(readFileSync(dockPath(), 'utf8'))).toEqual({
      enabled: true,
      placement: { docked: 'right' },
      scale: 1.1,
    })
  })

  /// The whole point of the rename: everything up to it can be lost without the tray app ever
  /// seeing anything but the file it had.
  it('leaves the old file whole when the rename never happens', () => {
    writeFileSync(dockPath(), JSON.stringify({ enabled: true, scale: 0.6 }))
    renameMock.mockImplementation(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) })

    expect(() => patchTrayFile('dock', { scale: 1.1 }, home)).toThrow('EPERM')

    expect(JSON.parse(readFileSync(dockPath(), 'utf8'))).toEqual({ enabled: true, scale: 0.6 })
    // And no half-written temp file is left in the directory the tray app reads.
    expect(readdirSync(dirname(dockPath()))).toEqual(['windows-dock.json'])
  })

  it('reports a failed write rather than letting it read as a save', () => {
    writeMock.mockImplementation(() => { throw new Error('ENOSPC') })

    expect(() => writeFileAtomic(dockPath(), 'x')).toThrow('ENOSPC')
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('creates the directory when nothing has written there yet', () => {
    rmSync(join(home, '.config'), { recursive: true, force: true })

    writeFileAtomic(dockPath(), 'hello')

    expect(readFileSync(dockPath(), 'utf8')).toBe('hello')
  })
})
