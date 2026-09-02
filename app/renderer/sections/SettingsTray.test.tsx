// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// The preload bridge is read once at module load, so it has to be mocked rather than
// assigned onto `window` after the fact.
const bridge = vi.hoisted(() => ({
  companionStatus: vi.fn(),
  trayPrefs: vi.fn(),
  setTrayAppPref: vi.fn(),
  setTrayDockPref: vi.fn(),
  setLaunchAtLogin: vi.fn(),
  getQuota: vi.fn(),
  openExternal: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({ codeburn: bridge, normalizeCliError: (err: unknown) => err }))

const { CapacityDockPane, MenuBarPane } = await import('./SettingsTray')

const PREFS = {
  app: {
    metric: 'cost',
    menubarPeriod: 'today',
    accent: 'ember',
    trayBadge: false,
    usageRefreshSeconds: -1,
    quotaCadenceSeconds: 120,
    terminal: 'windowsTerminal',
  },
  dock: {
    enabled: true,
    preferred: 'claude',
    scale: 0.6,
    theme: 'graphite',
    gaugeShape: 'circle',
    providers: ['claude', 'codex'],
    manualSelection: true,
  },
  launchAtLogin: false,
}

const connected = (...ids: string[]) => ids.map(id => ({
  provider: id, connection: 'connected', primary: null, details: [], planLabel: null, footerLines: [],
}))

beforeEach(() => {
  bridge.trayPrefs.mockResolvedValue(PREFS)
  bridge.setTrayAppPref.mockImplementation(async (patch: Record<string, unknown>) =>
    ({ ...PREFS, app: { ...PREFS.app, ...patch } }))
  bridge.setTrayDockPref.mockImplementation(async (patch: Record<string, unknown>) =>
    ({ ...PREFS, dock: { ...PREFS.dock, ...patch } }))
  bridge.setLaunchAtLogin.mockImplementation(async (enabled: boolean) => ({ ...PREFS, launchAtLogin: enabled }))
  bridge.getQuota.mockResolvedValue(connected('claude', 'codex'))
})

afterEach(() => { vi.clearAllMocks() })

/** Dropdown is a custom listbox, not a select: a trigger button labelled with its aria
 *  label, and options that appear once it is open. */
async function choose(ariaLabel: string, optionLabel: string) {
  fireEvent.click(await screen.findByRole("button", { name: ariaLabel }))
  fireEvent.click(await screen.findByRole("option", { name: optionLabel }))
}

async function selected(ariaLabel: string): Promise<string> {
  return (await screen.findByRole("button", { name: ariaLabel })).textContent ?? ""
}


describe('MenuBarPane', () => {
  it('shows each of the tray app settings the desktop app does not already have', async () => {
    render(<MenuBarPane />)

    expect(await selected('Tray metric')).toContain('Cost')
    expect(await selected('Tray period')).toContain('Today')
    expect(await selected('Usage refresh')).toContain('Auto')
    expect(await selected('Quota refresh')).toContain('2 minutes')
    expect(await selected('Terminal')).toContain('Windows Terminal')
    expect(screen.getByRole('switch', { name: "Show today's figure in the tray" })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: 'Launch at login' })).toHaveAttribute('aria-checked', 'false')
    // The nine presets from the tray app's own accent picker.
    expect(screen.getAllByRole('radio')).toHaveLength(9)
    expect(screen.getByRole('radio', { name: 'Ember' })).toHaveAttribute('aria-checked', 'true')
  })

  it.each([
    ['Tray metric', 'Icon only', { metric: 'iconOnly' }],
    ['Tray period', 'Week', { menubarPeriod: 'week' }],
    ['Usage refresh', '5 minutes', { usageRefreshSeconds: 300 }],
    ['Quota refresh', '15 minutes', { quotaCadenceSeconds: 900 }],
    ['Terminal', 'Windows PowerShell', { terminal: 'powershell' }],
  ])('writes %s', async (label, option, patch) => {
    render(<MenuBarPane />)

    await choose(label, option)

    expect(bridge.setTrayAppPref).toHaveBeenCalledWith(patch)
  })

  it('writes the accent and the tray figure switch', async () => {
    render(<MenuBarPane />)

    fireEvent.click(await screen.findByRole('radio', { name: 'Green' }))
    expect(bridge.setTrayAppPref).toHaveBeenCalledWith({ accent: 'green' })

    fireEvent.click(screen.getByRole('switch', { name: "Show today's figure in the tray" }))
    expect(bridge.setTrayAppPref).toHaveBeenCalledWith({ trayBadge: true })
  })

  it('writes launch at login through its own channel, since it is a Run value', async () => {
    render(<MenuBarPane />)

    fireEvent.click(await screen.findByRole('switch', { name: 'Launch at login' }))

    expect(bridge.setLaunchAtLogin).toHaveBeenCalledWith(true)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Launch at login' })).toHaveAttribute('aria-checked', 'true'))
  })

  // The main process decides what a value ends up as, so the pane renders its answer.
  it('renders what came back rather than what was asked for', async () => {
    bridge.setTrayAppPref.mockResolvedValue({ ...PREFS, app: { ...PREFS.app, metric: 'cost' } })
    render(<MenuBarPane />)

    await choose('Tray metric', 'Total tokens')

    await waitFor(() => expect(bridge.setTrayAppPref).toHaveBeenCalled())
    expect(await selected('Tray metric')).toContain('Cost')
  })
})

