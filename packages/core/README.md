# @codeburn/core

The pure decode/detect engine behind [CodeBurn](https://github.com/getagentseal/codeburn):
provider session-log decoding for 36 AI coding tools, content-minimized observation
envelopes, and detector contracts.

**Status: 0.x.** The engine is complete and battle-tested (it is the same code the
CodeBurn CLI runs, proven byte-identical to the pre-extraction implementation on a
frozen real-world corpus), but the public API may still change between 0.x minor
versions. Pin accordingly.

## What it does

- **Decode**: each provider module (`@codeburn/core/providers/<name>`) turns that
  tool's raw session records into structured call data — tokens, models, timing,
  tool usage — with the provider's exact dedup and skip semantics.
- **Observations**: `toObservations` maps rich decode output into a strict,
  content-minimized envelope: only fingerprints, enums, numbers, timestamps,
  dedup keys, and canonical tool names cross the boundary. Enforced by an
  architecture gate and per-provider content-smuggling tests.
- **Detectors**: contracts for waste/optimization findings over fingerprinted data.

## What it deliberately does NOT do

No file or network I/O, no environment access, no clock reads, no pricing.
Hosts (the CodeBurn CLI, apps, or your own tooling) supply the records and apply
their own pricing. The only runtime dependency is `zod`.

## Usage

```ts
import { decodeQwen } from '@codeburn/core/providers/qwen'
import { toObservations } from '@codeburn/core/providers/qwen'
import { OBSERVATION_SCHEMA_VERSION } from '@codeburn/core/schema'

const { calls, diagnostics } = decodeQwen({ records, seenKeys })
```

Each provider is its own subpath export; see `package.json#exports` for the full
list. JSON Schemas for the observation envelope ship under `schemas/`.

Part of the CodeBurn core extraction ([RFC #796](https://github.com/getagentseal/codeburn/issues/796),
tracking [#809](https://github.com/getagentseal/codeburn/issues/809)). MIT.
