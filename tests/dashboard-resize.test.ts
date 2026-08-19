import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'

import React, { useEffect } from 'react'
import { Text } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RESIZE_DEBOUNCE_MS, createDebouncedResizeStream, renderDebouncedInteractive } from '../src/dashboard.js'
import { stripSyncUpdateEscapes } from '../src/ink-win.js'

function makeTerminal(columns = 100, rows = 24): PassThrough & NodeJS.WriteStream {
  const terminal = new PassThrough() as PassThrough & NodeJS.WriteStream
  terminal.isTTY = true
  terminal.columns = columns
  terminal.rows = rows
  return terminal
}

function paintedFrames(writes: string[]): string[] {
  return writes
    .map(chunk => stripSyncUpdateEscapes(chunk))
    .flatMap(chunk => chunk.match(/FRAME:[^\r\n]*/g) ?? [])
}

describe('interactive dashboard resize stream', () => {
  afterEach(() => vi.useRealTimers())

  it('does not intercept writes or parse synchronized-update frames', () => {
    const source = readFileSync(new URL('../src/dashboard.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('suppressingFrame')
    expect(source).not.toContain('capturingResizeWrites')
    expect(source).not.toContain('finalFramePreamble')
    expect(source).not.toContain('indexOf(BSU)')
    expect(source).not.toContain('indexOf(ESU)')
    expect(source).not.toContain('process.stdout.prependListener')
  })

  it('publishes one settled paint after a resize burst', async () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    const writes: string[] = []
    terminal.on('data', chunk => writes.push(String(chunk)))
    const app = renderDebouncedInteractive(terminal, size => (
      React.createElement(Text, null, `FRAME:${size.columns}x${size.rows}`)
    ), {
      interactive: true,
      patchConsole: false,
      alternateScreen: true,
    })
    await vi.advanceTimersByTimeAsync(100)
    writes.length = 0

    terminal.columns = 99
    terminal.emit('resize')
    await vi.advanceTimersByTimeAsync(50)
    terminal.columns = 98
    terminal.emit('resize')
    await vi.advanceTimersByTimeAsync(50)
    terminal.columns = 97
    terminal.rows = 30
    terminal.emit('resize')

    await vi.advanceTimersByTimeAsync(RESIZE_DEBOUNCE_MS + 100)

    const frames = paintedFrames(writes)
    expect(frames.filter(frame => frame !== 'FRAME:97x30'), 'a resize burst must not paint intermediate sizes').toEqual([])
    expect(frames).toContain('FRAME:97x30')

    app.unmount()
    app.dispose()
    await vi.runAllTimersAsync()
    await app.waitUntilExit()
  })

  it('paints a mid-burst state update when the burst nets to no size change', async () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    const writes: string[] = []
    terminal.on('data', chunk => writes.push(String(chunk)))
    let updateVisibleState = () => {}
    const StatefulProbe = ({ size }: { size: { columns: number; rows: number } }) => {
      const [revision, setRevision] = React.useState(0)
      updateVisibleState = () => setRevision(value => value + 1)
      return React.createElement(Text, null, `FRAME:revision=${revision}:size=${size.columns}x${size.rows}`)
    }
    const app = renderDebouncedInteractive(terminal, size => React.createElement(StatefulProbe, { size }), {
      interactive: true,
      patchConsole: false,
      alternateScreen: true,
    })
    await vi.advanceTimersByTimeAsync(100)
    writes.length = 0

    terminal.columns = 80
    terminal.emit('resize')
    updateVisibleState()
    terminal.columns = 100
    terminal.emit('resize')

    await vi.advanceTimersByTimeAsync(RESIZE_DEBOUNCE_MS + 100)

    expect(paintedFrames(writes).some(frame => frame.includes('revision=1')), 'a mid-burst state update must reach the terminal even when net size is unchanged').toBe(true)

    app.unmount()
    app.dispose()
    await vi.runAllTimersAsync()
    await app.waitUntilExit()
  })

  it('paints a state update after a spurious identical-dimension SIGWINCH', async () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    const writes: string[] = []
    terminal.on('data', chunk => writes.push(String(chunk)))
    let updateVisibleState = () => {}
    const StatefulProbe = ({ size }: { size: { columns: number; rows: number } }) => {
      const [revision, setRevision] = React.useState(0)
      updateVisibleState = () => setRevision(value => value + 1)
      return React.createElement(Text, null, `FRAME:revision=${revision}:size=${size.columns}x${size.rows}`)
    }
    const app = renderDebouncedInteractive(terminal, size => React.createElement(StatefulProbe, { size }), {
      interactive: true,
      patchConsole: false,
      alternateScreen: true,
    })
    await vi.advanceTimersByTimeAsync(100)
    writes.length = 0

    terminal.emit('resize')
    updateVisibleState()

    await vi.advanceTimersByTimeAsync(RESIZE_DEBOUNCE_MS + 100)

    expect(paintedFrames(writes).some(frame => frame.includes('revision=1')), 'a state update must still paint after a no-op SIGWINCH').toBe(true)

    app.unmount()
    app.dispose()
    await vi.runAllTimersAsync()
    await app.waitUntilExit()
  })

  it('removes the source relay and cancels pending resize delivery on dispose', async () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    const renderedSizes: Array<{ columns: number; rows: number }> = []
    const Probe = ({ size }: { size: { columns: number; rows: number } }) => {
      useEffect(() => {
        renderedSizes.push(size)
      }, [size])
      return React.createElement(Text, null, `FRAME:${size.columns}x${size.rows}`)
    }
    const app = renderDebouncedInteractive(terminal, size => React.createElement(Probe, { size }), {
      interactive: true,
      patchConsole: false,
    })
    await vi.advanceTimersByTimeAsync(100)
    renderedSizes.length = 0

    terminal.columns = 90
    terminal.emit('resize')
    app.unmount()
    app.dispose()
    await vi.runAllTimersAsync()
    await app.waitUntilExit()

    await vi.advanceTimersByTimeAsync(RESIZE_DEBOUNCE_MS)
    expect(renderedSizes).toEqual([])
    expect(terminal.listenerCount('resize')).toBe(0)
  })

  it('disposes a stream that never rendered', () => {
    const terminal = makeTerminal()
    const stdout = createDebouncedResizeStream(terminal, RESIZE_DEBOUNCE_MS)
    expect(terminal.listenerCount('resize')).toBe(1)
    stdout.dispose()
    expect(terminal.listenerCount('resize')).toBe(0)

    const resize = vi.fn()
    stdout.on('resize', resize)
    terminal.emit('resize')
    expect(resize).not.toHaveBeenCalled()
    expect(terminal.listenerCount('resize')).toBe(0)
  })
})
