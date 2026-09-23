// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import type { CompanionStatus } from '../lib/types'

const bridge = vi.hoisted(() => ({
  companionStatus: vi.fn(),
  companionInstall: vi.fn(),
  companionOpen: vi.fn(),
  companionQuit: vi.fn(),
  companionUninstall: vi.fn(),
  companionSetDock: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({ codeburn: bridge, normalizeCliError: (err: unknown) => err }))

const { WindowsCompanionCard } = await import('./WindowsCompanionCard')

function status(patch: Partial<CompanionStatus> = {}): CompanionStatus {
  return {
    supported: true, menuBar: true, sidebar: true, store: false,
    canInstall: true, installed: true, running: true, version: '0.9.24', outdated: false,
    ...patch,
  }
}

afterEach(() => { vi.clearAllMocks() })

function renderCard(s: CompanionStatus = status(), onOpenSettings?: () => void) {
  bridge.companionStatus.mockResolvedValue(s)
  render(<WindowsCompanionCard onOpenSettings={onOpenSettings} />)
}

describe('WindowsCompanionCard', () => {
  it('renders nothing where the main process reports no bundled tray app', async () => {
    renderCard(status({ supported: false }))
    await waitFor(() => expect(bridge.companionStatus).toHaveBeenCalled())
    expect(screen.queryByText('Menu bar')).toBeNull()
  })

  it('offers Install when supported but nothing is installed', async () => {
    renderCard(status({ installed: false, running: false, version: null }))
    const install = await screen.findByRole('button', { name: 'Install' })
    bridge.companionInstall.mockResolvedValue({ ok: true, error: null, status: status() })

    fireEvent.click(install)

    await waitFor(() => expect(bridge.companionInstall).toHaveBeenCalled())
  })

  it('shows the website line where the tray app cannot be installed from here (Store)', async () => {
    renderCard(status({ installed: false, running: false, canInstall: false, version: null }))
    expect(await screen.findByText('Get the menu bar from the website')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('shows Running and the version while it is up', async () => {
    renderCard()
    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(screen.getByText('v0.9.24')).toBeInTheDocument()
  })

  it('while running, offers Settings, Quit, Uninstall and an enabled dock toggle, but not Open', async () => {
    const onOpenSettings = vi.fn()
    renderCard(status(), onOpenSettings)

    expect(await screen.findByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Quit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Capacity Dock' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('while down, offers Open and Uninstall, and the dock toggle is disabled', async () => {
    renderCard(status({ running: false }))
    expect(await screen.findByRole('button', { name: 'Open' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Capacity Dock' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Quit' })).toBeNull()

    bridge.companionOpen.mockResolvedValue(status())
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(bridge.companionOpen).toHaveBeenCalled())
  })

  it('offers Update when a newer tray app is staged', async () => {
    renderCard(status({ outdated: true }))
    const update = await screen.findByRole('button', { name: 'Update' })
    bridge.companionInstall.mockResolvedValue({ ok: true, error: null, status: status({ outdated: false }) })

    fireEvent.click(update)

    await waitFor(() => expect(bridge.companionInstall).toHaveBeenCalled())
  })

  it('toggling the Capacity Dock sends the opposite of what is set', async () => {
    renderCard(status({ sidebar: true }))
    const dock = await screen.findByRole('switch', { name: 'Capacity Dock' })
    bridge.companionSetDock.mockResolvedValue(status({ sidebar: false }))

    fireEvent.click(dock)

    expect(bridge.companionSetDock).toHaveBeenCalledWith(false)
  })

  it('quits only on a second click, and calls the quit action then', async () => {
    renderCard()
    const quit = await screen.findByRole('button', { name: 'Quit' })

    fireEvent.click(quit)
    expect(bridge.companionQuit).not.toHaveBeenCalled()

    bridge.companionQuit.mockResolvedValue({ ok: true, error: null, status: status({ running: false }) })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm quit' }))
    await waitFor(() => expect(bridge.companionQuit).toHaveBeenCalled())
  })

  it('uninstalls only on a second click', async () => {
    renderCard()
    const uninstall = await screen.findByRole('button', { name: 'Uninstall' })

    fireEvent.click(uninstall)
    expect(bridge.companionUninstall).not.toHaveBeenCalled()

    bridge.companionUninstall.mockResolvedValue({ ok: true, error: null, status: status({ installed: false, running: false }) })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm uninstall' }))
    await waitFor(() => expect(bridge.companionUninstall).toHaveBeenCalled())
  })

  it('opens the info popup from the info dot', async () => {
    renderCard()
    fireEvent.click(await screen.findByRole('button', { name: 'What the menu bar app does' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('shows the returned error when an action fails', async () => {
    renderCard(status({ installed: false, running: false, version: null }))
    const install = await screen.findByRole('button', { name: 'Install' })
    bridge.companionInstall.mockResolvedValue({ ok: false, error: 'msiexec exited with 1603', status: status({ installed: false }) })

    fireEvent.click(install)

    expect(await screen.findByText('msiexec exited with 1603')).toBeInTheDocument()
  })
})
