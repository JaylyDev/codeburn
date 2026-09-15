# Codebuff

Codebuff (formerly Manicode) CLI coding agent. Codebuff bills in credits rather than a flat per-token rate, so the parser prices from tokens when they are present and falls back to a credit-based estimate otherwise.

- **Source:** `src/providers/codebuff.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/codebuff.test.ts` (22 tests, fixture-based)

## Where it reads from

Codebuff's chat history lives on disk under its legacy product name, plus separate dev/staging channels:

| Channel | Path |
|---|---|
| Stable | `~/.config/manicode` |
| Dev | `~/.config/manicode-dev` |
| Staging | `~/.config/manicode-staging` |

`$CODEBUFF_DATA_DIR` overrides all three with a single root. Each channel root is walked as `<root>/projects/<project>/chats/<chatId>/chat-messages.json`, with a sibling `run-state.json` used to resolve the session's real working directory (the chat folder name itself is often the same across unrelated projects).

## Storage format

A JSON array of chat messages in `chat-messages.json`. Each message has a `variant` (`user`, `ai`, `agent`, or `assistant`), optional `credits`, optional tool-call `blocks` (including nested sub-agent blocks), and `metadata` that may carry usage directly or bury it inside `runState.sessionState.mainAgentState.messageHistory`.

## Pricing

The parser tries `calculateCost` on the message's token usage first. If that resolves to `0` and the message reports non-zero `credits`, it falls back to `credits * $0.01`, Codebuff's public pay-as-you-go rate, so subscription users still see a conservative cost estimate instead of `$0`.

## Caching

None at the provider level.

## Deduplication

Per `codebuff:<chatDir>:<messageId>`, falling back to the message's array index when it has no `id`.

## Quirks

- **Session ids are channel-qualified.** Chat folder names are ISO timestamps, so the same folder name can legitimately exist under `manicode`, `manicode-dev`, and `manicode-staging`. The parser prefixes the session id with the channel it came from (derived from the on-disk path), joined with `/` rather than `:` because `src/parser.ts` splits its aggregation key on colons.
- **Usage can be stashed, not direct.** Some messages carry `metadata.usage` (or `metadata.codebuff.usage`) directly; others only record usage on the last assistant entry inside `metadata.runState.sessionState.mainAgentState.messageHistory`. The parser checks the direct field first and falls back to the stashed history, including for the model name.
- **Zero-signal messages are skipped.** A message with no credits and no tokens (mode dividers, empty framing blocks) is dropped before it reaches dedup.
- **Tool names are collected recursively.** Blocks of type `agent` nest their own `blocks`, so sub-agent tool calls roll up into the parent message's tool list.

## When fixing a bug here

1. Confirm which channel the session came from; `CODEBUFF_DATA_DIR` overrides all three channels at once, which is a common source of "wrong project" reports.
2. If costs look off, check whether the message had real token usage priced via `calculateCost`, or fell back to the credit-based rate.
3. New fixtures go in `tests/providers/codebuff.test.ts`; it builds `chat-messages.json` fixtures inline rather than from files under `tests/fixtures/`.
