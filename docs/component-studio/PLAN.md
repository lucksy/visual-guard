# Component Studio — Implementation PLAN

> Companion to [`SPEC.md`](./SPEC.md). Phased, MVP-first, dependency-respecting. Each phase ships
> something usable on its own. Extends the existing Visual Guard engine — not a rewrite.

---

## Non-negotiable integration rules (verified against the repo)

- **Pure logic lives in `scripts/lib/**`** — the only thing under the **≥80% vitest coverage gate**
  (`vitest.config.ts`: `include: ["scripts/lib/**/*.ts"]`). CLI scripts under `scripts/` do I/O and
  are exercised by integration/e2e tests (mirroring `capture.ts` / `compare.ts` / `init.ts`).
- **New bare-import runtime deps go into `ENGINE_DEPS`** in `scripts/install-deps.mjs` (kept in
  lockstep with `package.json` `dependencies`) so the bridge-symlink + `--check` consent gate keeps
  working. Engine floor is **Node ≥ 20**.
- **`parseConfig` extension is additive + defaulting** (mirror `parseTokens`): an absent `figma`
  key = today's code-only behavior, byte-for-byte.
- **Workflow scripts** ship as `skills/<name>/workflow.template.js` (top-level await + return;
  globals `phase/agent/parallel/pipeline/log`), launched by a SKILL via the Workflow tool (a plugin
  can't pre-save a workflow). They get a dedicated syntax/`meta` contract test (see
  `tests/visual-review-template.test.ts`). **The Workflow runtime orchestrates LLM subagents and
  cannot touch the filesystem** — raw parallel HTTP does **not** belong in it (see SPEC §D5).
- **Gates per phase:** `npm test` (vitest + ≥80% lib coverage), `npm run typecheck`, `npm run lint`,
  `claude plugin validate . --strict`. **Do NOT** run `prettier --write .` (repo isn't
  prettier-clean) — hand-wrap long lines.
- **No Figma secret.** Figma is read via the **Figma MCP** (`mcp__figma-desktop`) — there is no PAT
  or token anywhere. Studio stores only images + non-secret metadata (node ids, names, variant
  defs); nothing sensitive in config/DB/logs. (A REST/PAT provider, with its token-security rules, is
  a future option only.)

---

## Sequencing

```
P0 Figma config (multi-file) + MCP availability check    ── no token, never block
        │
P1 Data/DB layer (better-sqlite3, schema, store, reindex) ── the spine everything writes to
        │
   ┌────┴───────────────┐
   ▼                    ▼
P2 Sync (code=engine,   P3 Web-app server + JSON API + image serving
   figma=MCP workflow)        │
        │                     ▼
        └───────────► P4 Web-app UI (gallery + detail + timeline + variants)
                                │
                                ▼
                      P5 Polish (pruning, incremental, conformance tuning, CI guardrail)
```

Value per phase: **P0** = honest "can we reach Figma?"; **P1** = a queryable, rebuildable index of
existing code baselines (value with zero Figma); **P2** = both streams populated fast; **P3** =
the data over an API (scriptable/headless studio); **P4** = the interactive product; **P5** =
hardened for active design systems.

---

## Phase 0 — Figma config + MCP availability (no token)

**Goal.** Add the additive `figma` config (multi-file) and a clean "is the Figma MCP available?"
check, and grow `/visual-init` to collect the file key(s) — **no token, no secret surface, no REST
client.** De-risks the cheap-but-fundamental questions early: that the MCP (`get_metadata` /
`get_screenshot`) can address component nodes by id in the open file and return what Studio needs.

**Deliverables.**
- `scripts/lib/figma/url.ts` (pure): `extractFigmaFileKey`, `looksLikeFigmaKey`, `parseNodeId`
  (URL `123-456` → API `123:456`) — for normalizing a pasted Figma URL into the stored `key`.
- `parseFigma(raw)` in `scripts/lib/config.ts` + `FigmaConfig` on `Config`
  (`figma?: { files: { key, label? }[]; componentMap?: Record<string,string> }`; a bare `fileKey`
  string normalizes to a one-element `files`); absent → `undefined`. **No `tokenEnv`.**
- `/visual-init` "Design system (Figma)" section (paste file URL(s) → key(s)+label(s); a
  **Figma-MCP availability check**; auto-map confirm/edit/add; offer to run the first sync) in
  `commands/visual-init.md` + the `scripts/init.ts` write path. **No `.gitignore`/token changes.**
