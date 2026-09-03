# CodeBurn Teams: Handoff

Date: 2026-09-01
Purpose: give a brand-new Claude session everything needed to pick up the CodeBurn Teams effort with zero prior context. Written from memory notes, the local codeburn repo, and GitHub (`getagentseal/codeburn-teams`).

---

## 1. What CodeBurn Teams is

CodeBurn Teams is a design-partner pilot product built on top of the public CodeBurn CLI: "your team's AI usage, connected to work." A developer runs the CLI and pushes a usage receipt; a receiver (`codeburn-api`) validates and stores typed, allowlisted records; a hosted Next.js dashboard (`codeburn-teams` repo) renders team-level views with evidence labels on every number.

**Privacy spine (hard product constraint, not a preference):**
- Push-only. The CLI never accepts a server pull or an admin-forced pull.
- No prompts, code, diffs, paths, or shell commands ever leave a machine.
- No ranking or productivity scores of individuals, ever: this is explicitly prohibited in the product spec (PRODUCT.md) and repeated in the README's product rules.
- Every metric carries an epistemic badge: observed, estimated, inferred, or not measured.
- Disclosure-first: the developer sees the exact payload before anything sends.
- CLI tokens are write-only; dashboard tokens are read-only.
- Auto-sync (where it exists) is consent-once, admin-cadence, produces a receipt per run, and has a kill switch: never silent, never server-initiated.

Any feature work must be checked against this spine before being built.

---

## 2. Repo and surface map

There are two distinct things both called "Teams": do not conflate them.

