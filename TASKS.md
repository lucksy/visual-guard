# Tasks: Visual Guard — Phase 0 (MVP)

> Phase 3 of spec-driven development. Derived from [PLAN.md](./PLAN.md) §1–4.
> Status: **Draft for review** · Last updated: 2026-06-12
>
> Discrete, individually verifiable units. Each touches ≤ ~5 files and has an acceptance
> condition and a verify step. Ordered by the dependency graph; parallel tracks noted.
> Phase 1/2 tasks are generated when we reach them (avoid over-planning).

### Decisions taken to proceed (Q#3 / Q#4 were left open)
- **R1 / Q#3 — normalization default (baked into T5/T7):** pin a single Playwright Chromium
  version · `deviceScaleFactor: 1` · `reducedMotion: "reduce"` · animations/transitions/caret
  disabled · `sharp` grayscale-normalize before diff · `pixelmatch({ includeAA: false })` ·
  `threshold: 0.1`, `maxDiffRatio: 0.01`. Revisit at CP3 if the determinism gate fails.
- **Q#2 — interaction states (resolved in T-06):** a **Storybook story variant name is the
  state** — discovered/listed stories expand **× viewports only** (the story name supplies
  the state); app `routes` expand **× viewports × config `states`** (states realized via
  Playwright actions in `capture.ts`). `RenderTarget.kind` tells capture which mechanism to
  use.
- **Multi-instance namespacing (T-06+):** config supports **multiple** Storybook + app
  targets. Each target carries an optional `name`; otherwise its instance label is derived
  from the URL host:port (`localhost:6006` → `localhost-6006`). Labels are **validated
  unique** across all targets (fail fast on clash). The capture/baseline path is **always
  nested by instance**: `<instance>/<target>/<state>@<viewport>.png`, so two instances
  exposing the same component never collide and adding an instance never relocates an
  existing one's baselines. `RenderTarget` carries `instance`.
- **Q#4 — token source:** defaults to CSS custom properties; only matters in Phase 1
  (`token-auditor`), so deferred.

---

## Track legend
- **T1 (capture):** config → targets → capture
- **T2 (diff):** pure pixel logic — **start day one**, no browser, fully testable
- **T3 (plumbing):** deps + hooks

```
T-01 ─┬─→ T-02 ──────────────┐
      ├─→ T-03 ──────────────┤
      ├─→ T-04 ─→ T-06 ─→ T-07 ─┐
      └─→ T-05 (Track 2) ───────┴─→ T-08 ─→ T-09 ─→ T-10 ─┐
                                                  └─→ T-11 ─┴─→ T-12 (CP5)
```

---

## Foundation

- [x] **T-01 · Tooling scaffold**
  - Acceptance: `npm install` succeeds; `npm run typecheck`, `npm run lint`, `npm run format`
    all run clean on an empty tree; scripts in `package.json` match SPEC "Commands"
    (`test`, `test -- --coverage`, `lint`, `lint:fix`, `format`, `typecheck`); deps pinned
    (`playwright`, `pixelmatch`, `pngjs`, `sharp`, `tsx`, `vitest`, `typescript`, `eslint`,
    `prettier`).
  - Verify: `npm run typecheck && npm run lint`
  - Files: `package.json`, `tsconfig.json`, `.eslintrc.cjs`, `.prettierrc`, `.gitignore`

- [x] **T-02 · Plugin manifest + directory skeleton + default config** → CP1
  - Acceptance: `.claude-plugin/plugin.json` declares `name: visual-guard`, version,
    component paths; component dirs exist (`commands/`, `agents/`, `scripts/lib/`, `config/`,
    `tests/fixtures/` with `.gitkeep`); `config/visual.config.json` matches the SPEC schema;
    `.gitignore` excludes `.visual-guard/` and `node_modules`.
  - Verify: `claude plugin validate . --strict` passes
  - Files: `.claude-plugin/plugin.json`, `config/visual.config.json`, skeleton `.gitkeep`s
  - Depends on: T-01

- [x] **T-03 · Dep bootstrap + SessionStart hook** (Track 3) → CP1
  - Acceptance: `install-deps.mjs` installs engine deps + Chromium into `${CLAUDE_PLUGIN_DATA}`
    using the docs' diff-`package.json` idempotency pattern, with
    `PLAYWRIGHT_BROWSERS_PATH=${CLAUDE_PLUGIN_DATA}/browsers`; a failed install leaves no
    marker so the next session retries; `hooks/hooks.json` registers it on `SessionStart`
    and validates.
  - Verify: run `node scripts/install-deps.mjs` twice (2nd is a no-op); `claude plugin validate .`
  - Files: `scripts/install-deps.mjs`, `hooks/hooks.json`
  - Depends on: T-01

