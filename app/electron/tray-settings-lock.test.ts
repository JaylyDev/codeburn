// @vitest-environment node
// The cross-process lock that serializes the read/modify/write of the tray app's files. These
// are the single-process unit tests (taken and released, a stale lock taken over, a dead
// holder's lock taken over, a live lock waited for, and the merge preserving the other side's
// keys); the real Node-against-Rust contention test lives in windows/src-tauri/src/dock.rs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acquireTrayFileLock, patchTrayFile, releaseTrayFileLock } from './tray-settings'

let home: string
const dockTarget = () => join(home, '.config', 'codeburn', 'windows-dock.json')
const lockPath = () => join(home, '.config', 'codeburn', '.windows-dock.lock')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tray-lock-'))
  mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('the cross-process preference lock', () => {
  it('takes the lock and releases it again', () => {
    const fd = acquireTrayFileLock(dockTarget())
    expect(existsSync(lockPath())).toBe(true)
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid)

    releaseTrayFileLock(dockTarget(), fd)
    expect(existsSync(lockPath())).toBe(false)
  })

  it('takes over a lock whose mtime is past the stale window', () => {
    // A live pid (our own), so only the age gate can free it. Backdate the mtime rather than
    // sleeping for the whole window.
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: 1 }))
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath(), old, old)

    const fd = acquireTrayFileLock(dockTarget(), { staleMs: 30_000, waitMs: 500 })
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid)
    releaseTrayFileLock(dockTarget(), fd)
  })

  it('takes over a dead holder without waiting out the budget', () => {
    // A pid that is not us and is almost certainly gone, with a fresh mtime: only the pid probe,
    // not the age gate, can free this one.
    writeFileSync(lockPath(), JSON.stringify({ pid: 2_147_483_646, at: Date.now() }))
    const started = Date.now()
    const fd = acquireTrayFileLock(dockTarget(), { staleMs: 60_000, waitMs: 1_000, pollMs: 20 })
    expect(Date.now() - started).toBeLessThan(400)
    releaseTrayFileLock(dockTarget(), fd)
  })

  it('waits for a live lock and then fails loudly rather than writing behind it', () => {
    const held = acquireTrayFileLock(dockTarget())
    const started = Date.now()
    // Our own pid reads as alive and the mtime is fresh, so the lock is never abandoned.
    expect(() => acquireTrayFileLock(dockTarget(), { staleMs: 60_000, waitMs: 150, pollMs: 20 }))
      .toThrow(/could not lock/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(130)
    releaseTrayFileLock(dockTarget(), held)
  })

  it('leaves a successor lock alone on release', () => {
    const fd = acquireTrayFileLock(dockTarget())
    // Simulate a successor that took over after us (only possible past the stale window).
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid + 1, at: Date.now() }))
    releaseTrayFileLock(dockTarget(), fd)
    expect(existsSync(lockPath())).toBe(true)
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid + 1)
  })

  it('still merges keys the other side owns, and cleans up its lock', () => {
    writeFileSync(dockTarget(), JSON.stringify({ enabled: true, placement: { docked: 'right' } }))

    expect(patchTrayFile('dock', { scale: 1.1 }, home)).toEqual({
      enabled: true,
      placement: { docked: 'right' },
      scale: 1.1,
    })
    // No lock file is left behind once the patch returns.
    expect(existsSync(lockPath())).toBe(false)
    expect(() => statSync(lockPath())).toThrow()
  })
})
