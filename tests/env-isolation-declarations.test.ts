// Static guard: every PROVIDER_ENV_VARS entry must be CLEARED or REDIRECTED
// by tests/setup/env-isolation.ts. A data-dir override that is fingerprinted
// for cache invalidation but not isolated in tests leaks the developer's real
// sessions into fixture parses — green on CI (no HERMES_HOME), red on a
// Hermes-shell laptop. The named hole was HERMES_HOME; the class is every
// sibling override that session-cache already knows about.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { PROVIDER_ENV_VARS } from '../src/session-cache.js'

const SETUP_PATH = join(dirname(fileURLToPath(import.meta.url)), 'setup', 'env-isolation.ts')

function extractConstStringArray(source: string, name: string): string[] {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const`))
  if (!match) {
    throw new Error(`tests/setup/env-isolation.ts: const ${name} = [...] as const not found`)
  }
  return [...match[1]!.matchAll(/'([A-Z0-9_]+)'/g)].map(m => m[1]!)
}

describe('env-isolation covers PROVIDER_ENV_VARS', () => {
  it('clears or redirects every provider data-dir override so a developer shell cannot leak real sessions into fixtures', () => {
    const source = readFileSync(SETUP_PATH, 'utf8')
    const isolated = new Set([
      ...extractConstStringArray(source, 'CLEARED'),
      ...extractConstStringArray(source, 'REDIRECTED'),
    ])

    const missing: string[] = []
    for (const [provider, vars] of Object.entries(PROVIDER_ENV_VARS)) {
      for (const varName of vars) {
        if (!isolated.has(varName)) missing.push(`${provider}:${varName}`)
      }
    }

    expect(missing).toEqual([])
  })
})
