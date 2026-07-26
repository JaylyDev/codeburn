// Runs under block-io-register.mjs. argv[2..] are absolute paths to every
// exports-map dist target (computed by the parent test from package.json, since
// this child cannot read files). It imports each one, then calls a trivial
// fingerprint + schema parse via the barrel. Any I/O import inside core makes
// one of these dynamic imports throw, failing the guardrail.
import { pathToFileURL } from 'node:url'

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('import-smoke: no dist targets provided')
  process.exit(2)
}

const loaded = {}
for (const abs of targets) {
  const mod = await import(pathToFileURL(abs).href)
  loaded[abs] = mod
}

// The barrel is the first target by convention; find whichever export set has
// the functions we need (index re-exports everything).
const barrel = Object.values(loaded).find(
  (m) => typeof m.sessionRef === 'function' && typeof m.parseObservationEnvelope === 'function',
)
if (!barrel) {
  console.error('import-smoke: barrel exports not found across targets')
  process.exit(3)
}

// Trivial fingerprint (pure crypto, no I/O).
const ref = barrel.sessionRef('smoke-key', 'claude', 'session-123')
if (!/^[0-9a-f]{16}$/.test(ref)) {
  console.error(`import-smoke: unexpected fingerprint ${ref}`)
  process.exit(4)
}

// Trivial schema parse.
const env = barrel.parseObservationEnvelope({
  schemaVersion: '0.1.0',
  generator: { name: '@codeburn/core', version: '0.0.0-smoke' },
  sessions: [],
})
if (env.schemaVersion !== '0.1.0') {
  console.error('import-smoke: parse returned unexpected envelope')
  process.exit(5)
}

console.log('IMPORT_SMOKE_OK')
