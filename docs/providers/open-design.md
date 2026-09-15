# Open Design

Open Design coding agent. Records an event-stream JSONL log per run, with token usage attached to periodic `usage` events rather than one entry per turn.

- **Source:** `src/providers/open-design.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/open-design.test.ts` (7 tests, fixture-based)

## Where it reads from

| OS | Default path |
|---|---|
| macOS | `~/Library/Application Support/Open Design` |
| Windows | `%APPDATA%/Open Design` |
| Linux | `~/.config/Open Design` |

`$CODEBURN_OPEN_DESIGN_DIR` overrides the default. Discovery accepts several base-directory shapes and normalizes them all down to `<namespace>/data/runs/<runId>/events.jsonl`: a `namespaces` root (`<base>/namespaces/<ns>/data/runs`), a `data` dir, a `runs` dir, or a plain root, tried at both `<base>/data/runs` and `<base>/runs`. Results are deduplicated by resolved path so an ambiguous root does not double-count a run.

## Storage format

JSONL, one event object per line: `{ id, event, data, timestamp }`. A `start` event, or an `agent` event with `data.type === 'status'`, carries the current model in `data.model`. An `agent` event with `data.type === 'usage'` carries `data.usage.{input_tokens, output_tokens, cached_read_tokens, thought_tokens}`.

## Pricing

Recomputed locally via `calculateCost`. `input_tokens` is inclusive of cached reads, so the parser subtracts `cached_read_tokens` before pricing fresh input; `thought_tokens` (reasoning) bills at the output rate and is folded into the output argument passed to `calculateCost`.

## Caching

None at the provider level.

## Deduplication

Per `open-design:<sessionId>:<eventId>`, where `sessionId` is the run's directory name and `eventId` is the event's own `id`, falling back to a per-line counter when the event has none.

## Quirks

- **A usage event needs a model first.** Usage is only recorded once a `start` or status event has set `currentModel`; a `usage` event that arrives before any model is known is dropped rather than attributed to `unknown`.
- **No tool or bash-command tracking.** `tools` and `bashCommands` are always empty; the event stream does not expose per-call tool names today.
- **Only two models have display-name overrides**: `openai-codex:gpt-5.5` maps to `GPT-5.5`, and `glm-5.2` / `GLM-5.2` both map to `GLM-5.2`. Any other model string displays as-is.

## When fixing a bug here

1. Confirm which base-directory shape the install actually uses; `CODEBURN_OPEN_DESIGN_DIR` is the fastest way to point discovery at a specific `data`, `runs`, or `namespaces` root while testing.
2. If costs are `$0`, check whether a `start` or status event ever set the model before the `usage` event arrived for that run.
3. New fixtures go under `tests/fixtures/open-design/` and `tests/providers/open-design.test.ts`.
