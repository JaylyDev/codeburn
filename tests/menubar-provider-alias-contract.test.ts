import { readFileSync } from 'fs'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

import { allProviderNames } from '../src/providers/index.js'

// The menubar's ProviderFilter.cliArg is what gets passed to `--provider`, and
// it is also the id the payload-consistency guard matches against
// providerDetails. A case whose cliArg is not a real registry name silently
// disables that guard for its tab: the lookup finds no detail row, so no
// contradiction is ever detected. Nothing in either language can see both
// sides, so the contract is checked here, where the registry is importable and
// the Swift source is readable.
const APP_STORE = join(process.cwd(), 'mac/Sources/CodeBurnMenubar/AppStore.swift')

function providerFilterSource(): string {
  const source = readFileSync(APP_STORE, 'utf-8')
  const start = source.indexOf('enum ProviderFilter')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start)
}

/** Every `case foo = "Bar"` declared on the enum. */
function enumCases(source: string): string[] {
  const body = source.slice(0, source.indexOf('var id: String'))
  return [...body.matchAll(/^\s*case (\w+) = "/gm)].map(m => m[1]!)
}

/** The `case .foo: "bar"` table inside `var cliArg`. */
function cliArgTable(source: string): Record<string, string> {
  const start = source.indexOf('var cliArg: String {')
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('\n    }', start))
  return Object.fromEntries(
    [...body.matchAll(/case \.(\w+): "([^"]+)"/g)].map(m => [m[1]!, m[2]!]),
  )
}

describe('menubar ProviderFilter to CLI provider registry', () => {
  const source = providerFilterSource()
  const cases = enumCases(source)
  const cliArgs = cliArgTable(source)
  const registry = new Set(allProviderNames())

  it('declares a cliArg for every enum case', () => {
    expect(cases.length).toBeGreaterThan(20)
    expect(cases.filter(name => !(name in cliArgs))).toEqual([])
  })

  it.each(Object.entries(cliArgs).filter(([name]) => name !== 'all'))(
    'maps .%s to a provider the CLI registry knows',
    (_name, cliArg) => {
      expect(registry.has(cliArg)).toBe(true)
    },
  )

  it('keeps .all outside the registry, since it is the no-filter sentinel', () => {
    expect(cliArgs['all']).toBe('all')
    expect(registry.has('all')).toBe(false)
  })
})
