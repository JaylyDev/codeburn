// Build/test-only. NOT part of the package's runtime exports or any tsup entry,
// so `zod-to-json-schema` stays a devDependency and never enters `dist`. This
// keeps core's sole RUNTIME dependency `zod`.
import { zodToJsonSchema } from 'zod-to-json-schema'

import { Finding, FINDING_SCHEMA_VERSION } from '../contracts.js'
import { ObservationEnvelope } from '../observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../schema.js'

/** Deterministic, self-contained (fully inlined) JSON Schemas from the zod validators. */
export function buildJsonSchemas(): Record<string, unknown> {
  const opts = { target: 'jsonSchema7', $refStrategy: 'none' } as const
  return {
    [`observation-${OBSERVATION_SCHEMA_VERSION}`]: zodToJsonSchema(ObservationEnvelope, {
      ...opts,
      name: 'ObservationEnvelope',
    }),
    [`finding-${FINDING_SCHEMA_VERSION}`]: zodToJsonSchema(Finding, {
      ...opts,
      name: 'Finding',
    }),
  }
}