describe('CapacityDockPane', () => {
  it('shows the rail settings the tray app keeps', async () => {
    render(<CapacityDockPane />)

    expect(await selected('Resting provider')).toContain('Claude')
    expect((screen.getByLabelText('Capacity Dock size') as HTMLInputElement).value).toBe('0.6')
    expect(await selected('Capacity Dock appearance')).toContain('Graphite')
    expect(await selected('Gauge shape')).toContain('Circle')
    expect(screen.getByRole('switch', { name: 'Show the Capacity Dock' })).toHaveAttribute('aria-checked', 'true')
  })

  it.each([
    ['Capacity Dock appearance', 'Glass', { theme: 'glass' }],
    ['Gauge shape', 'Squircle', { gaugeShape: 'squircle' }],
    ['Resting provider', 'Codex', { preferred: 'codex' }],
  ])('writes %s', async (label, option, patch) => {
    render(<CapacityDockPane />)

    await choose(label, option)

    expect(bridge.setTrayDockPref).toHaveBeenCalledWith(patch)
  })

  it('writes the size from the slider', async () => {
    render(<CapacityDockPane />)

    fireEvent.change(await screen.findByLabelText('Capacity Dock size'), { target: { value: '1.1' } })

    expect(bridge.setTrayDockPref).toHaveBeenCalledWith({ scale: 1.1 })
  })

  it('writes the provider set when a switch is turned off', async () => {
    render(<CapacityDockPane />)

    fireEvent.click(await screen.findByRole('switch', { name: 'Codex on the Capacity Dock' }))

    expect(bridge.setTrayDockPref).toHaveBeenCalledWith({ providers: ['claude'] })
  })

  // The rail must never end up with nothing to show.
  it('will not let the last connected provider be switched off', async () => {
    bridge.getQuota.mockResolvedValue(connected('claude'))
    bridge.trayPrefs.mockResolvedValue({ ...PREFS, dock: { ...PREFS.dock, providers: ['claude'] } })
    render(<CapacityDockPane />)

    const claude = await screen.findByRole('switch', { name: 'Claude on the Capacity Dock' })
    expect(claude).toBeDisabled()
    fireEvent.click(claude)
    expect(bridge.setTrayDockPref).not.toHaveBeenCalled()
  })

  it('keeps a provider on the rail after its connection drops, so it can be taken off', async () => {
    bridge.getQuota.mockResolvedValue(connected('claude'))
    render(<CapacityDockPane />)

    const codex = await screen.findByRole('switch', { name: 'Codex on the Capacity Dock' })
    expect(codex).toBeEnabled()
    fireEvent.click(codex)
    expect(bridge.setTrayDockPref).toHaveBeenCalledWith({ providers: ['claude'] })
  })

  it('says so rather than showing an empty list when nothing is connected', async () => {
    bridge.getQuota.mockResolvedValue([])
    bridge.trayPrefs.mockResolvedValue({ ...PREFS, dock: { ...PREFS.dock, providers: [] } })
    render(<CapacityDockPane />)

    expect(await screen.findByText(/No providers are connected yet/)).toBeInTheDocument()
  })
})
