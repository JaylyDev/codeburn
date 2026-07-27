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

  // Superseded schemas are kept as FROZEN historical artifacts: they are no
  // longer emitted from the current zod, so they have no fresh counterpart.
  // Assert each stays pinned at its own version so a careless re-emit can never
  // overwrite it with current content — a consumer validating against a
  // published version must keep getting the shape that version promised.
  const FROZEN: [file: string, version: string, definition: string][] = [
    ['observation-0.1.0', '0.1.0', 'ObservationEnvelope'],
    ['observation-0.2.0', '0.2.0', 'ObservationEnvelope'],
  ]

  for (const [file, version, definition] of FROZEN) {
    it(`${file}.json remains frozen at schemaVersion ${version}`, () => {
      const onDisk = JSON.parse(readFileSync(resolve(schemasDir, `${file}.json`), 'utf8'))
      const root = onDisk?.definitions?.[definition] ?? onDisk
      expect(root?.properties?.schemaVersion?.const).toBe(version)
      expect(Object.keys(fresh)).not.toContain(file)
    })
  }

  // The finding schema carries no schemaVersion field of its own, so freeze it
  // by shape instead: 0.1.0 must keep the 64-bit refs it shipped with, and must
  // no longer be emitted.
  it('finding-0.1.0.json remains frozen with 16-hex refs', () => {
    const onDisk = JSON.parse(readFileSync(resolve(schemasDir, 'finding-0.1.0.json'), 'utf8'))
    const root = onDisk?.definitions?.Finding ?? onDisk
    expect(root?.properties?.evidence?.items?.properties?.refs?.items?.pattern).toBe('^[0-9a-f]{16}$')
    expect(Object.keys(fresh)).not.toContain('finding-0.1.0')
  })
})
