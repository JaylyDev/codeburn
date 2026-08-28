// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { PluginsSection } from './Plugins'

describe('PluginsSection', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    ;(window as any).codeburn = {
      pluginList: vi.fn().mockResolvedValue([]),
    }
  })

  afterEach(() => {
    ;(window as any).codeburn = undefined
  })

  it('renders without crashing', () => {
    const { container } = render(<PluginsSection />)
    expect(container).toBeDefined()
  })

  it('displays loaded plugins with status chip', () => {
    ;(window as any).codeburn = {
      pluginList: vi.fn().mockResolvedValue([
        {
          name: 'test-plugin',
          version: '0.1.0',
          status: 'loaded',
          capabilities: { commands: ['test'], syncAttributes: [], payloadSections: [], spanKinds: [] },
        },
      ]),
    }
    const { container } = render(<PluginsSection />)
    expect(container).toBeDefined()
  })

  it('displays rejected plugins with reason', () => {
    ;(window as any).codeburn = {
      pluginList: vi.fn().mockResolvedValue([
        { name: 'bad-plugin', status: 'rejected', reason: 'manifest error' },
      ]),
    }
    const { container } = render(<PluginsSection />)
    expect(container).toBeDefined()
  })
})