---

## Engine — pure logic (Track 2, parallel)

- [x] **T-05 · `lib/diff.ts` + tests + fixtures** → CP2
  - Acceptance: `diffImages()` returns `{ changedPixels, totalPixels, ratio, dimensionDelta,
    regions }`; identical input → `ratio === 0`; known-delta fixture → expected ratio and
    `dimensionDelta`; mismatched dimensions handled (no throw, delta reported); undecodable
    input **throws**; `sharp` grayscale-normalization applied before `pixelmatch`
    (`includeAA: false`); changed regions clustered into bounding boxes; **≥ 80% coverage on
    `diff.ts`**.
  - Verify: `npm test -- diff --coverage`
  - Files: `scripts/lib/diff.ts`, `tests/diff.test.ts`, `tests/fixtures/*.png`
  - Depends on: T-01 (can start before T-02/T-04)

---

## Engine — capture (Track 1)

- [x] **T-04 · `lib/config.ts` + tests**
  - Acceptance: loads + validates `visual.config.json`; applies defaults; missing/invalid
    fields throw an actionable error naming the field; exported `Config` type matches SPEC.
  - Verify: `npm test -- config`
  - Files: `scripts/lib/config.ts`, `tests/config.test.ts`
  - Depends on: T-02

- [x] **T-06 · `lib/targets.ts` + tests** → R3
  - Acceptance: `detect: auto` discovers Storybook stories via `/index.json` (fallback
    `/stories.json`); expands stories → iframe URLs; app `routes` → URLs × `viewports` ×
    `states`; an explicit story/route list bypasses discovery; Storybook < 7 documented
    unsupported with a clear error. (Q#2 resolution + single-instance assumption recorded
    in "Decisions taken to proceed" above.)
  - Verify: `npm test -- targets` (fetch mocked)
  - Files: `scripts/lib/targets.ts`, `tests/targets.test.ts`
  - Depends on: T-04

- [x] **T-07 · `scripts/capture.ts`** → CP3, R2
  - Acceptance: launches pinned Chromium with R1 settings (deviceScaleFactor 1, reducedMotion,
    animations off via `FREEZE_STYLE` + light colorScheme); captures every target × state ×
    viewport from `targets.ts` into
    `.visual-guard/runs/<id>/current/<instance>/<target>/<state>@<viewport>.png` (instance-nested
    per T-06+); **probes each target origin and fails fast** with a "start your dev server/
    storybook on :PORT" message when unreachable (R2).
  - Verify: `npm test -- capture` (pure helpers + fake-browser orchestration); **CP3 gate
    (opt-in):** `VG_E2E=1 npx vitest run capture.e2e` captures a static page twice → `diffImages`
    ratio **0** ✅ (proven with real Chromium); R2 probe → "could not reach" ✅.
  - Files: `scripts/capture.ts`, `scripts/lib/browser.ts`, `tests/capture.test.ts`,
    `tests/browser.test.ts`, `tests/capture.e2e.test.ts`
  - Depends on: T-06, T-03, T-05 (for the determinism check)
  - Note: browser launch / fetch / fs are dependency-injected so orchestration is unit-testable
    without a browser; the determinism gate is the opt-in integration test (real Chromium).
  - Hardening (from the T-07 adversarial review):
    - **Path traversal:** `instance`/`name`/`state` and the `--run` id become filesystem
      segments and partly come from untrusted Storybook titles/config — all run through
      `sanitizePathSegment` so `../../x` can't escape the run dir (RULES.md). Tested.
    - **R1 freeze-before-load:** `FREEZE_STYLE` is injected via `addInitScript` **before**
      page load (not just after `goto`), plus a settle step awaits `document.fonts.ready` +
      `<img>` loads and resets scroll. CP3 now also gates an **animated** fixture → ratio 0.
    - **Deferred (documented):** JS-animation-library determinism is the component's job
      (must honor `prefers-reduced-motion`); an unbounded render cap is Phase 2 (needs a
      `maxRenders` config field — "ask first").

---

## Engine — diff orchestration + report