### A. The pilot/enterprise product: separate repo
- GitHub: `getagentseal/codeburn-teams` ("Private product, desktop, API, web, and evidence workspace for CodeBurn Teams"), default branch `main`.
- Local clone: `~/Projects/codeburn/codeburn-teams`.
- Stack: Next.js dashboard + an env-gated receiver living in `codeburn-api` (SQLite `teams.db`) + the `codeburn sync` push mechanism in the public CLI (issue #625 / PR #660 machinery).
- Governing docs in that repo: `SPEC.md` (v0.2), `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/COMPATIBILITY.md`, `docs/specs/`, `docs/archive/` (historical, superseded by SPEC.md).
- Production deployment (as of 2026-08-24, per memory): `https://teams.codeburn.app` (pm2 `codeburn-teams-web`) + receiver at `api.codeburn.app/o/eywa-pilot` (pm2 `codeburn-api`), both on VPS `185.197.251.164`. Cognito pool `eu-central-1_fUlxWUiUy` (domain `codeburn-teams`) gates auth. This is stated in memory, not re-verified for this document: treat as needing a live check before relying on it.
- `getagentseal/codeburn-app` and `getagentseal/codeburn-api` repos exist on GitHub but currently have **no description set**: could not determine their exact scope from GitHub metadata alone. `getagentseal/codeburn-enterprise` does not appear queryable the same way; a related repo `codeburn-enterprise` description found separately reads: "CodeBurn Enterprise: private backend + dashboard (team analytics over the codeburn sync OTEL export). Open-core: paid tier of the public codeburn CLI." How this relates to `codeburn-teams` (same effort renamed, or a separate/older track) is **not established by the sources gathered**: flag this to the user rather than assuming.

### B. The desktop demo: lives inside the main `codeburn` repo, currently uncommitted-then-parked
- Repo: this repo, `/Users/torukmakto/Projects/codeburn/codeburn`.
- This is a **dummy, localStorage-only** mockup of a Teams experience inside the CodeBurn Electron desktop app: built to let the user visually review a design direction. It has no real backend, no real auth, no connection to the pilot product in section A.
- **Where the work actually is right now (verified 2026-09-01):**
  - The working tree is currently checked out on **`main`**, and `git status --short` is clean except for an untracked `.gstack/` directory. It is NOT sitting uncommitted on `feat/plugin-marketplace` anymore.
  - `feat/plugin-marketplace` (local branch) has 5 commits of real desktop-demo work already committed on it, ending at `a0a7d6c0`.
  - On top of that, a further batch of work (the newest UI files, `BRIEF-FIX1.md`, `BRIEF-FIX2.md`, and other loose changes) was swept into one commit, `f1d67015 "park: Teams desktop demo WIP from feat/plugin-marketplace (local only, not for merge)"`, on branch **`park/teams-demo-2026-08-31`**. That park branch is local-only; nothing here has been pushed or merged.
  - A sibling park branch, `park/dock-session-bubble-2026-08-31` (commit `0bb4b497`), holds an unrelated Capacity Dock hover-bubble project that was also parked the same day. Don't confuse the two.
- **Files that make up the demo** (all only present on `feat/plugin-marketplace` / `park/teams-demo-2026-08-31`, not on `main`):
  - `app/renderer/sections/Plugins.tsx` + `.module.css`: Grok-style plugin marketplace (Marketplace/Yours tabs, search, category-grouped cards, detail view). CodeBurn Teams is the only real plugin shown; no fake filler plugins (the user was upset when filler was invented earlier: don't repeat that).
  - `app/renderer/sections/TeamsAuthModal.tsx` + `.module.css`: onboarding wizard. Left brand panel always visible, right side steps. Chooser (Create/Join) → Create: subscribe (seat stepper $8/seat, or redeem trial code `JOIN-`/`CODEBURN-`) → account (Create/Sign-in tabs) → workspace → invite (seat-capped). Join: invite code → sign-in-or-create with email locked.
  - `app/renderer/sections/TeamsManagement.tsx` + `.module.css`: the Team dashboard. Verified current structure (2026-09-01): a role toggle (Member/Admin, `demoStore.setRole`), a Mine/Team scope toggle when applicable, four tabs (`overview`, `spend`, `quality`, `members`), and a three-way view: member sees only their own contribution; seated admin gets a Mine/Team toggle; unseated admin sees Team only. Members tab has admin-only invite controls. Copy explicitly states "Per-person spend is never shown or ranked, by design": the privacy spine enforced in the UI copy itself.
  - `app/renderer/sections/teamviews/TeamDashboardA.tsx` / `TeamDashboardB.tsx` (+ `.module.css` each): the actual KPI panels: spend + projected, one-shot rate, retry tax, routing waste, daily sparkline, by-model/tool/project bars, task-type table, coverage + tokens.
  - `app/renderer/lib/demo-store.ts`: all fake state, localStorage key `codeburn-demo-teams`. Verified (2026-09-01): `DEMO_CREDENTIALS` contains exactly `admin@codeburn.app` / `demo1234` (role admin) and `member@codeburn.app` / `demo1234` (role member). `signIn(email, password)` auto-provisions the workspace on a credential match; any other email plus a non-empty password creates a throwaway account. Reset state with `localStorage.removeItem('codeburn-demo-teams')`.
  - `app/renderer/App.tsx`, `app/renderer/components/Sidebar.tsx`, `app/renderer/bootstrap.tsx`, `app/renderer/main.tsx`: wiring: Plugins is pinned to the bottom of the sidebar; a "Team" nav item appears once the Teams plugin is installed and navigates to the team view after onboarding.
  - `app/renderer/assets/teams-mark.png`: the user's own aqua-flanked binary-flame Teams logo.
  - `app/renderer/sections/AdminUsageView.test.tsx`: a test file added with this work; not otherwise investigated here.
- **Data model is not invented**: dashboard numbers are shaped to mirror the real sync payload: `src/sync/otlp.ts` spans (cost, tokens, model, provider, tools, project, subscription_covered, work_unit_id) plus `src/plugins/exporter.ts` turn enrichment (category, retries, hasEdits, oneShot). `demoStore.getUsageStats('team'|'mine')` returns that shape with fake numbers.

### Exact commands to run the demo (browser loop, no DMG build needed)
This only works from a checkout that has the demo files: i.e. `feat/plugin-marketplace` or `park/teams-demo-2026-08-31`, not `main` as it stands today.

```bash
cd app
npm run dev:web
```
- This runs two things concurrently: `node demo-bridge.mjs` (serves the Electron renderer's bridge over HTTP on `:4900`, reading real `codeburn serve` data, read-only) and Vite on `:5173`.
- `app/renderer/main.tsx` does a two-step bootstrap: in browser-dev mode it loads `renderer/public/demo-shim.js` then `./bootstrap.tsx`. The real Electron build and prod builds are unaffected by this shim.
- Open `http://127.0.0.1:5173` in a browser. Plugins is pinned at the bottom of the sidebar; install the Teams plugin from there to trigger onboarding.
- Sign in with `admin@codeburn.app` / `demo1234` or `member@codeburn.app` / `demo1234` to see the two role views, or use any other email + non-blank password for a fresh throwaway workspace.
- `dev:web` and `demo-bridge.mjs` only exist in `app/package.json` on the branches carrying the demo work: confirmed absent from `main`'s current `app/package.json`.

---

## 3. Current state

**Done (pilot/enterprise repo, `getagentseal/codeburn-teams`):**
- Repo reshaped to "production format" 2026-08-24 (PR #1): the README's feature-roadmap table became the tracking source of truth.
- 19 PRs merged in that repo as of this writing (2026-08-24 through 2026-08-28), covering: dashboard origin config, Node 24.19 ObjectWrap pin, read-path perf rewrite, pagination/caching, the Main-vs-Teams boundary spec, CT-3a Usage-page fixes, work-unit ingest/view (CT-1/CT-2/CT-3b), Real ROI spec + Stage 1 cards, My Week card + `/me/week` endpoint, plugin distribution endpoints, the CLI-2 turn-metrics plugin exporter, and a turn-metrics ingest timestamp fix. Only one issue is open in that repo: **#3**, "Architecture: CodeBurn plugin socket: one public extension point, Teams as the first signed plugin."
- Public `codeburn` repo side: lineage fields (`ai.work_unit_id`, `session_role`, `lineage_evidence`, cache tokens, `call_count`, `session_duration_ms`, `subscription_covered`, `codeburn.coverage_through`) shipped in 0.9.21/0.9.22; resolver + `sessions --by-work-unit` shipped in 0.9.22.
- Wave of 2026-08-28 ("teams 15/16" and beyond): the plugin-socket/signing/consent-scheduler stack (#1151→#1154→#1158) merged to public `codeburn` main; the matching teams-side PRs (#15 My Week, #16 `/me/week`, #17 plugin-dist, #18 CLI-2 exporter, #19 ingest fix) merged to the teams repo. Full store loop was proven live end to end: local receiver + mock IdP served a signed `teams.tgz`; public CLI did remote plugin add → OIDC refresh → sha256 → ed25519 verify → load, with all 7 declared sync attributes present and no dev flag needed. VPS deploy of the receiver + dashboard was verified live (endpoint checks returned expected 401/200s) on 2026-08-28.
- Aditya P1 review items (see "Open threads" below) were implemented and verified against tests on 2026-08-28, but **not yet merged to public main**: see the BRIEF-FIX findings below.

**Done (desktop demo, in this repo):**
- Onboarding wizard, member vs admin dashboards, tabbed Teams management (Overview/Spend/Quality/Members), Plugins page redesigned as an inline marketplace, seat/invite admin controls, demo credentials and localStorage persistence: all committed to `feat/plugin-marketplace` (5 commits through `a0a7d6c0`) and further work parked in one commit `f1d67015` on `park/teams-demo-2026-08-31`.
- A CSS polish pass (8px rhythm, 4-size type scale, hairline cards, focus rings, reduced-motion) was done and tsc-verified per the desktop-demo memory note, dated 2026-08-30.

**Uncommitted / parked, precisely:**
- Nothing is currently uncommitted in the working tree (`git status --short` on `main` shows only an untracked `.gstack/` directory, unrelated to Teams).
- The demo work that this document's originating task described as "deliberately uncommitted on `feat/plugin-marketplace`" has since been swept into the single park commit `f1d67015` on `park/teams-demo-2026-08-31`. **This is a discrepancy worth flagging explicitly**: whoever briefs the next session should not assume `feat/plugin-marketplace`'s working tree still has loose uncommitted changes: check `git status` and `git log <branch> -3` fresh rather than trusting older notes (including this one) at face value.
- Per the user's own rule recorded 2026-08-30: "nothing gets committed, everything stays local" for this arc of work: the park commit satisfies "stays local" (it is a local, unpushed branch) but does represent a commit. Confirm with the user whether parking-as-a-commit is acceptable under that rule, or whether they want it reset to a working-tree diff instead.

---

## 4. Decisions already made

- **Product model (desktop demo + presumably the real product):** aggregate-only, no per-person ranking ("Model A"). A seat is a tracked member; the buyer/admin is not auto-seated and their own usage stays free/local. Trial access is via single-use codes, no card required. Expiry pauses and preserves data rather than deleting. Multiple admins are allowed. Price point used in the mockup: $8/seat/month.
- **Trust model for plugins:** first-party plugins only, documented in `loader.ts` (public commit `638d29d9`), no sandbox: a deliberate scope-narrowing decision, not an oversight.
- **Wire contract:** additive privacy-safe lineage fields (hashed parent/root only) were approved for the public sync contract; this explicitly does **not** reopen the earlier ruling that richer enterprise panels (CLI-2 turn metrics, CLI-3 outcomes) stay out of the public `codeburn` repo: those live only in the private teams world, distributed via the signed plugin mechanism.
- **Org data policy:** admins control collection scope via org-policy checkboxes (usage always-on; git attribution and work-categories optional), pushed automatically to member CLIs. Members see the policy in every disclosure but do not individually toggle scope. This was rationalized as necessary for an EU/works-council posture while keeping the transparency and no-ranking invariants intact.
- **"Not confirmed covered" wording:** when subscription coverage can't be confirmed, the wire stays true-or-absent (no "billed on top" inference), and the UI label was deliberately changed to "Not confirmed covered."
- **ROI badge:** strict: only shown as "observed" when spend is 100% classified, not at a lower threshold, per a founder call recorded in the wave-2026-08-28 notes.
- **Signing key custody:** the plugin release signing key was moved to the user's login Keychain (service `codeburn-plugin-signing-key`, account `release-499923ae`) rather than staying in `/tmp`.
- **Boundary spec:** Aditya's Main-vs-Teams boundary spec (`docs/specs/CODEBURN-MAIN-TEAMS-BOUNDARY-v0.1.md`) is approved: local truth + egress enforcement stays in public CodeBurn (allowlist always defined in public host code: nothing private can widen it); org identity, aggregation, and policy live in Teams.

---

## 5. Open threads / next steps

**Rollout gates awaiting the user's explicit go (per memory, not independently re-verified live):**
- Cognito/AWS provisioning and domain setup for additional pilot orgs.
- First real partner enrollment.
- A "watched real-laptop push": an actual monitored pilot run on a real developer's machine: named repeatedly across memory notes as the next concrete gate before wider rollout.
- npm/brew release of the public CLI carrying the plugin-socket code, so `npm install -g codeburn@latest` actually gets the plugin-socket support the pilot depends on.
- Aditya's re-push of two-member pilot data once the above is live.

**What BRIEF-FIX1.md / BRIEF-FIX2.md actually ask for, and their real status (important correction to make in the next session):**
These two files sat untracked in the repo root and got pulled into the `park/teams-demo-2026-08-31` commit alongside the unrelated desktop-demo files: they are **not** about the Teams desktop demo UI at all. They are task briefs for the "Aditya P1 review" fixes:
- `BRIEF-FIX1.md`: P1 review items #1 and #3: make the Teams plugin exporter pure (no ledger writes on a normal/dry-run pass), commit ledger keys only after the host confirms a push was accepted, and unify manual `sync push` with scheduled `sync auto run` so both enrich identically. Target: public repo branch `fix/aditya-p1-review` plus a matching teams-repo branch `fix/aditya-p1-review-teams`.
- `BRIEF-FIX2.md`: P1 review item #2: kill the "session-as-turn" placeholder in `src/plugins/exporter.ts`'s `buildTurnContextMap`, and thread real per-turn context (from the existing parser/classifier) through to the exporter instead of fabricating one pseudo-turn per session.
- **Verified 2026-09-01:** the corresponding commits already exist: `62dcca5b "fix(plugins): pure exporter with commit-after-acceptance; unify manual and scheduled enrichment (Aditya P1 #1,#3)"` and `8ea30c31 "fix(plugins): thread real per-turn context to the exporter; drop session-as-turn placeholder (Aditya P1 #2)"`: both on local branch `fix/aditya-p1-review`. Neither commit is merged into `main` (`git merge-base --is-ancestor` confirms both are absent from `main`). This matches the 2026-08-28 wave memory's "STILL PENDING user calls: ... whether to push the 5 fix branches + PR now."
- **So: the work these briefs describe is done, tested, and sitting locally: the only remaining action is the user's decision to push `fix/aditya-p1-review` (and its teams-repo counterpart) and open PRs.** The BRIEF files themselves are now stale artifacts; they do not represent open work, only a record of what was asked and (per memory) already delivered. The next session should confirm this with the user before deleting or acting on them further, since this document's own verification is a git-log check, not a re-run of the acceptance tests described in the briefs.

**Unfinished roadmap rows from the `codeburn-teams` README (fetched 2026-09-01):**
| # | Feature | Status in README |
|---|---------|----|
| 1 | My Week (private per-dev card) | 🔴 P1 |
| 2 | Personal plan check | 🔴 P1 |
| 3 | Auto-sync (consent-once, admin cadence, receipt per run, kill switch) | 🔴 P1 |
| 5 | Seat right-sizing (identity-free quota utilization) | 🔴 P1 |
| 7 | Team playbook (aggregated waste patterns, no names) | 🟡 P2 |
| 8 | Model-mix advisor | 🟡 P2 |
| 11 | One-page monthly brief (CFO surface) | 🟡 P2 |
| 12 | Org budget + burn alerts | 🟢 P3 |
| 14 | Personal waste nudges | 🟢 P3 |
| 15 | Fleet benchmarks (opt-in anonymous) | ⚪ Later |
| 16 | Plugin socket: Teams as a signed plugin | 🟡 P2 |
| 17 | Real ROI: cost per ticket, role splits, owner instruments | 🔴 P1 |

**Contradiction to flag:** rows 1 ("My Week"), 16 ("Plugin socket"), and 17 ("Real ROI") are marked not-done in the README, but the merged-PR list for this same repo shows PR #15/#16 ("My Week" + `/me/week` endpoint), PR #17/#18/#19 (plugin distribution + CLI-2 exporter + ingest fix), and PR #14 ("ROI Stage 1 cards") all **merged** between 2026-08-25 and 2026-08-28. Since the README table is the designated tracker, it appears to be out of date relative to what has actually shipped. The next session should not treat the README table as ground truth without cross-checking merged PRs, and should consider updating the table's statuses (this document's task explicitly said "update README table statuses as features ship" is the intended workflow).

**CT-4 desktop policy flow**: noted in the 2026-08-28 wave memory as "deliberately NOT built: needs user/Aditya coordination." Still open as of this document.

**Team-tab section producer (P2)**: per the Aditya P1 review notes, a decision is still pending on whether to build a real fetcher for an empty "Team" tab section or defer it; the tab is currently empty until this is decided.

**CT-5 "watched week"** and the CB-4/CT-4 auto-sync consent step are listed in the approved work sequence (CB-0 → CT-0 → §2.4 lineage baseline → CT-3a → CB-1/2/3 → CT-1/2/3b → CB-4/CT-4 → CT-5) but this document did not verify how far down that sequence actual work has progressed beyond what's captured above: the next session should ask the user for a status check rather than assume.

**Desktop demo:** the last recorded status (2026-08-30) was "functional build complete + Apple-grade CSS polish pass done; awaiting user visual acceptance, then iterate on their notes." No record in the gathered sources confirms that visual acceptance happened. Next step is almost certainly to ask the user whether they reviewed it and what they want changed, then resume from `park/teams-demo-2026-08-31` (or `feat/plugin-marketplace`, since the park commit sits directly on top of it).

---

## 6. House rules for the next session

- **The user names all merges.** Never self-merge an agent-produced PR; wait for the user to explicitly say to merge, then it's `gh pr merge --merge --admin`. Force-push and `git reset --hard`/similar destructive git ops are blocked by policy: the user must run those themselves if truly needed.
- **No AI attribution anywhere in this repo's git history or PRs**: no `Co-Authored-By: Claude` trailers in commits, no Claude Code footers in PR bodies. This repo's CI (`check`) enforces the no-attribution rule: always scan a builder's commits for stray trailers before pushing.
- **No em-dashes in UI copy** (or, per this document's own instructions, anywhere in this handoff: applied throughout).
- **Reply to the user in plain, non-technical language with examples**: this is the user's standing first rule for chat replies, independent of how technical the underlying work is.
- **Teams desktop demo work stays uncommitted/local until the user says otherwise.** The park commit on `park/teams-demo-2026-08-31` is a local-only branch, not pushed: treat it the same as uncommitted work: no push, no PR, no merge without a fresh explicit instruction.
- **CLI-app contract:** any CLI change must be handled together with its desktop-app contract impact: payload/field changes are add-only, a flag change ships CLI and app together, `dist/` gets rebuilt, and CLI/app versions bump together. This applies to any sync/plugin-wire work touched while continuing the Teams effort.
- **Model routing for delegated work:** per the user's global directive, the orchestrating session should delegate execution (not do it directly): small tasks to a lightweight model, standard tasks to Sonnet, hard/architecture work to Opus or another strong implementer: and always verify a delegate's result before reporting it done. Builders have previously misreported passing tests; always re-run the full relevant test suite yourself before trusting a "done" claim on this project.

---

## Sources consulted for this document

- Memory: `codeburn-teams.md`, `codeburn-teams-desktop-demo.md`, `codeburn-wave-2026-08-28.md`, `codeburn-dock-session-bubble.md`, and `MEMORY.md`'s index (2026-09-01).
- Local repo `/Users/torukmakto/Projects/codeburn/codeburn`: `git status --short`, `git log --oneline`, branch listing, `git show` against `park/teams-demo-2026-08-31` and `feat/plugin-marketplace` (read-only, no checkout performed), `BRIEF-FIX1.md`/`BRIEF-FIX2.md` (read from the park branch, since they don't exist on `main`), `TeamsManagement.tsx`, `demo-store.ts`, `app/package.json`.
- GitHub: `getagentseal/codeburn-teams` full README, `gh issue list --state all`, `gh pr list --state all`, plus `gh repo view` for `codeburn-app`, `codeburn-api`, and a separately-found `codeburn-enterprise` description.

No git state in the working repo was modified while producing this document (no checkout, no add, no commit, no stash). Current branch remains `main`, `git status --short` unchanged (only the pre-existing untracked `.gstack/`).
