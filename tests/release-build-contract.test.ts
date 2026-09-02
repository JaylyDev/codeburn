import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>
}

describe('release build contract', () => {
  it('builds from checked-in pricing catalogs instead of mutating them from the network', () => {
    expect(packageJson.scripts['bundle-litellm']).toBe('node scripts/bundle-litellm.mjs')
    expect(packageJson.scripts.build).not.toContain('bundle-litellm')
  })

  it('installs dashboard dependencies without rewriting the lockfile', () => {
    expect(packageJson.scripts['build:dash']).toContain('npm ci')
    expect(packageJson.scripts['build:dash']).not.toContain('npm install')
  })
})