- [x] **T-08 · `scripts/compare.ts`** → CP4
  - Acceptance: diffs a run's `current/` against `baselineDir` (keyed by the instance-nested
    `renderRelPath`); writes `diff/<key>.png` per image + per-image results (`compare.json`);
    a render with **no baseline** is reported as `new` (not an error); flags any image above
    `maxDiffRatio` **or with a dimension change** as `fail`.
  - Verify: `npm test -- compare` — real PNG fixtures in a temp dir: unchanged → `pass`,
    altered → `fail`, resized → `fail`, missing baseline → `new`; diff PNGs written. ✅
  - Files: `scripts/compare.ts`, `tests/compare.test.ts`; `lib/diff.ts` extended with a PNG
    `diffImage` in `DiffResult` (so compare can write `diff/<key>.png`).
  - Depends on: T-05, T-07
  - Note: CP4 = T-08 (compare flags altered fixtures) **+** T-09 (manifest golden). `compare.json`
    (the per-image `CompareResult`) is the basis `report.ts` will assemble the manifest from.
  - Hardening (from the T-08 adversarial review):
    - `walkPngFiles` uses `lstat` + skips symlinks → no broken-link crash, no symlink-cycle
      recursion, and keys can't escape the dir; plus an `isSafeKey` guard before any path-join.
    - `current/` is type-checked (a file, not a dir, fails actionably); an undecodable render
      is reported as `status: "error"` (with the message) and the run continues + still writes
      `compare.json` (never a silent abort).
    - Recorded paths are **relative/portable** (`current/<key>`, `diff/<key>`), not absolute.
    - **Deferred (documented):** orphan-baseline detection (a baseline with no current render
      is not reported — compare only walks `current/`); a max-image-size cap (Phase 2 hardening).

- [x] **T-09 · `scripts/report.ts` + golden test** → CP4, R6
  - Acceptance: assembles `manifest.json` = the subagent input contract (per-target: baseline
    / current / diff paths, `ratio`, `dimensionDelta`, `regions`, changed git files, verdict
    placeholder); snapshot/golden-tested so the contract can't drift silently.
  - Verify: `npm test -- report` — pure `buildManifest` field assertions + a committed golden
    snapshot (`tests/__snapshots__/report.test.ts.snap`); git gathering injected for determinism. ✅
  - Files: `scripts/report.ts`, `tests/report.test.ts`
  - Depends on: T-08
  - Decisions made here: per-image results grouped by `<instance>/<target>` into `images[]`;
    target rolls up to its **worst status** (fail > error > new > pass); per-image `verdict`
    placeholder (subagent fills it in Phase 1); run-level `changedFiles` from git filtered by
    `uiGlobs` (minimal in-repo glob matcher, no new dep); per-target `changedFiles` by name
    heuristic; `version: 1` (R6). **CP4 complete** (compare flags altered + manifest golden).
  - Hardening (from the T-09 adversarial review):
    - **Single path anchor:** all `*Path` fields are project-root-relative (current/diff
      rebased onto `runDir`, baseline already root-relative) + a documented `runDir` field —
      so the subagent has one anchor to resolve every path. No mixed/ambiguous anchors.
    - **`verdict: Verdict | null`** (typed to the SPEC reviewer JSON, not the `null` literal)
      so Phase 1 can populate it without a contract break; value stays null in v1.
    - Per-target `changedFiles` uses **whole-token** matching (`Card` ≠ `Dashcard`); grouping
      uses a struct map (no fragile delimiter split).
    - **Deferred to Phase 1 (manifest v2, versioned-contract evolution):** per-image
      `renderTarget` (url/kind/storyId for live re-render) + `currentDimensions` — both need
      capture to persist the `RenderTarget` list. Documented inline in `ManifestImage`.
  - Contract decisions to make here (surfaced by the T-08 review):
    - **Grouping:** `compare.json` is per-image (`<instance>/<target>/<state>@<viewport>`); the
      manifest is per-target, so group by the key's `<instance>/<target>` prefix with an
      `images: [{ state, viewport, ratio, dimensionDelta, regions, diffPath, ... }]` array.
    - **`new`/`error` renders:** decide whether they appear in the reviewer-facing manifest
      (recommend: list `new` separately as audit-only; surface `error` so a corrupt render
      isn't silently dropped). Paths in `compare.json` are already relative/portable.
    - Lock the `manifest.json` shape with the golden test so downstream (T-10/T-11) can't drift.

---

## Commands (skills)

- [x] **T-10 · `/visual-check` command**
  - Acceptance: skill runs the gather→act→verify loop — gather changed UI files via git +
    config, act = `capture.ts` → `compare.ts` → `report.ts`, present the `manifest.json`
    results with pixel numbers **and** a plain-language explanation (Phase 0: the main loop
    explains; the `visual-reviewer` subagent is wired in Phase 1); target arg optional.
  - Verify: `claude plugin validate . --strict` passes ✅; manual `/visual-check Button` on the
    sample project is part of **T-12** (needs the engine-invocation bridge — see note).
  - Files: `commands/visual-check.md`
  - Depends on: T-09
  - Decisions / notes:
    - **No-arg scope:** Phase 0 has no edit-tracking hook (that's Phase 1's `PostToolUse` +
      `pending.json`), so "defaults to pending changes" is realized as **capture all configured
      targets**; the report tags each target with the related changed files, so a regression is
      never skipped by a target-name guess.
    - **Engine-invocation bridge deferred to T-12** (user decision): the bundled `.ts` engine's
      deps live in `${CLAUDE_PLUGIN_DATA}` and `tsx` isn't yet an engine dep, so the documented
      runner isn't runnable until T-12 wires the bridge (add `tsx` to `ENGINE_DEPS` +
      resolve `node_modules`). The command's **preflight stops actionably** until then.
    - Encodes SPEC boundaries: read-only on source, never auto-approve a baseline, evidence
      before verdict, nothing sent to an external service.