- An MCP-availability helper the commands use: probe that `mcp__figma-desktop` is present and a file
  is open (a cheap `get_metadata`); if not, an actionable "open your Figma file & re-run" message.

**Depends on.** Nothing (extends existing config/init).

**Testing.** Unit (pure files, carry the coverage): URL/key/node parsing incl. `figma.site` + bad
input; `parseFigma` validates `files[]` (each needs a non-empty `key`), normalizes a bare `fileKey`,
and returns `undefined` when absent. `config.test.ts`: an existing config (no `figma`) round-trips
**byte-identical**; a `figma.files` block validates; an empty/invalid `files` entry is rejected with a
named error. (No token/secret tests — there is no token.) All four gates.

**Exit criteria.** An existing `visual.config.json` with no `figma` block loads identically to before;
`/visual-init` accepts a pasted Figma URL and writes `figma.files: [{ key, label }]`; the
availability check cleanly reports "MCP ready" vs "open Figma & re-run"; all gates pass.

> **Note vs. the old plan:** choosing the Figma MCP deletes the entire former Phase-0 token-security
> workstream (`token.ts`, `client.ts`, `access-check.ts`, `scripts/figma.ts`, `.visual-guard.env`,
> masking/scrubbing, the `figd_`-never-leaks tests). That code only returns if a REST provider is
> ever added for CI parity.

---

## Phase 1 — Data / DB layer (local SQLite index)

**Goal.** Stand up the storage spine: a single-file `better-sqlite3` DB at `.visual-guard/studio.db`
(gitignored, rebuildable), the full schema, a tested pure store, and a `reindex` that rebuilds the DB
from committed PNG baselines — proving "the DB is a cache; PNGs + git are the source of truth."
De-risks the native build early by reusing the exact `sharp` bootstrap path.

**Deliverables.**
- `better-sqlite3` added to `ENGINE_DEPS` (+ `package.json` deps), installed via `install-deps.mjs`
  (the mechanism that already ships native `sharp`). *Decision: `better-sqlite3` over `node:sqlite`
  because the floor is Node 20.*
- `scripts/lib/studio/schema.sql` + `db.ts`: `openDb()` (WAL, `foreign_keys=ON`, `user_version`
  migration counter), `migrate()`. Tables per SPEC §7 (`components`, `variants`, `component_usages`,
  `snapshots`, `regressions`).
- `scripts/lib/studio/store.ts` (pure, injected DB handle): `upsertComponent`, `appendSnapshot`
  (assigns `version_seq` in `BEGIN IMMEDIATE`; dedupes by latest-in-lane hash), `recordComparison`,
  `recomputeStatus`, and the read queries (list, timeline, latest-per-axis, variants).
- `scripts/lib/studio/keys.ts` (pure): `components.key` slug derivation; reuse the engine's
  `renderRelPath` / path-sanitizers for code snapshot keys.
- Image layout per SPEC §7 (code under `.visual-baselines/`, Figma under `.visual-baselines/.figma/`
  + committed `figma_meta.json`, transient blobs content-addressed under `.visual-guard/cache/blobs/`).
- `scripts/studio.ts` CLI: `reindex` (walk `baselineDir` + `figma_meta.json` → rebuild), `status`
  (integrity: DB rows vs baseline files).

**Depends on.** P0 (for the Figma image paths; not required for code-only reindex).

**Testing.** Unit (pure, coverage): `appendSnapshot` version_seq monotonicity + dedupe + UNIQUE-race
retry; `recomputeStatus` over the engine status map; every read query against seeded rows; `migrate`
0→1. `studio-reindex.test.ts` (integration, temp dir): seed a `.visual-baselines/` tree + `figma_meta.json`,
`reindex`, assert full reconstruction; delete the DB, reindex → identical. `install-deps.test.ts`:
`ENGINE_DEPS` includes `better-sqlite3` and `desiredManifest()` still matches `computeInstallState`;
run the gated e2e once to confirm a real bridged install resolves the native module. All gates.

**Exit criteria.** `node scripts/studio.ts reindex` on a repo with existing `.visual-baselines/`
produces a `studio.db` whose list query returns one row per code component with `status`; deleting +
re-running yields identical rows; the timeline query returns snapshots newest-first; **no Figma
needed for this phase to deliver value**; all gates pass with ≥80% lib coverage.

---

## Phase 2 — Capture / Sync (dual Figma + code population)

