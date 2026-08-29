# CodeBurn performance baselines

Pinned from current main before the first product change. An iteration without a before/after number from this harness does not exist.

- SHA: `93b7b9a7da02ee77c80ac54264b87358121c5cf7`
- Branch: `perf/harness-phase0`
- Date: 2026-08-29
- Machine: Mac15,14, arm64, v22.22.3, sha 93b7b9a7
- Node: v22.22.3
- CLI: tsx src/cli.ts
- Summary: gitignored `perf/results/harness-2026-08-29T18-12-01-675Z/summary.json` (period-switch first-7D/30D from a follow-up run after the load-then-switch fix)
- Historical Desktop 7D (installed 0.9.21, live corpus, 2026-08-27): 18286.98 ms useful summary. Target: 250 ms p95 ready summary. That receipt is *not* this fixture.

These rows are wait-path measurements through isolated HOME + CLI/serve. They are not installed Desktop/Menu Bar UI proof.

| metric | fixture | command | machine | number | notes |
|---|---|---|---|---|---|
| session-parse cold (ms p50/p95) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) | node scripts/perf/run-metric.mjs --metric session-parse --home <HOME> | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 1768.0 / 1791.0 | MB/s p50=15.091 fixture_bytes=27977201 |
| incremental-reparse (ms) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) then append 2 JSONL lines | node scripts/perf/run-metric.mjs --metric incremental-reparse --home <HOME> | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 463.0 | same inode append; everyday path |
| period-switch first 7D after load (ms) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) via serve --stdio | node scripts/perf/run-metric.mjs --metric period-switch --home <HOME> | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 120.9 | index-ready first 7D; analogue of 18s receipt; wait-path |
| period-switch first 30D after load (ms) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) via serve --stdio | same | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 166.3 | index-ready first 30D; wait-path |
| period-switch 7D warm (ms p50/p95) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) via serve --stdio | node scripts/perf/run-metric.mjs --metric period-switch --home <HOME> | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 0.4 / 0.6 | wait-path; installed UI target remains 250ms p95 |
| period-switch 30D warm (ms p50/p95) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) via serve --stdio | node scripts/perf/run-metric.mjs --metric period-switch --home <HOME> | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 0.3 / 0.5 | wait-path |
| serve ready (ms) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) | same | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 399.3 | {ready:true} frame |
| cold-start desktop wait-path (ms p50/p95) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) | node scripts/perf/run-metric.mjs --metric cold-start-cli --home <HOME> | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 1651.4 / 1729.5 | status menubar-json --period today --no-timeline; UI NOT VERIFIED |
| cold-start menubar wait-path (ms p50/p95) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) | same | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 1510.4 / 1526.0 | status menubar-json --provider all --period today --no-optimize; UI NOT VERIFIED |
| refresh proxy (ms p95) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) | node scripts/perf/run-metric.mjs --metric dock-tui-proxy --home <HOME> | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 211.4 | hover is native dock; this is payload reuse |
| view-switch proxy (ms p95) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) | same | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 121.3 | period week request; sidebar paint NOT VERIFIED |
| memory RSS after cold load (bytes) | scripts/perf/gen-fixture.mjs --target-mb 30 (isolated HOME) | node scripts/perf/run-metric.mjs --metric memory --home <HOME> | Mac15,14, arm64, v22.22.3, sha 93b7b9a7 | 366460928 | 1h idle not run in this invocation. Pass --idle-ms 3600000 for the leak check. |

## Reproduction

See [perf/README.md](./README.md) — same two commands, then compare against this table.
