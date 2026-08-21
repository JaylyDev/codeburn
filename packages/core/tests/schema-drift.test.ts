import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildJsonSchemas } from '../src/internal/json-schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const schemasDir = resolve(here, '..', 'schemas')

/**
 * DRIFT GUARD. The checked-in JSON Schemas must equal a fresh emission from the
 * zod validators. If a validator changes and `npm run emit-schemas` was not
 * re-run, this fails — so the artifact can never silently diverge from source.
 */
describe('JSON Schema drift', () => {
  const fresh = buildJsonSchemas()

  for (const name of Object.keys(fresh)) {
    it(`${name}.json matches a fresh emission`, () => {
      const onDisk = JSON.parse(readFileSync(resolve(schemasDir, `${name}.json`), 'utf8'))
      expect(onDisk).toEqual(fresh[name])
    })
  }

  // Superseded observation schemas remain FROZEN historical artifacts. They
  // are no longer emitted from the current zod, so a careless re-emit must not
  // overwrite a versioned contract that external archives still reference.
  for (const version of ['0.1.0', '0.2.0']) {
    it(`observation-${version}.json remains frozen at schemaVersion ${version}`, () => {
      const name = `observation-${version}`
      const onDisk = JSON.parse(readFileSync(resolve(schemasDir, `${name}.json`), 'utf8'))
      const root = onDisk?.definitions?.ObservationEnvelope ?? onDisk
      expect(root?.properties?.schemaVersion?.const).toBe(version)
      expect(Object.keys(fresh)).not.toContain(name)
    })
  }

  it('keeps the 0.2.0 model fields at their published minLength-only contract', () => {
    const onDisk = JSON.parse(readFileSync(resolve(schemasDir, 'observation-0.2.0.json'), 'utf8'))
    const call = onDisk.definitions.ObservationEnvelope.properties.sessions.items
      .properties.calls.items.properties
    expect(call.model).toEqual({ type: 'string', minLength: 1 })
    expect(call.pricingModel).toEqual({ type: 'string', minLength: 1 })
  })
})