**Goal.** Populate both snapshot streams idempotently. **Code capture is the engine** (headless,
reuses `capture.ts`). **Figma capture is the `/visual-sync` dynamic Workflow fanning out subagents
that call the Figma MCP** (`get_metadata` to enumerate, `get_screenshot` per node) — agent-driven,
because MCP tools are agent-only. No token, no rate limit, no expiring URLs — per SPEC §D1/§D5.

**Deliverables.**
- `scripts/lib/studio/enumerate-code.ts` (pure): `groupCodeComponents(RenderTarget[])` reusing
  `targets.ts`.
- `scripts/lib/studio/figma-nodes.ts` (pure): parse a `get_metadata` payload into
  `FigmaComponent[]` (a `COMPONENT_SET` = a component, its child `COMPONENT`s = variants) — pure so
  it's unit-tested against fixtures without the live MCP.
- `scripts/lib/studio/match.ts` (pure): `matchComponents(code, figma, overrides)` — override wins →
  normalized-name → leftovers surfaced `code-only`/`figma-only` (never dropped).
- `scripts/studio/sync.ts` (CLI, engine, headless): **code** capture via `captureAll()` + compare
  (`current_vs_baseline`) + persist to the DB. No Figma here (the engine can't call the MCP).
- `scripts/studio/record-figma.ts` (CLI): given a captured Figma node screenshot (bytes/path) +
  metadata, dedupe-append a `source='figma'` snapshot to the DB. The **agent** (in the workflow)
  calls the MCP and hands bytes/metadata to this recorder — the token-free analogue of the old
  export script.
- `skills/visual-sync/SKILL.md` + `workflow.template.js`: the dynamic Workflow — preflight (engine
  `--check` + **Figma-MCP availability**) → `get_metadata` enumerate → fan out subagents that
  `get_screenshot` batches of nodes and call `record-figma.ts` → run `sync.ts` for code → match →
  classify conformance → `log()` progress; supports a `$ARGUMENTS` file/target subset and writes rows
  **progressively** (code first, Figma streams in).
- `commands/visual-sync.md`: the `/visual-sync` wrapper (engine `--check` + MCP availability preflight).

**Depends on.** P0 (config + MCP availability), P1 (DB store + image layout).

**Testing.** Unit (pure, coverage): code grouping; `figma-nodes.ts` parsing a `get_metadata` fixture
(component-set → component+variants); matching priority + false-positive guard. `record-figma.ts`
integration (temp DB): dedupe-append a Figma snapshot, second identical bytes add no row.
`visual-sync-template.test.ts` (mirrors `visual-review-template.test.ts`): AsyncFunction syntax check +
`meta` via plain `Function`. `sync.ts` integration reusing capture fixtures (or gated `VG_E2E`) to
prove a **code-only** sync populates the DB end-to-end (no MCP needed for the code path). All gates.

**Exit criteria.** `/visual-sync` populates code snapshots headlessly and Figma snapshots when the
desktop app is open (via the MCP workflow), statuses computed; re-running on an unchanged DS appends
**zero** new history rows (content-hash idempotent); a code-only project (no Figma at all) populates
fully; if Figma is closed, code still syncs and Figma components stay `figma-pending`; all gates pass.

---

## Phase 3 — Web-app server + JSON API + image serving

**Goal.** Serve the DB to a browser, localhost-only; the page makes zero external calls (there's no
token anywhere). A tiny `node:http` server (via bundled `tsx`, **zero new deps**) exposes a
read-mostly JSON API and streams path-validated PNGs. `POST /api/sync` re-runs the **code** capture
(engine); the Figma capture stays in `/visual-sync` (agent+MCP). De-risks the "blocking server vs
agent turn" and path-traversal concerns before any UI exists.

**Deliverables.**
- `scripts/studio/server.ts` + pure `scripts/studio/lib/`:
  - `router.ts` (pure): `/api/*` matching + static routing + CSP/MIME + SPA fallback.
  - `images.ts` (pure): `snapshotId → DB key → resolve vs project root → **hard-refuse any path
    outside `.visual-baselines/` or `.visual-guard/`** (mirror `baseline.ts`; reject `..` post-normalize).
  - `pidfile.ts` (pure): single-instance guard (alive-PID detection, stale overwrite).
  - `open.ts`: cross-platform browser open (no dep).
- `server.listen(0, "127.0.0.1")` (loopback, OS port); write `.visual-guard/studio.pid`;
  SIGINT/SIGTERM → close server + DB + remove pidfile.
- Read-mostly API: `/api/health`, `/api/components` (`?status=&q=`), `/api/components/:id`,
  `/api/components/:id/history?source=`, `/api/components/:id/variants`, `/api/snapshots/:id`,
  `/api/snapshots/:id/image` (PNG stream, `ETag`/immutable), `POST /api/sync`. Error
  `{ error: { code, message } }`. CSP per SPEC §10.
- `scripts/studio/serve.ts` direct entry (`--no-open`, prints URL) + `/visual-studio` command
  (`commands/visual-studio.md`) launching the server **backgrounded/detached** so the agent turn completes.

**Depends on.** P1 (DB to read). P2 optional (empty DB → friendly "run /visual-sync" payload).

**Testing.** Unit (pure, coverage): route matching incl. SPA fallback + CSP/MIME; **`..`/absolute/
symlink path-traversal escapes refused** (dedicated test); pidfile staleness. `studio-server.e2e.test.ts`
(integration): boot `serve.ts --no-open` over a seeded temp DB, hit every route, assert JSON shapes +
PNG bytes + `image/png` + the CSP header; assert 127.0.0.1-only and that the CSP forbids off-origin calls.
All gates.

**Exit criteria.** `serve.ts --no-open` over a seeded DB returns valid JSON for every endpoint and
streams real PNG bytes; a crafted `..` image path is refused; unreachable off 127.0.0.1; `/visual-studio`
returns control to the agent (no hung turn); all gates pass.

---

## Phase 4 — Web-app UI (gallery + detail + timeline + variants)

**Goal.** The product: a prebuilt, zero-build, committed SPA from `scripts/studio/public/` giving an
at-a-glance Figma-vs-code parity view. Delivers value as cards stream in during sync.

**Deliverables.**
- `scripts/studio/public/`: `index.html`, `app.js` (native ES modules + client router), split
  modules, `tokens.css` + `app.css`. No bundler, no framework (vanilla; Preact only as a documented
  maintainer-side prebuilt-bundle upgrade).
- Token set per SPEC §11.4 (neutral ramp + indigo accent + 6 status colors, system font, 4px scale,
  light+dark via `[data-theme]`, `prefers-color-scheme`/`prefers-reduced-motion`, responsive
  `auto-fill minmax()` 1→4 cols).
- Gallery: `ComponentCard` (dual thumbnail, dot+word status), filter chips with live counts +
  **hero Figma-only/Code-only metrics**, urgency-first sort, density toggle, Sync button with
  streaming card updates + live progress, URL-reflected filters, per-card freshness.
- Detail: `Timeline` (ARIA slider, current pinned right, arrow/`Shift`-changed stepping, hover
  provenance), `CompareViewer` (`F/C/S/O/D`; **Overlay default for Figma-vs-code**; Diff labeled as
  *code regression vs previous code*), `VariantTabs` (union + origin chips), side panel
  (description / used-in / related / variants-parity), "Open in Figma" + "Open the story" deep links.
- States: first-run panel ("Open your Figma file & run `/visual-sync`" — **no token to enter**),
  streaming skeletons, empty-filter, inline non-blocking errors (Figma desktop closed / MCP
  unavailable → code halves still render). Full keyboard map, WCAG AA, alt text from metadata.

**Depends on.** P3 (the API).

**Testing.** Extract non-trivial pure logic (status→badge, filter/sort, variant union, timeline tick
mapping) into a testable module (`scripts/lib/studio/view-model.ts`) with unit tests (coverage);
keep render code thin. `studio-public.test.ts`: assert `index.html` references only same-origin
assets and CSP forbids off-origin `connect-src`/`script-src` (**no external calls from the page**).
Browser/visual validation via chrome-devtools/Playwright MCP against `serve.ts --no-open` (manual/MCP,
not in the vitest gate). All gates.

**Exit criteria.** `/visual-studio` after a sync shows the gallery with figma+code thumbnails + correct
badges; a component page shows the timeline, comparison toggles, and variants with parity gaps; cards
stream in during a running sync; the app works **fully offline** (no external calls — verified in the
network panel); keyboard-only + dark mode both work; all gates pass.

---

## Phase 5 — Polish (pruning, incremental sync, conformance tuning, CI guardrail)

**Goal.** Harden for real, active design systems: bound disk/DB growth, make re-sync cheap, make the
conformance signal trustworthy, and lock the CI story — without ever turning the noisy cross-source
comparison into a gate.

**Deliverables.**
- History/disk bounding: `config.studio.{ retainPerSource (20), retainCurrent (3), pruneOrphanBlobs }`;
  `studio prune` (idempotent, runs at sync tail) — delete out-of-window non-approved snapshot rows,
  cascade `regressions`, sweep unreferenced `cache/blobs`, `VACUUM` past a freed-page threshold.
  **Committed baseline PNGs are never auto-deleted.**
- Incremental sync: code re-render keyed on Storybook story-set hash + `uiGlobs` mtime (reuse
  `detect-ui-change.mjs`'s `pending.json`); Figma re-capture skips unchanged nodes when
  `get_metadata` exposes a `lastModified`, with **content-hash dedupe** as the correctness backstop.
  `figma-pending` resumable state for partial syncs (e.g. Figma desktop closed mid-run).
- Conformance tuning: `scripts/lib/studio/conformance.ts` (pure) — tolerant dimension delta (reuse
  `diff.ts` `dimensionDelta`) + coarse palette/dominant-color distance (`sharp` downscale + `culori`)
  → `{ dimensionDelta, paletteDelta, level: aligned|minor|divergent }`. Advisory; the
  `regressions.axis = figma_vs_code` row is informational only.
- CI guardrail: document + **enforce** that `/visual-ci` consumes only `current_vs_baseline` — a test
  asserts a `figma_vs_code` `divergent` row cannot flip the CI exit code.

**Depends on.** P2 (sync), P1 (schema), P4 (the signal users see).

**Testing.** Unit (pure, coverage): prune keeps approved-within-window + cascades + leaves committed
baselines; incremental skip logic (unchanged vs changed `version`/mtimes); conformance level thresholds
on fixture pairs. `ci.test.ts`: a `figma_vs_code` `divergent` row does **not** change the `/visual-ci`
exit code. Re-run gated `VG_E2E` to confirm no regression in the shared diff path. All gates.

**Exit criteria.** A second `/visual-sync` on an unchanged DS re-fetches nothing and writes no history;
prune bounds DB/cache to the retention window without touching committed baselines; conformance renders
as advisory levels (not pass/fail); `/visual-ci` provably ignores conformance; all gates pass.

---

## Riskiest items & where they're de-risked

| Risk | De-risk phase | Mitigation |
|---|---|---|
| **Figma MCP unavailable (desktop app closed)** | **P0/P2** | availability check before sync → actionable "open Figma & re-run"; un-captured components stay `figma-pending` and resume. |
| **Figma sync interactive-only (no CI/headless)** | **—** | documented; code regression still runs headless/CI; REST is the future path for CI parity. |
| **Bulk MCP capture token-cost/slow on big libraries** | **P2/P5** | bounded subagent fan-out + content-hash incremental; code-first ordering so value shows immediately. |
| **`better-sqlite3` native build** | **P1** | reuse the proven `sharp` bootstrap; Node-20 prebuilds; existing "remove marker, retry next session" fallback. |
| **Design-vs-code diff noise** | **P1 schema** + **P5 tolerant** | conformance is a separate, advisory `axis`; tolerant dimension+palette; never the pixel gate; CI provably ignores it. |
| **Web-app bundling** | **P4** | prebuilt, committed, zero-build vanilla ES-module SPA; no bundler/UI kit. |
| **Blocking server hangs the turn** | **P3** | `/visual-studio` runs the server backgrounded/detached; pidfile reopens instead of double-starting. |
| **Path traversal** | **P3** | `images.ts` hard-refuses paths outside `.visual-baselines/`/`.visual-guard/`; escape test. |
| **`parseConfig` backward-compat** | **P0** | additive `parseFigma`; explicit "no-`figma` config round-trips unchanged" test. |
| **Matching false positives** | **P2** | override > normalized > surfaced; never fuzzy; user-overridable in the UI. |
| **Unbounded DB/cache growth** | **P5** | retention + `studio prune` + content-addressed dedupe; DB rebuildable via `reindex`. |

---

## A note on "dynamic workflows" (important)

The original brief asked for "dynamic workflows to speed up accessing Figma pages." Choosing the
**Figma MCP** makes that instinct exactly right. MCP tools are **agent-callable only** (a plain
`tsx` script can't invoke them), and the Workflow runtime is built to **orchestrate subagents** — so
the fast, correct way to capture a whole library is the `/visual-sync` dynamic Workflow fanning out
subagents that each `get_screenshot` a batch of component nodes via the MCP, recording snapshots
through the engine. Code capture stays in the headless engine (`capture.ts`). No token, no rate
limit, no HTTP-in-a-workflow awkwardness — the workflow does what it's good at (parallel subagents),
and the engine does what it's good at (headless rendering + the DB).
