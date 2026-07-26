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
})
