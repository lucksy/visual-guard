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
- **The Figma PAT is the only secret.** Never in `visual.config.json`, the DB, manifests, logs,
  thumbnails, or any committed file. Masked `figd_…<last4>` on every surface.

---

## Sequencing

```
P0 Figma access + token + access-check + config delta   ── connect, never block
        │
P1 Data/DB layer (better-sqlite3, schema, store, reindex) ── the spine everything writes to
        │
   ┌────┴───────────────┐
   ▼                    ▼
P2 Sync (engine fetch   P3 Web-app server + JSON API + image serving
   + workflow orchestr.)      │
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

## Phase 0 — Figma access, secure token, access check, config delta

**Goal.** Establish the only external dependency (Figma REST + PAT) and the security boundary, and
extend config additively — de-risking the two scariest items first (the secret surface and Figma's
quirks: View-seat throttle, expiring image URLs, empty published-components endpoint). No DB, no
rendering yet.

**Deliverables.**
- `scripts/lib/figma/url.ts` (pure): `extractFigmaFileKey`, `looksLikeFigmaKey`, `parseNodeId`
  (URL `123-456` → API `123:456`).
- `scripts/lib/figma/token.ts` (pure + injected fs): resolution precedence
  `flag > VISUAL_GUARD_FIGMA_TOKEN > FIGMA_TOKEN > CLAUDE_PLUGIN_OPTION_FIGMA_TOKEN`; `maskToken`;
  `scrubSecrets` (replaces any `figd_[A-Za-z0-9-]+`); `loadDotenvInto`; `persistToken` (atomic
  temp+rename, `chmod 0600`, merge-preserving).
- `scripts/lib/figma/client.ts` (pure + injected `FetchLike`): `figmaGet(path)` adding
  `X-Figma-Token`; outcome union `ok | auth-error | not-found | rate-limited | network-error`;
  429 retry honoring `Retry-After` (≤3×); base origin overridable via `FIGMA_API_BASE`.
- `scripts/lib/figma/access-check.ts` (pure + injected client): two-stage `GET /v1/me` →
  `GET /v1/files/:key?depth=1`; returns `{ ok, lines[] }`, never throws; four-way disambiguation.
- `scripts/figma.ts` (CLI, owns I/O): `connect --verify` (hidden-input persist), `persist-token`,
  `access-check`. Mirrors ds-bridge `config connect`.
- `parseFigma(raw)` in `scripts/lib/config.ts` + `FigmaConfig` on `Config`
  (`figma?: { fileKey, tokenEnv?, componentMap?, scale? }`); absent → `undefined`.
- `/visual-init` "Design system (Figma)" section + "offer sync" step (`commands/visual-init.md` +
  `scripts/init.ts` write path); `.gitignore` gets an **explicit** `.visual-guard.env` line.

**Depends on.** Nothing (extends existing config/init).

**Testing.** Unit (pure files, carry the coverage): URL/key/node parsing incl. `figma.site` + bad
input; token precedence; **a test asserting a token never appears in any masked/scrubbed output or
thrown error**; atomic `0600` write + merge; client outcome mapping for 401/403/404/429(+Retry-After)
/network via mock `FetchLike`; access-check copy for all four branches. `config.test.ts`: existing
config (no `figma`) round-trips **unchanged**; `figma` requires non-empty `fileKey`. `scripts/figma.ts`
integration test with a mock client (no network). All four gates.

**Exit criteria.** `node scripts/figma.ts access-check` on a real file prints `✓ Token valid` +
`✓ Library readable`; a bad token prints the 401 remediation and persists nothing; a no-`figma`
config loads identically to before; `git check-ignore .visual-guard.env` succeeds; no test/artifact
contains a raw `figd_` token; all gates pass.

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

**Goal.** Populate both snapshot streams fast and idempotently. **Network fan-out lives in the
engine script** (in-process bounded concurrency + `Retry-After` backoff + eager download); the
**dynamic Workflow orchestrates phases with progress and fans out only the LLM work** (ambiguous
matching, conformance classification) — per SPEC §D5. De-risks Figma rate limits + expiring URLs.

**Deliverables.**
- `scripts/lib/studio/enumerate-code.ts` (pure): `groupCodeComponents(RenderTarget[])` reusing
  `targets.ts`.
- `scripts/lib/studio/enumerate-figma.ts` (pure, injected client): parse `/components` +
  `/component_sets`; **tree-scan fallback** for `type===COMPONENT/COMPONENT_SET` when published is empty.
- `scripts/lib/studio/match.ts` (pure): `matchComponents(code, figma, overrides)` — override wins →
  normalized-name → leftovers surfaced `code-only`/`figma-only` (never dropped).
- `scripts/lib/studio/limit.ts` (pure): a small promise-pool concurrency limiter (bounded, testable).
- `scripts/studio/figma-export.ts` (CLI, owns HTTP + token read + DB write): `enumerate | export
  --ids | sync-figma`. Runs the **in-process** bounded fan-out: batch ids ≤ (verified cap), export,
  **eagerly download** the expiring URLs (re-export on a 404'd URL, not just re-download), dedupe-append
  to the DB. Receives the token by **env-var name**, reads `process.env` itself — never a value in argv/log.
- `scripts/studio/sync.ts` (CLI): code capture via `captureAll()` + compare (`current_vs_baseline`)
  + persist; honors `figma.scale` (2), `figma.concurrency` (6).
- `skills/visual-sync/SKILL.md` + `workflow.template.js`: orchestrates phases (preflight → enumerate
  → `figma-export sync-figma` → `sync.ts` code → match → classify → report progress via `log()`),
  fanning out **LLM** subagents for ambiguous matches + conformance classification; supports a
  `$ARGUMENTS` target subset.
- `commands/visual-sync.md`: the `/visual-sync` wrapper with the engine `--check` preflight.

**Depends on.** P0 (token + client + access check), P1 (DB store + image layout).

**Testing.** Unit (pure, coverage): code grouping; figma parse incl. empty-published tree-scan
fallback; matching priority + false-positive guard; the concurrency limiter (ordering, bound, error
isolation). `visual-sync-template.test.ts` (mirrors `visual-review-template.test.ts`): AsyncFunction
syntax check, `meta` via plain `Function`, **assert the template embeds no `figd_` token and passes
only `tokenEnv`**. `figma-export.ts` integration (mock client + temp DB): batched export → eager
download → dedupe append; 429 → backoff; 404 → re-export; **assert no token in the DB or any artifact**.
`sync.ts` integration reusing capture fixtures (or gated `VG_E2E`) to prove a code-only sync populates
the DB end-to-end. All gates.

**Exit criteria.** `/visual-sync` writes both figma + code snapshots, statuses computed, with bounded
concurrency that doesn't trip 429 on a medium library; re-running on an unchanged DS appends **zero**
new history rows (idempotent); a code-only project still populates fully; an expiring/failed image URL
recovers via re-export, not a blank; all gates pass.

---

## Phase 3 — Web-app server + JSON API + image serving

**Goal.** Serve the DB to a browser, localhost-only, token never reaching the page. A tiny
`node:http` server (via bundled `tsx`, **zero new deps**) exposes a read-mostly JSON API and streams
path-validated PNGs. De-risks the "blocking server vs agent turn" and path-traversal concerns before
any UI exists.

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
- `scripts/studio/serve.ts` direct entry (`--no-open`, prints URL) + `/visual-app` command
  (`commands/visual-app.md`) launching the server **backgrounded/detached** so the agent turn completes.

**Depends on.** P1 (DB to read). P2 optional (empty DB → friendly "run /visual-sync" payload).

**Testing.** Unit (pure, coverage): route matching incl. SPA fallback + CSP/MIME; **`..`/absolute/
symlink path-traversal escapes refused** (dedicated test); pidfile staleness. `studio-server.e2e.test.ts`
(integration): boot `serve.ts --no-open` over a seeded temp DB, hit every route, assert JSON shapes +
PNG bytes + `image/png` + the CSP header; assert 127.0.0.1-only and that **no route returns the token**.
All gates.

**Exit criteria.** `serve.ts --no-open` over a seeded DB returns valid JSON for every endpoint and
streams real PNG bytes; a crafted `..` image path is refused; unreachable off 127.0.0.1; `/visual-app`
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
- States: first-run panel (Connect Figma & Sync — **instructs the terminal flow, never captures a
  token**), streaming skeletons, empty-filter, inline non-blocking errors. Full keyboard map, WCAG
  AA, alt text from metadata.

**Depends on.** P3 (the API).

**Testing.** Extract non-trivial pure logic (status→badge, filter/sort, variant union, timeline tick
mapping) into a testable module (`scripts/lib/studio/view-model.ts`) with unit tests (coverage);
keep render code thin. `studio-public.test.ts`: assert `index.html` references only same-origin
assets and CSP forbids off-origin `connect-src`/`script-src` (**no external calls from the page**).
Browser/visual validation via chrome-devtools/Playwright MCP against `serve.ts --no-open` (manual/MCP,
not in the vitest gate). All gates.

**Exit criteria.** `/visual-app` after a sync shows the gallery with figma+code thumbnails + correct
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
- Incremental sync: Figma re-export keyed on node `lastModified` / file `version` (cheap
  `GET /v1/files/:key?depth=1`); code re-render keyed on Storybook story-set hash + `uiGlobs` mtime
  (reuse `detect-ui-change.mjs`'s `pending.json`); content-hash dedupe is the backstop. `figma-pending`
  resumable state for partial syncs.
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
| **PAT leak** | **P0** | one `maskToken`/`scrubSecrets`, opt-in `0600` `.visual-guard.env`, explicit `.gitignore` line + `git check-ignore`, "token never in artifacts" test (P0 + P2). |
| **`better-sqlite3` native build** | **P1** | reuse the proven `sharp` bootstrap; Node-20 prebuilds; existing "remove marker, retry next session" fallback. |
| **Figma rate limits / expiring URLs** | **P2** | bounded **in-process** concurrency + `Retry-After` backoff; eager download; **re-export** on a 404'd URL. |
| **View-seat throttle** | **P0** | two-stage access check before the fan-out. |
| **Design-vs-code diff noise** | **P1 schema** + **P5 tolerant** | conformance is a separate, advisory `axis`; tolerant dimension+palette; never the pixel gate; CI provably ignores it. |
| **Web-app bundling** | **P4** | prebuilt, committed, zero-build vanilla ES-module SPA; no bundler/UI kit. |
| **Blocking server hangs the turn** | **P3** | `/visual-app` runs the server backgrounded/detached; pidfile reopens instead of double-starting. |
| **Path traversal** | **P3** | `images.ts` hard-refuses paths outside `.visual-baselines/`/`.visual-guard/`; escape test. |
| **`parseConfig` backward-compat** | **P0** | additive `parseFigma`; explicit "no-`figma` config round-trips unchanged" test. |
| **Matching false positives** | **P2** | override > normalized > surfaced; never fuzzy; user-overridable in the UI. |
| **Unbounded DB/cache growth** | **P5** | retention + `studio prune` + content-addressed dedupe; DB rebuildable via `reindex`. |

---

## A note on "dynamic workflows" (important)

The original brief asked for "dynamic workflows to speed up accessing Figma pages." The honest
engineering reality (SPEC §D5): the plugin's **Workflow tool orchestrates LLM subagents and can't do
filesystem/raw-HTTP work itself**. So the **fast parallel network fetch is an in-process concurrency
limiter inside `scripts/studio/figma-export.ts`** (this is what actually makes it fast and is the
correct tool), while the **dynamic Workflow** still earns its place — it orchestrates the sync phases
with live progress and fans out the genuinely LLM-shaped work (resolving ambiguous Figma↔code matches,
classifying conformance drift). This split is faster, correct for the runtime, and keeps the
token out of any subagent argument.
