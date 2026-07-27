import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { findProvider, supportedProviders } from '../src/providers/registry.js'

/**
 * DRIFT GUARD. The registry, the package exports map, and the source tree must
 * agree. Any one of them changing alone fails this test — which is the point:
 * a provider added to `package.json` but not the registry is invisible to
 * consumers, and a registry entry with no export is a broken import waiting to
 * happen.
 */
const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'))

// Every `./providers/*` export EXCEPT the registry itself, which is metadata
// about providers rather than a provider.
const exportedProviderPaths = Object.keys(pkg.exports)
  .filter((s) => s.startsWith('./providers/') && s !== './providers/registry')
  .sort()

const sourceProviderDirs = readdirSync(resolve(pkgRoot, 'src/providers'))
  .filter((name) => statSync(resolve(pkgRoot, 'src/providers', name)).isDirectory())
  .sort()

describe('provider registry', () => {
  it('is non-empty and frozen', () => {
    const providers = supportedProviders()
    expect(providers.length).toBeGreaterThan(0)
    expect(Object.isFrozen(providers)).toBe(true)
    expect(Object.isFrozen(providers[0])).toBe(true)
  })

  it('lists exactly the exported provider subpaths', () => {
    const fromRegistry = supportedProviders()
      .map((p) => p.exportPath)
      .sort()
    expect(fromRegistry).toEqual(exportedProviderPaths)
  })

  it('lists exactly the provider source directories', () => {
    const fromRegistry = supportedProviders()
      .map((p) => p.id)
      .sort()
    expect(fromRegistry).toEqual(sourceProviderDirs)
  })

  it('derives each exportPath from its id', () => {
    for (const p of supportedProviders()) {
      expect(p.exportPath).toBe(`./providers/${p.id}`)
    }
  })

  it('has no duplicate ids', () => {
    const ids = supportedProviders().map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('resolves a known provider and rejects an unknown one', () => {
    expect(findProvider('claude')?.exportPath).toBe('./providers/claude')
    expect(findProvider('not-a-provider')).toBeUndefined()
  })

  it('reports incremental-state support matching the decoder signature', () => {
    // claude exposes per-entry decode helpers with no caller-owned dedup set;
    // every other provider threads one. Pinned so a signature change that
    // silently drops incremental support is caught here.
    expect(findProvider('claude')?.supportsIncrementalState).toBe(false)
    const others = supportedProviders().filter((p) => p.id !== 'claude')
    expect(others.every((p) => p.supportsIncrementalState)).toBe(true)
  })

  it('every declared export target exists in package.json', () => {
    for (const p of supportedProviders()) {
      expect(pkg.exports[p.exportPath], `missing exports entry for ${p.id}`).toBeTruthy()
    }
  })
})
