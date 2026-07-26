// Emits the checked-in JSON Schemas from the zod validators. Run via
// `npm run emit-schemas -w @codeburn/core` (uses tsx). The drift test asserts
// the checked-in files equal a fresh emission, so re-run this after any schema
// change.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildJsonSchemas } from '../src/internal/json-schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'schemas')
mkdirSync(outDir, { recursive: true })

for (const [name, schema] of Object.entries(buildJsonSchemas())) {
  const file = join(outDir, `${name}.json`)
  writeFileSync(file, JSON.stringify(schema, null, 2) + '\n')
  console.log(`wrote ${file}`)
}
