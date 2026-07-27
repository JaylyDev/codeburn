# @codeburn/core

The pure decode/detect engine behind [CodeBurn](https://github.com/getagentseal/codeburn):
provider session-log decoding, content-minimized observation envelopes, and detector
contracts.

It ships 34 provider modules. Rather than trusting that number, ask the package:

```ts
import { supportedProviders } from '@codeburn/core/providers/registry'

supportedProviders() // [{ id: 'claude', exportPath: './providers/claude', ... }, ...]
```

The registry and `package.json#exports` are checked against each other in CI, so the
list cannot drift from what is actually importable.

## What it does

- **Decode**: each provider module (`@codeburn/core/providers/<name>`) turns that
  tool's raw session records into structured call data — tokens, models, timing,
  tool usage — with the provider's exact dedup and skip semantics. Output is
  rich and host-side: it holds paths, messages, and tool arguments.
- **Observations**: `toObservations` maps that rich decode into a strict,
  content-minimized envelope. Only fingerprints, enums, numbers, timestamps, and
  capped canonical labels cross the boundary. Enforced by an architecture gate
  and per-provider content-smuggling tests.
- **Detectors**: contracts for waste/optimization findings over fingerprinted data.

## What it deliberately does NOT do

No file or network I/O, no environment access, no clock reads, no pricing.
Hosts (the CodeBurn CLI, apps, or your own tooling) supply the records and apply
their own pricing. The only runtime dependency is `zod`.

## Usage

Decoding is two stages. Stage 1 is provider-specific and rich; stage 2 minimizes.

```ts
import { decodeQwen, toObservations } from '@codeburn/core/providers/qwen'
import type { DecodeContext } from '@codeburn/core/contracts'

// The privacy key is yours to generate and persist — core never invents one.
// Every fingerprint is scoped to it, so refs are comparable only within one key.
const context: DecodeContext = {
  privacyKey: myHostKey,
  providerId: 'qwen',
  sourceRef: myOpaqueSourceRef,
}

const { calls, diagnostics } = decodeQwen({ records, context })

const { sessions } = toObservations(
  { sessionId, projectPath, calls },
  { privacyKey: myHostKey, provider: 'qwen' },
)
```

`context` is required — omitting it is a type error. JSON Schemas for every
shipped envelope version live under `schemas/`.

## Versioning

Four things version independently. Do not infer one from another.

| What | Where | Notes |
|---|---|---|
| Package version | `package.json` | npm semver |
| Observation schema | `OBSERVATION_SCHEMA_VERSION` | currently `0.3.0` |
| Finding schema | `FINDING_SCHEMA_VERSION` | currently `0.2.0` |
| Detector algorithm | `algorithmVersion` on each finding | per detector |

**All four are 0.x, and a 0.x MINOR bump may break you.** That is not the usual
semver reading, so pin exact versions and read the changelog before upgrading.

Superseded schema files stay in `schemas/` unchanged so a consumer validating
against a published version keeps getting the shape that version promised.

### Breaking changes in observation schema 0.3.0

- Every fingerprint widened from 16 to 32 hex characters (64 → 128 bits).
- The raw per-call `dedupKey` became `callRef`, a fingerprint. Provider dedup
  keys embedded session, message, and record ids; they no longer ship. Compare
  `callRef` values to de-duplicate — the mapping is stable per privacy key.
- Envelopes now carry `fingerprints: { algorithm, keyId }`. Refs are comparable
  only across envelopes sharing a `keyId`; joining across key ids fabricates
  sessions. The key id is derived from the key one-way and is not the key.
- `provider`, `providerId`, `model`, and `pricingModel` are now length- and
  charset-capped. A non-canonical label degrades to `'unknown'` rather than
  invalidating the whole envelope.

Finding schema 0.2.0 carries the same widened refs; its shape is otherwise 0.1.0.

## A note on what this package can and cannot prove

Core normalizes records and produces evidence. It cannot prove all usage was
observed — an application developer can remove, bypass, or forge in-process
instrumentation. Treat detector estimates as estimates, not as metered spend or
realized savings. Authoritative usage accounting needs a controlled gateway or a
provider billing feed, neither of which lives here.

Part of the CodeBurn core extraction ([RFC #796](https://github.com/getagentseal/codeburn/issues/796),
tracking [#809](https://github.com/getagentseal/codeburn/issues/809)). MIT.
