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

  // The superseded 0.1.0 observation schema is kept as a FROZEN historical
  // artifact: it is no longer emitted from the current zod (which is 0.2.0), so
  // it has no fresh counterpart. Assert it stays pinned at its own version so a
  // careless re-emit can never overwrite it with 0.2.0 content.
  it('observation-0.1.0.json remains frozen at schemaVersion 0.1.0', () => {
    const onDisk = JSON.parse(readFileSync(resolve(schemasDir, 'observation-0.1.0.json'), 'utf8'))
    const root = onDisk?.definitions?.ObservationEnvelope ?? onDisk
    expect(root?.properties?.schemaVersion?.const).toBe('0.1.0')
    expect(Object.keys(fresh)).not.toContain('observation-0.1.0')
  })
})
