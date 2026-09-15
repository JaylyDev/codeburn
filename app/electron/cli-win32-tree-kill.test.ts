// @vitest-environment node
// Ending a CLI child on Windows. There is no process group to signal, so the whole tree has
// to be walked by pid, and the order matters: the handle may only be ended once taskkill has
// answered. This needs its own file because it mocks `node:os` and `node:child_process`
// wholesale, which the rest of the CLI suite runs against for real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// vi.mock factories are hoisted above the module body, so the spies they close over have to
// be hoisted with them.
const { platformMock, spawnMock } = vi.hoisted(() => ({
  platformMock: vi.fn(() => 'win32'),
  spawnMock: vi.fn(),
}))

vi.mock('node:os', async orig => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, platform: platformMock }
})
vi.mock('node:child_process', async orig => {
  const actual = await orig<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

const { spawnCliAction, killAll, taskkillArgs, taskkillPath } = await import('./cli')

/** Just enough of a ChildProcess for the two things this module does with one: read its
 *  streams and end it. `kill` is a spy so the ordering can be asserted. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true)
  constructor(readonly pid: number) { super() }
}

let dir: string
let originalBundled: string | undefined

/** Every spawn after the CLI's own is a taskkill, and each gets its own fake. */
function taskkillSpawns(): Array<{ args: Parameters<typeof spawnMock>; child: FakeChild }> {
  return spawnMock.mock.calls.slice(1).map((args, index) => ({
    args: args as Parameters<typeof spawnMock>,
    child: spawnMock.mock.results[index + 1]!.value as FakeChild,
  }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codeburn-tree-kill-'))
  const entry = join(dir, 'cli.js')
  writeFileSync(entry, '')
  originalBundled = process.env.CODEBURN_BUNDLED_CLI
  process.env.CODEBURN_BUNDLED_CLI = entry
  platformMock.mockReturnValue('win32')

  spawnMock.mockReset()
  let next = 4242
  spawnMock.mockImplementation(() => new FakeChild(next++))
})

afterEach(() => {
  killAll()
  if (originalBundled === undefined) delete process.env.CODEBURN_BUNDLED_CLI
  else process.env.CODEBURN_BUNDLED_CLI = originalBundled
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

/** Start an action, hold its child, and hand back the promise so it can be settled. */
function startAction(): Promise<unknown> {
  const flight = spawnCliAction(['currency', 'EUR'])
  return flight
}

async function spawnedCli(): Promise<FakeChild> {
  // The slot grant is a resolved promise, so the spawn lands on the next microtask turn.
  await Promise.resolve()
  await Promise.resolve()
  return spawnMock.mock.results[0]!.value as FakeChild
}

describe('ending a CLI child on Windows', () => {
  it('walks the tree with taskkill out of System32, and only that pid', async () => {
    const flight = startAction()
    const child = await spawnedCli()

    killAll()

    const kills = taskkillSpawns()
    expect(kills).toHaveLength(1)
    const [bin, args, options] = kills[0]!.args as [string, string[], Record<string, unknown>]
    expect(bin).toBe(taskkillPath())
    expect(bin.toLowerCase()).toContain('\\system32\\taskkill.exe')
    expect(args).toEqual(['/pid', String(child.pid), '/T', '/F'])
    expect(args).toEqual(taskkillArgs(child.pid))
    expect(options).toMatchObject({ stdio: 'ignore', windowsHide: true })

    child.emit('close', null)
    await flight
  })

  /// The bug this pins: ending the handle first reparents everything below it, and taskkill
  /// then reports the pid as not found and reaps nothing.
  it('leaves the handle alone until taskkill has answered', async () => {
    const flight = startAction()
    const child = await spawnedCli()

    killAll()

    expect(child.kill).not.toHaveBeenCalled()
    taskkillSpawns()[0]!.child.emit('exit', 0)
    expect(child.kill).not.toHaveBeenCalled()

    child.emit('close', null)
    await flight
  })

  it('falls back to the direct kill when taskkill finds nothing to end', async () => {
    const flight = startAction()
    const child = await spawnedCli()

    killAll()
    taskkillSpawns()[0]!.child.emit('exit', 128)

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')

    child.emit('close', null)
    await flight
  })

  it('falls back to the direct kill when taskkill cannot start at all', async () => {
    const flight = startAction()
    const child = await spawnedCli()

    killAll()
    taskkillSpawns()[0]!.child.emit('error', new Error('spawn taskkill.exe ENOENT'))

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')

    child.emit('close', null)
    await flight
  })

  it('signals the process group instead off Windows', async () => {
    platformMock.mockReturnValue('darwin')
    const flight = startAction()
    const child = await spawnedCli()
    const signalled: Array<[number, string | number | undefined]> = []
    const originalKill = process.kill
    // process.kill is swapped rather than spied: Electron's process typings do not expose it
    // to vi.spyOn's key constraint.
    process.kill = ((pid: number, signal?: string | number) => {
      signalled.push([pid, signal])
      return true
    }) as typeof process.kill

    try {
      killAll()
    } finally {
      process.kill = originalKill
    }

    expect(taskkillSpawns()).toHaveLength(0)
    expect(signalled).toEqual([[-child.pid, 'SIGKILL']])

    child.emit('close', null)
    await flight
  })
})

describe('taskkillPath', () => {
  it('takes System32 from SystemRoot and falls back when it is not a drive path', () => {
    expect(taskkillPath({ SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\taskkill.exe')
    expect(taskkillPath({ SystemRoot: 'D:\\Windows\\' })).toBe('D:\\Windows\\System32\\taskkill.exe')
    expect(taskkillPath({ SystemRoot: '../evil' })).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(taskkillPath({})).toBe('C:\\Windows\\System32\\taskkill.exe')
  })
})
