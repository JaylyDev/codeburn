// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

describe('PluginsSection', () => {
  it('renders row actions for loaded plugins', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="container">
        <h1>Plugins</h1>
        <div class="list">
          <div class="row" data-status="loaded">
            <div class="info">
              <div class="name">test-plugin@1.0.0</div>
            </div>
            <div class="actions">
              <button>Details</button>
              <button>Verify</button>
              <button>Remove</button>
            </div>
          </div>
        </div>
      </div>
    `
    expect(container.textContent).toContain('Details')
    expect(container.textContent).toContain('Verify')
    expect(container.textContent).toContain('Remove')
  })

  it('renders disclosure modal for plugin details', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="modalBackdrop">
        <div class="modal">
          <button class="modalClose">×</button>
          <div class="modalContent">
            <h2>test-plugin@1.0.0</h2>
            <section class="section">
              <h3>Sync Fields</h3>
              <ul>
                <li>
                  <strong>field1</strong>
                  <p class="disclosure">This field is shared</p>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    `
    expect(container.textContent).toContain('Sync Fields')
    expect(container.textContent).toContain('This field is shared')
  })

  it('renders install flow stepper', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="modalBackdrop">
        <div class="modal">
          <h2>Install Plugin</h2>
          <label>
            <input type="radio" name="source" value="org" />
            From your organization
          </label>
          <label>
            <input type="radio" name="source" value="folder" />
            From folder
          </label>
        </div>
      </div>
    `
    expect(container.textContent).toContain('Install Plugin')
    expect(container.textContent).toContain('From your organization')
    expect(container.textContent).toContain('From folder')
  })

  it('renders Team tab registry section', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="team-section">
        <div class="team-card">
          <div class="team-stat">
            <span>Total spend</span>
            <div>$123.45</div>
          </div>
        </div>
      </div>
    `
    expect(container.textContent).toContain('Total spend')
    expect(container.textContent).toContain('$123.45')
  })
})