- [x] **T-11 · `/visual-baseline` command**
  - Acceptance: copies a run's `current/` renders into `baselineDir` for the named target
    (the sign-off); confirms before overwriting an existing baseline; never runs
    automatically; writes only under `baselineDir`.
  - Verify: `npm test -- baseline` — approve → diff current vs new baseline = ratio 0
    (the sign-off property); skips existing unless `--overwrite`; refuses to write outside
    `baselineDir`. ✅ `claude plugin validate . --strict` passes. The manual
    `/visual-baseline Button → re-run → 0 regressions` runs at **T-12** (needs the engine bridge).
  - Files: `commands/visual-baseline.md`, `scripts/baseline.ts`, `tests/baseline.test.ts`
  - Depends on: T-09
  - Note: the safety-critical copy lives in a **tested** `scripts/baseline.ts` (latest-run
    resolution, target filter, skip-existing-unless-`--overwrite`, **hard guard** against any
    write outside `baselineDir`); the command provides the dry-run preview + explicit
    confirm-before-overwrite gate and is invoked only on the user's explicit `/visual-baseline`.
  - Hardening (from the T-11 safety review — make the guarantee script-enforced, not prose):
    - **`--confirmed` gate:** the script *refuses* to overwrite an existing committed baseline
      unless `--confirmed` is also passed — so the "never overwrite without approval" invariant
      is enforced in tested code even if the script is invoked directly. The command passes it
      only after the user's explicit yes.
    - **Per-file resilience:** a vanished/unreadable source is recorded in `failed[]` instead
      of aborting the sign-off mid-way; the `assertUnder` path guard stays a hard fail.
    - **Live overwrite re-check** (decide on current fs state, not the stale plan) closes the
      plan→apply TOCTOU window; `latestRunId` skips runs without a `current/` dir; `isSafeKey`
      added as defense in depth.

---

## End-to-end

- [ ] **T-12 · CP5 — canonical flow verification**
  - Acceptance: on a bundled sample project, `/visual-check` on unchanged code → 0 regressions;
    make a real change → regression surfaced with file:line; `/visual-baseline` → re-run →
    clean. README documents the flow.
  - Verify: run the CP5 sequence end-to-end; `npm test` green; `claude plugin validate . --strict`
  - Files: `tests/e2e/` sample harness, `README.md`
  - Depends on: T-10, T-11

---

## Suggested execution

Open **T-01** first (gate). Then run **three tracks in parallel**:
- **T-05** (diff.ts, TDD) — the day-one de-risker, no browser needed
- **T-03** (deps/Chromium) — so capture isn't blocked later
- **T-04 → T-06** (config → targets)

They converge at **T-07** (capture + determinism gate), then **T-08 → T-09 → T-10/T-11 →
T-12**. Settle Open Q#3 at CP3 if the determinism gate is noisy.

Phase 1 tasks (visual-reviewer subagent, token-auditor, hooks, `/visual-review` workflow) and
Phase 2 tasks (monitor, coverage map, PR/CI) will be broken out when those phases begin.
