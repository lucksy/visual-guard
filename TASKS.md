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
- **Q#4 — token source (RESOLVED 2026-06-13):** the token system is **multi-format, type-aware,
  adapter-based**, not CSS-only. Built-in **static** adapters: CSS custom properties · DTCG
  (Design Tokens Format Module) · Style Dictionary (v3 + v4) · Tailwind v4 `@theme` · Tokens
  Studio · SCSS/Less. **JS-eval** adapters (Tailwind v3 `tailwind.config.{js,ts}`, JS/TS theme
  objects) are supported behind an explicit opt-in `tokens.allowJsEval` and run in a **child
  process** (they execute project code). New deps approved (were "ask first"): `postcss`,
  `postcss-scss`, `postcss-less`, `culori`; `typescript` (already present) drives JSX/Tailwind-
  class scanning. Drift scan covers CSS/SCSS values, JSX inline styles, **and Tailwind utility
  classes** (incl. arbitrary values `p-[8px]`). **Deferred** to a later task: user-supplied
  **custom-adapter modules** and config-declared **custom token types** (the `custom:<name>`
  type still lives in the model so unknown `$type`s are preserved). See P1-B (T-16a–T-16e).

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
    - **Engine-invocation bridge — resolved in T-12:** `tsx` is now in `ENGINE_DEPS` and
      `install-deps.mjs` symlinks `${CLAUDE_PLUGIN_ROOT}/node_modules` → the data-dir deps, so
      the command's documented runner (`${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx`) resolves
      and the engine scripts resolve their bare imports. The preflight check now passes once the
      `SessionStart` bootstrap completes.
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

- [x] **T-12 · CP5 — canonical flow verification**
  - Acceptance: on a bundled sample project, `/visual-check` on unchanged code → 0 regressions;
    make a real change → regression surfaced with file:line; `/visual-baseline` → re-run →
    clean. README documents the flow.
  - Verify: run the CP5 sequence end-to-end; `npm test` green; `claude plugin validate . --strict` ✅
  - Files: `tests/e2e/sample/` (sample project), `tests/e2e/canonical-flow.e2e.test.ts`,
    `tests/install-deps.test.ts`, `README.md`; `scripts/install-deps.mjs` (engine bridge).
  - Depends on: T-10, T-11
  - Decisions / what landed:
    - **Engine-invocation bridge** (the T-10/T-11 deferral): `install-deps.mjs` now adds `tsx`
      to `ENGINE_DEPS` and, after the deps land in `${CLAUDE_PLUGIN_DATA}`, symlinks
      `${CLAUDE_PLUGIN_ROOT}/node_modules` → the data-dir `node_modules` so the commands'
      `${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx` runner resolves **and** the engine scripts
      resolve their bare ESM imports. Empirically proven: `NODE_PATH` does **not** apply to ESM
      bare specifiers (so the symlink — a `node_modules` adjacent to `scripts/` — is the only
      mechanism that works); a real dev `node_modules` is left untouched; a broken link is
      repaired. The script is now import-safe (guarded `main()`) so the bridge is unit-tested.
    - **CP5 proven via the real engine, not just the commands' prose:** the gated
      `canonical-flow.e2e.test.ts` (real Chromium, `VG_E2E=1`) copies the bundled sample into a
      temp git repo, serves it, and drives `captureAll → compareRun → report → runBaseline`
      through the full lifecycle: no-baseline → `new`; approve → unchanged re-run → **0
      regressions**; a deliberate spacing-token → hardcoded-padding change → **`fail`** tied to
      `src/Button.css` (via the manifest's git-derived `changedFiles`); approve → re-run → clean.
    - **Sample regression is a spacing/geometry change, not a recolor** — the engine
      grayscale/luminance-normalizes before `pixelmatch` (cross-machine AA/subpixel noise
      suppression), so a luminance-preserving recolor is invisible by design; the SPEC's
      canonical "padding token → hardcoded value" change grows the button (~3.2% ratio, 3× the
      gate) and is robustly detected. Documented in the README determinism note.
  - Hardening (from the T-12 review):
    - The e2e static server sends `cache-control: no-store` (the stylesheet URL is stable
      across runs) and contains served paths to the sample dir.
    - The bridge unit test uses a runtime-variable import specifier so `tsc` doesn't try to type
      the un-typed `.mjs` (keeps `npm run typecheck` green); a separate test runs real `tsx`
      through a freshly-created bridge link to prove bare-import resolution end-to-end.

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

---

# Tasks: Visual Guard — Phase 1 (Agent-native depth)

> Status: **Draft for review** · Generated after Phase 0 (CP5/T-12) completed.
> SPEC Phase 1 scope: the `visual-reviewer` subagent (structured verdict, deep-probe via MCP) ·
> the `token-auditor` subagent + token-drift detection · `PostToolUse`/`Stop` checkpoint hooks ·
> the `/visual-review` fan-out workflow that **adversarially verifies** each finding.
> **Exit (CP6):** a multi-component review returns only independently-verified findings in one
> synthesized report, and a hardcoded value replacing a token is flagged even when pixels don't move.
> Same rules as Phase 0: each task ≤ ~5 files, an acceptance condition + a verify step, ordered by
> the dependency graph. Subagent/workflow prompt *quality* is covered by eval fixtures + manual
> spot-check (not unit %), per the SPEC Testing Strategy.

## Track legend
- **P1-A (reviewer):** manifest v2 → visual-reviewer subagent → `/visual-check` wiring
- **P1-B (token drift):** `lib/tokens.ts` multi-format token system — pure de-risking core
  (model + type-aware equality) **starts day one**; adapters + scanner + opt-in JS-eval layer on
- **P1-C (hooks):** PostToolUse/Stop checkpoint triggering — parallel
- **P1-D (workflow):** `/visual-review` fan-out + adversarial verify → CP6

```
T-13 ─→ T-14 ─→ T-15 ─┐
T-16 ─→ T-17 ─────────┤
T-18 ─────────────────┼─→ T-19 ─→ T-20 (CP6)
T-13 ─→ T-19 ─────────┘
```

---

## P1-A — the reviewer

- [x] **T-13 · Manifest v2 — persist the RenderTarget + currentDimensions** ✅
  - Done: `capture.ts` writes a `renders.json` sidecar per run (`{version, renders}` keyed by the
    same `renderRelPath` compare/report key on) — each render's `url`/`kind`/`viewport` +
    `currentDimensions` read straight from the PNG IHDR via a pure `readPngDimensions` (null on a
    non-PNG, never throws). `report.ts` reads it and adds per-image `renderTarget`
    (`url`/`kind`/`storyId`/`viewport`, `storyId` parsed from the iframe URL, null for app routes)
    + `currentDimensions`, bumps `version: 2`. The `RenderRecord`/`RendersFile` import into
    `report.ts` is **type-only** (no runtime `playwright` pull-in). golden snapshot regenerated;
    **350 tests green**, typecheck + lint + `claude plugin validate --strict` clean.
  - Why: the `visual-reviewer` must be able to **re-render the live element** via Playwright/
    Chrome-DevTools MCP to disambiguate a diff, which needs each image's `url`/`kind`/`storyId`;
    manifest v1 deliberately omitted these (see the `ManifestImage` note in `report.ts`).
  - Acceptance: `capture.ts` persists the resolved `RenderTarget` list for the run (e.g.
    `renders.json` keyed by `renderRelPath`); `report.ts` adds per-image `renderTarget`
    (`url`, `kind`, `storyId?`, `viewport`) and `currentDimensions`, bumps `version: 2`, and the
    golden snapshot is updated. v1→v2 is additive (no field removed) so nothing downstream breaks.
  - Verify: `npm test -- report capture`; the golden snapshot reflects v2; `parseConfig`/contract
    types still typecheck.
  - Files: `scripts/capture.ts`, `scripts/report.ts`, `tests/report.test.ts`, `tests/capture.test.ts`,
    `tests/__snapshots__/*`
  - Depends on: T-07, T-09 (done)
  - Decisions / hardening (from the T-13 adversarial review):
    - **`storyId` derived in `report.ts` from the URL** (`storyIdFromUrl`) rather than added to
      `RenderTarget` — keeps `targets.ts` (and its tests) untouched; `renders.json` persists only
      what capture already has (`url`/`kind`/`viewport`).
    - **Back-compat is real, not nominal:** a pre-v2 run with no `renders.json` yields `renderTarget`
      / `currentDimensions` = `null` (both keys still present) — never a crash or a missing field.
      Covered by a dedicated test + the read-path test (renders.json on disk → populated).
    - **Removed a pre-existing NUL byte** in `report.ts` (`groupKey` delimiter `\0` → space) that
      made the file "binary" to grep/diff/review tooling; the delimiter is a transient Map key, so
      the change is behavior-preserving (a sanitized segment can contain neither a space nor a NUL).
    - Non-null `currentDimensions` is now exercised end-to-end through `captureAll` (a valid PNG
      header through the fake browser), not just `readPngDimensions` in isolation.

- [x] **T-14 · `visual-reviewer` subagent** ✅
  - Done: `agents/visual-reviewer.md` — read-only (`tools: Read, Grep, Bash,
    mcp__playwright__playwright_navigate, mcp__playwright__playwright_screenshot`;
    `disallowedTools: Write, Edit`), `model: sonnet`, `effort: high`, `maxTurns: 15`. Consumes a
    changed manifest target, reviews **each changed image** (evidence → re-render ambiguous diffs
    via the Playwright MCP using the v2 `renderTarget.url` → verdict), and returns an **array of
    `VerdictReport`** (one self-addressing object per changed image). `tests/verdict-contract.test.ts`
    pins the output keys field-for-field + the read-only / sonnet·high·15 frontmatter.
    `claude plugin validate --strict` ✔.
  - Acceptance: `agents/visual-reviewer.md` — **read-only** (`tools: Read, Grep, Bash` + the
    Playwright MCP nav/screenshot tools; `disallowedTools: Write, Edit`), `model: sonnet`,
    `effort: high`, `maxTurns: 15`. Consumes a manifest target, classifies each changed image as
    `intentional | bug | design-system-violation`, and returns the self-addressing **`VerdictReport`**
    JSON — the typed `Verdict` (severity · classification · issue · file · line · cause · impact ·
    fix) **plus** the `target`/`state`/`viewport` identifiers (per the locked Q below), one object
    per changed image. It deep-probes ambiguous diffs via MCP before deciding, and never reports a
    finding it could not verify.
  - Verify: `claude plugin validate . --strict`; a contract test asserts the documented JSON keys
    match the `VerdictReport` interface field-for-field (so the agent's output stays an interface,
    not prose); an eval fixture (a known diff manifest → the verdict has the required fields and a
    plausible classification) as a manual/spot-check, not a unit assertion on wording.
  - Files: `agents/visual-reviewer.md`, `tests/verdict-contract.test.ts`, `scripts/report.ts`
    (the `VerdictReport` type + `VERDICT_KEYS`/`VERDICT_REPORT_KEYS`).
  - Depends on: T-13
  - Boundary / **Q locked (SPEC "Ask first")**: the agent output is a structured-output contract.
    Decision (confirmed with the user): emit the **self-addressing `VerdictReport`** = the 8-field
    `Verdict` **+ `target`/`state`/`viewport`**, so a per-target (T-15) or fan-out (T-19) invocation
    can route each finding back to its image. `VerdictReport` is a NEW type in `report.ts`; the
    stored `ManifestImage.verdict` stays the 8-field `Verdict` (T-15 strips the identifiers when it
    persists each verdict). The manifest golden snapshot is therefore unchanged. `state`/`viewport`
    are `null` for a source-level finding (the `token-auditor`, T-17). Runtime key lists
    (`VERDICT_KEYS` / `VERDICT_REPORT_KEYS`) are held exhaustive by `satisfies` guards so the
    contract can't drift.

- [x] **T-15 · `/visual-check` Phase-1 wiring (verdict, not just prose)** ✅
  - Done: `report.ts` gained `mergeVerdicts` (pure — routes each `VerdictReport` to its image by
    `(target,state,viewport)`, stores the 8-field `Verdict`, returns `{applied, unmatched}`) +
    `applyVerdicts` (reads `manifest.json` + `verdicts.json`, merges, writes back) + a
    `--apply-verdicts` CLI mode (proven with a real `tsx` run). `commands/visual-check.md` now has
    **§3 Review** (invoke `visual-reviewer` per flagged target → `verdicts.json` →
    `report.ts --apply-verdicts`) and **§4 Present** (evidence → populated verdict; main-loop
    fallback when the subagent is unavailable). `ManifestImage.verdict` stays the 8-field `Verdict`
    so the golden snapshot is unchanged. Tests for routing / identifier-strip / unmatched / errors.
    `claude plugin validate --strict` ✔.
  - Acceptance: when the manifest has flagged targets, `/visual-check` invokes `visual-reviewer`
    per changed target, presents **evidence (pixels) then the structured verdict**
    (classification · cause · file:line · impact · fix), and persists the verdicts back into
    `manifest.json` (the `verdict` field, now populated). Still read-only on source; still never
    auto-approves a baseline. Falls back to the Phase-0 main-loop explanation if the subagent is
    unavailable.
  - Verify: `claude plugin validate . --strict`; manual `/visual-check Button` on the sample shows
    a populated verdict; the command doc still encodes the read-only / no-auto-baseline / nothing-
    external boundaries.
  - Files: `commands/visual-check.md`, `scripts/report.ts` (the merge helper + `--apply-verdicts`),
    `tests/report.test.ts`
  - Depends on: T-14
  - Hardening (from the T-15 adversarial review — initial run rate-limited, re-run clean):
    - **No mis-routing across instances:** the `VerdictReport` carries no `instance`, so two
      instances exposing the same component name at the same state×viewport make `(target,state,
      viewport)` ambiguous. `mergeVerdicts` detects the collision and routes such a verdict to NONE
      (it lands in `unmatched`) rather than an arbitrary instance — safe by construction; tested.
      Per-instance verdicts (needs `instance` on the verdict) are deferred until a run needs them.
    - The §3 persist step re-establishes the runner vars (a fresh shell doesn't inherit §2's) and
      reuses the same `$RUN_ID`, so it works whether or not it runs in §2's shell.

## P1-B — token drift (parallel, TDD)

> **T-16 is decomposed (T-16a–T-16e)** after the Q#4 resolution expanded it from "parse one CSS
> file" into a multi-format, type-aware token subsystem. Build **de-risker-first**: T-16a→T-16b
> are the pure, day-one core (config + equality); adapters, scanner, and opt-in JS-eval layer on.

- [x] **T-16a · `tokens` config schema + back-compat (TDD)** ✅
  - Done: `Config.tokens` is now `TokensConfig` (`string | {source} | {sources[]}` → normalized);
    `parseTokens`/`parseTokenSource` validate format/mode/rootFontSize/ignoreValues/allowJsEval,
    JS-eval formats gated on `allowJsEval`; 12 new tests; deps pinned + mirrored into `ENGINE_DEPS`
    (+ its two drift-guard tests updated). `npm test` green, typecheck + lint + prettier clean.
  - Acceptance: `config.tokens` accepts `string | { source } | { sources: TokenSourceObject[] }`
    where `TokenSourceObject = { source, format?: TokenFormat|"auto", mode?, rootFontSize? }`; a
    bare string and the legacy `{ source }` normalize to a single auto-detected source (behavior-
    compatible with Phase 0). Adds `tokens.ignoreValues?: string[]` and
    `tokens.allowJsEval?: boolean`. Fail-fast errors name the offending field. (Extensibility —
    `customTypes`, custom-adapter module — **deferred** per the Q#4 decision.)
  - Verify: `npm test -- config` — legacy `{source:"x.css"}` and bare `"x.css"` still parse; an
    invalid `format` / non-array `sources` names the field.
  - Files: `scripts/lib/config.ts`, `config/visual.config.json`, `tests/config.test.ts`
  - Depends on: T-04 (done)
  - Boundary: config contract change — SPEC "ask first", resolved in the Q#4 decision.

- [x] **T-16b · Token model + type-aware equality core (TDD — the de-risker)** ✅
  - Done: `tokens-model.ts` (`Token`/`TokenSet`/`TokenType` incl. `custom:<name>`) +
    `token-equality.ts` (`canonicalize`/`canonicalizeAuto`/`valuesEqual`/`canonicalKey`/
    `buildTokenSet`, `classOf`). culori color canon (alpha-aware, wide-gamut→medium), rem/pt→px
    (em→medium, %/vh/ch→low keep-unit), ms duration, fontWeight keyword↔number, unit-agnostic
    zero, cross-class isolation. `types/culori.d.ts` shim. **72 tests, 98.3% cov**, full suite green.
  - Acceptance: `lib/tokens-model.ts` exports `Token`, `TokenSet`, `TokenType` (incl.
    `custom:<name>`); `lib/token-equality.ts` canonicalizes per type so a literal equals a token
    **iff truly equal** — color via `culori` (`#fff`≡`#ffffff`≡`white`≡`rgb(255,255,255)`, alpha
    significant); dimension→px via configurable `rootFontSize` (`8px`≡`0.5rem`, `0`≡`0px`; `em` &
    context-relative units `%`/`vh`/`ch` → lower-confidence / string-compare); duration→ms;
    fontWeight keyword↔number; numeric for number/opacity/zIndex. Reverse index keyed
    `${type}:${canonical}`; value collisions → ranked candidates. **≥ 80% coverage.**
  - Verify: `npm test -- token-equality --coverage` — table-driven equivalence + non-equivalence
    fixtures (alpha, unit, zero, keyword cases).
  - Files: `scripts/lib/tokens-model.ts`, `scripts/lib/token-equality.ts`,
    `tests/token-equality.test.ts`
  - Depends on: T-16a; **dep:** `culori`.

- [x] **T-16c · Format adapters — static (TDD)** ✅
  - Done: `token-adapters/` — `css.ts` (CSS custom props · Tailwind v4 `@theme` · SCSS `$` · Less
    `@` via postcss/-scss/-less, mode selection, `var()`/`$`/`@` alias resolution), `dtcg.ts`,
    `style-dictionary.ts` (v3+v4), `tokens-studio.ts`, shared `json-common.ts`/`infer.ts`, and
    `index.ts` (`detectFormat` + `parseSource`). `types/postcss-less.d.ts` shim. Fixed a real
    culori bug (bare numbers parsed as hex colors → guarded). **94 adapter/inference tests, dir
    90% cov (infer 100%)**, full suite 275 green.
  - Acceptance: `lib/token-adapters/*` parse each static format into `Token[]`: CSS custom
    properties + Tailwind v4 `@theme` (via `postcss`), SCSS/Less (`postcss-scss`/`postcss-less`),
    DTCG (`$value`/`$type`, aliases `{group.token}`, composite types), Style Dictionary (v3
    `value` + v4 `$value`/`$type`, CTI), Tokens Studio (`{value,type}` sets, `$themes`). A
    `detect(path,contents)` picks an adapter by extension+content; an explicit `format` overrides.
    Aliases resolved across sources; `mode` selection honored. **≥ 80% coverage.**
  - Verify: `npm test -- token-adapters --coverage` — one fixture per format → expected normalized tokens.
  - Files: `scripts/lib/token-adapters/{index,css,dtcg,style-dictionary,tokens-studio}.ts`,
    `tests/token-adapters.test.ts`, `tests/fixtures/tokens/*`
  - Depends on: T-16b; **deps:** `postcss`, `postcss-scss`, `postcss-less`.

- [x] **T-16d · Literal scanner + drift detector (TDD)** ✅
  - Done: `token-scan.ts` — CSS/SCSS/Less value-position literals via postcss (skips `var()`/`$`/`@`
    refs, splits shorthands), JSX `style={{}}` (numeric length→px) + Tailwind arbitrary classes
    `p-[8px]`/`text-[#fff]` via the `typescript` AST; `detectDrift` → `DriftFinding[]` with weighted
    context ranking, raw+canonical `ignoreValues`, confidence inheritance. `tokens.ts` public API
    (`loadTokens`/`auditTokens`, injected fs, JS-eval sources skipped for T-16e). **39 tests** incl.
    the CP5 gap (`padding:8px`→`--space-md`; `var(--space-md)`→clean) + sub-threshold recolor;
    token-scan 91% / tokens 86% cov. Full suite **314 green**, typecheck+lint+prettier clean.
  - Acceptance: `lib/token-scan.ts` extracts hardcoded **value-position** literals from changed UI
    files (git diff × `uiGlobs`): CSS/SCSS values via `postcss`; JSX `style={{}}` + known style
    props **and Tailwind utility classes** (incl. arbitrary values `p-[8px]`, `text-[#fff]`) via
    the `typescript` AST. `detectDrift(tokens, files)` → `DriftFinding[]` (`file, line, column?,
    cssProperty?, literal, canonicalValue, type, suggestedToken, alternatives, confidence,
    reason`); skips literals already written as `var(--token)`/token refs and any `ignoreValues`.
    The gate that **catches what the luminance-normalized pixel diff cannot.** Injected fs/git.
    **≥ 80% coverage.**
  - Verify: `npm test -- token-scan --coverage` — `--space-md:8px` + a changed file using
    `padding:8px` and `className="p-[8px]"` → flagged with the token; a file using the token
    var/class → not flagged.
  - Files: `scripts/lib/token-scan.ts`, `scripts/lib/tokens.ts` (public `loadTokens` + `detectDrift`),
    `tests/token-scan.test.ts`, `tests/fixtures/tokens/*`
  - Depends on: T-16c; **dep:** `typescript` (present; add to engine `ENGINE_DEPS` in T-16e).

- [x] **T-16e · JS-eval adapters (opt-in) + engine dep bootstrap** ✅
  - Done: `token-adapters/js-eval.ts` + `eval-theme.mjs` runner — Tailwind v3 `tailwind.config.*`
    (resolveConfig when available, else theme+extend merge) and JS/TS theme objects, evaluated in a
    **child process** under tsx (`.ts` supported), JSON-only capture, 10s timeout, gated on
    `allowJsEval` (refuses otherwise). Pure `flattenThemeTokens` (nested/scale-array/DEFAULT/font-
    stack). `loadTokens` routes JS-eval sources; `typescript` added to `ENGINE_DEPS` (token scanner
    + child eval) with both drift-guard tests updated. **6 tests** incl. real child-process eval +
    a full tailwind-config→drift audit. js-eval 90% cov; **`claude plugin validate --strict` ✔**.
  - Acceptance: behind `tokens.allowJsEval === true`, adapters resolve Tailwind v3
    `tailwind.config.{js,ts}` (read `theme`/`theme.extend`; prefer the project's
    `tailwindcss/resolveConfig` when resolvable) and JS/TS **theme objects**, by evaluating the
    file in a **child process** (hard timeout, JSON-only result capture) — never in-process.
    Disabled by default; the command/docs warn "this executes your project code." `install-deps.mjs`
    adds the new engine deps (`postcss`, `postcss-scss`, `postcss-less`, `culori`, `typescript`) so
    the runner resolves them. `claude plugin validate . --strict` stays green.
  - Verify: `npm test -- token-adapters-js` — child-process eval of a fixture theme → tokens; a
    config without `allowJsEval` → the JS adapter refuses with an actionable error; `node
    scripts/install-deps.mjs` twice (2nd a no-op).
  - Files: `scripts/lib/token-adapters/{tailwind-config,js-theme}.ts`, `scripts/install-deps.mjs`,
    `package.json`, `tests/token-adapters-js.test.ts`
  - Depends on: T-16d
  - Boundary: executing user JS is opt-in and sandboxed to a child process (SPEC "ask first" — resolved).

- [x] **T-17 · `token-auditor` subagent** ✅
  - Done: `agents/token-auditor.md` — lightweight, read-only (`tools: Read, Grep, Bash`; no
    browser), `model: sonnet`, `effort: medium`, `maxTurns: 10`. Consumes the engine's
    `DriftFinding[]`, greps usages for impact, and emits the **same `VerdictReport` contract** as
    the reviewer with `classification: "design-system-violation"`, `cause`/`fix` from
    `literal` + `suggestedToken`, `severity` from `confidence` + type, and `state`/`viewport` =
    `null` (drift is source-level, viewport-independent). `tests/token-audit-contract.test.ts` pins
    `DriftFinding` keys stable (compile-time `satisfies` guard) + the output field-for-field + the
    cause/fix templates. `claude plugin validate --strict` ✔.
  - Acceptance: `agents/token-auditor.md` — lightweight, read-only; consumes `lib/tokens.ts`
    `DriftFinding[]`, greps usages for `impact`, and emits the verdict (the `VerdictReport` shape
    locked in T-14 — `state`/`viewport` `null` for this source-level finding):
    `classification: "design-system-violation"`, `cause = "hardcoded <literal> replaces
    <suggestedToken>"`, `fix = "replace <literal> with var(<token>)"` (format-appropriate
    reference), `severity` from `confidence` + token type — explaining each drift **even when the
    pixel delta is below threshold**.
  - Verify: `claude plugin validate . --strict`; a contract test asserts `DriftFinding` keys are
    stable and the documented auditor output matches `VerdictReport` field-for-field (interface, not
    prose); an eval fixture (the T-16d hardcoded-spacing case → a drift Verdict citing the token).
  - Files: `agents/token-auditor.md`, `tests/token-audit-contract.test.ts`
  - Depends on: T-16d

## P1-C — checkpoint hooks (parallel)

- [x] **T-18 · `detect-ui-change.mjs` + PostToolUse/Stop hooks** ✅
  - Done: one no-dep, node-builtins-only `detect-ui-change.mjs` backing both hooks. Default
    (PostToolUse `Write|Edit`): parse the tool payload, record `uiGlobs`-matching edits as
    project-relative paths into `<cwd>/.visual-guard/pending.json` — **detection only** (no
    browser, no engine import), every path `exit 0`, all errors swallowed. `--nudge` (Stop):
    emit `{ systemMessage }` when pending is non-empty — never sets `decision`/`continue`/exit 2,
    so it can't loop or hard-block. `hooks/hooks.json` registers both + `claude plugin validate
    --strict` ✔. 22 tests incl. bare-`node` spawn + garbage/binary-stdin exit-0 guards.
  - Acceptance: a `PostToolUse` hook (matcher `Write|Edit`) runs `detect-ui-change.mjs` — a fast,
    **no-dep**, **non-blocking** script that records edited files matching `uiGlobs` into
    `.visual-guard/pending.json` (detection only — it must **never** trigger capture inside the
    hook, per SPEC). A `Stop` hook nudges the user to run `/visual-check` if `pending.json` is
    non-empty. `hooks/hooks.json` registers both and validates.
  - Verify: run `detect-ui-change.mjs` on a fake `Write` payload → `pending.json` updated; a
    non-UI edit → no entry; `claude plugin validate .`; confirm the hook does no heavy work
    (no browser, no engine import).
  - Files: `scripts/detect-ui-change.mjs`, `hooks/hooks.json`, `tests/detect-ui-change.test.ts`,
    `commands/visual-check.md` (the `--clear` wiring).
  - Depends on: T-02, T-03 (done) — parallel track.
  - Boundary: enabling auto-capture on every edit is "Ask first"; this task does **detection only**.
  - Decisions / hardening (from the T-18 adversarial review):
    - **Stop-hook contract verified** (via `claude-code-guide`, not memory): `tool_input.file_path`
      on stdin; `exit 0` + no `decision` is the non-blocking nudge; `{ systemMessage }` surfaces to
      the user without forcing a loop. (RULES.md: hook knowledge may be stale — double-checked.)
    - **No permanently-stuck nudge:** added a tested `--clear` mode and wired `/visual-check` to run
      it after a clean checkpoint, so the nudge resets (the review caught that nothing consumed
      `pending.json`). The stale "the user clears it" JSDoc was corrected.
    - **Out-of-project edits are skipped** (`isInProject`): a UI file edited outside the project
      root would still match a `**` glob but isn't this project's pending change, so it's not
      recorded (fixed a false comment-vs-behavior invariant).
    - **uiGlobs resolution mirrors `/visual-check`** (project → `config/` → bundled
      `${CLAUDE_PLUGIN_ROOT}/config` → inlined `DEFAULT_UI_GLOBS`); the inlined default is
      documented as needing lockstep with `config.ts DEFAULTS.uiGlobs` (the no-dep hook can't import
      the TS loader).
    - The non-blocking/`exit 0` guarantee on malformed/empty/binary stdin is now regression-tested
      end-to-end through the CLI, not just the happy path.

## P1-D — fan-out review + exit

- [x] **T-19 · `/visual-review` fan-out workflow (adversarial verify)** ✅
  - Done: `skills/visual-review/SKILL.md` + `skills/visual-review/workflow.template.js`. The skill
    builds the review units from a run's manifest, launches the bundled template via the **Workflow
    tool** (`scriptPath` + `args`), and offers to save it as `/visual-review` (`/workflows` → `s` →
    `.claude/workflows/`). The template is a real workflow script: `meta` + 3 phases
    (Review/Verify/Synthesize); fans review across components × viewports (`visual-reviewer` +
    `token-auditor` via `agentType`); **adversarially verifies** each finding with `SKEPTICS=3`
    independent verifiers behind a `MAJORITY` gate; synthesizes **one** report; returns
    `{confirmed, report}`. `tests/visual-review-template.test.ts` is a deterministic structure test
    (parses the script via `AsyncFunction` — it uses top-level `await`+`return` which the Workflow
    runtime wraps — and asserts phases/fan-out/majority-gate/both-subagents/synthesis + the skill's
    launch+save+read-only instructions). `claude plugin validate --strict` ✔.
  - Acceptance: a skill + a workflow **template** (`skills/visual-review/workflow.template.js`) the
    skill launches as a dynamic workflow (per the SPEC "Workflow integration note" — plugins can't
    bundle workflows, so it ships skill+template and offers to save it as `/visual-review`). The
    workflow fans out review across components × viewports (`visual-reviewer` + `token-auditor`),
    **adversarially verifies each finding** (independent skeptics, majority gate) before it's
    reported, and synthesizes **one** report — so no unverified noise reaches the user.
  - Verify: `claude plugin validate . --strict`; the template parses + has a deterministic
    structure test (phases/fan-out/verify present); a manual multi-component run returns only
    verified findings.
  - Files: `skills/visual-review/SKILL.md`, `skills/visual-review/workflow.template.js`,
    `tests/visual-review-template.test.ts`
  - Depends on: T-13, T-14, T-16
  - Decision: `/visual-review` is a **skill** (per the SPEC project tree, §"Project Structure"),
    not a `commands/visual-review.md` — the Files entry in the original draft is superseded by the
    SPEC, and a duplicate command would collide with the skill (the skill is slash-invocable as
    `/<plugin>:visual-review`). The adversarial review (re-run after an initial rate-limit) added
    test-rigor: the structure test now pins the agent output schema to `VERDICT_REPORT_KEYS`,
    asserts exactly one synthesis, and the precise per-agent Verify phase group.

- [x] **T-20 · CP6 — Phase 1 exit verification** ✅
  - Done: the bundled sample now has **2 components** — Button (`/button`) + a new Badge
    (`badge.html` + `src/Badge.css`, `/badge`) whose background is the `--vg-brand` color token.
    `tests/e2e/review-flow.e2e.test.ts` (gated, real Chromium) drives both end-to-end and proves the
    Phase-1 exit: the Button's spacing→hardcoded geometry change is a pixel `fail`; the Badge's
    **sub-threshold drift** (the `--vg-brand` color inlined as its identical `#2563eb`) moves **zero
    pixels** (the Badge target `pass`es) yet is **caught by `auditTokens`** (`#2563eb` → `--vg-brand`,
    type `color`) — the SPEC criterion "flagged even when the pixels don't move". It also merges a
    structured reviewer verdict into `manifest.json` (the `/visual-check` Phase-1 contract).
    **Both gated e2es (CP5 + CP6) were run with real Chromium and pass.** README + sample README
    document the Phase-1 flow. Full suite green, typecheck + lint + `claude plugin validate --strict` ✔.
  - Acceptance: extend the bundled sample to ≥ 2 components, one carrying a **sub-threshold token
    drift** (a token inlined as a hardcoded value with a near-zero pixel delta). `/visual-review`
    returns **only independently-verified findings** in one synthesized report; the token-drift
    case is flagged **even though the pixel delta < `maxDiffRatio`** (SPEC success criterion);
    `/visual-check` shows structured verdicts. README updated with the Phase 1 flow.
  - Verify: a gated e2e drives the multi-component review end-to-end; `npm test` green;
    `claude plugin validate . --strict`.
  - Files: `tests/e2e/sample/*` (extended: `badge.html`, `src/Badge.css`, `README.md`),
    `tests/e2e/review-flow.e2e.test.ts`, `README.md`
  - Depends on: T-15, T-17, T-18, T-19
  - Decisions / notes:
    - **`/visual-review` workflow quality is not unit-tested** (it needs the Claude runtime, not
      vitest) — the e2e drives the deterministic engine the AI layers consume; the workflow's
      *structure* is pinned by `tests/visual-review-template.test.ts` and its quality is a manual
      spot-check, per the SPEC Testing Strategy.
    - **The CP5 sample config + `canonical-flow.e2e` were left untouched** (it's a gated test I keep
      stable); `review-flow.e2e` uses its own inline two-route config. Confirmed both gated e2es
      still pass with real Chromium.

---

## Suggested execution (Phase 1)

Start **three tracks in parallel**, mirroring Phase 0:
- **T-16a → T-16b** (config schema + type-aware equality core, TDD) — the day-one de-risker; it
  closes the exact gap CP5 exposed (luminance-normalized diff misses recolors / inlined values).
  Then T-16c (static adapters) → T-16d (scanner/drift) → T-16e (opt-in JS-eval).
- **T-18** (hooks) — small, independent, unblocks the checkpoint UX.
- **T-13 → T-14 → T-15** (manifest v2 → reviewer → `/visual-check` wiring).

They converge at **T-19** (`/visual-review` fan-out + adversarial verify), then **T-20 (CP6)**.
**Decide first (SPEC "Ask first"):** lock the `visual-reviewer` `Verdict` JSON shape (T-14) and
the `token-auditor` finding shape (T-17). **Q#4 resolved** (see Decisions): a multi-format,
type-aware token system (CSS · DTCG · Style Dictionary · Tailwind · Tokens Studio · SCSS/Less +
opt-in JS-eval), built de-risker-first — **T-16a → T-16b** (config + equality core) on day one.

---

# Tasks: Visual Guard — Phase 2 (Operations & reporting)

> Status: **Complete — CP7 verified** (T-21–T-26 done; adversarial review folded in). · Last updated: 2026-06-14
> SPEC Phase 2 scope: a **dev-server / Storybook readiness monitor** · the **`/visual-coverage`**
> map (state × component, with gaps) · a **PR-comment generator** · a **non-interactive CI mode**
> that exits non-zero on unapproved regressions.
> **Exit (CP7):** Visual Guard can gate a CI pipeline (deterministic non-zero exit) and produce a
> PR report. Same rules as Phase 0/1: each task ≤ ~5 files, an acceptance condition + a verify step,
> ordered by the dependency graph. Engine logic is unit/contract-tested; the monitor/command/skill
> surfaces are validated by `claude plugin validate --strict` + a gated e2e, not unit %.

### Decisions taken to proceed (verified before writing — RULES.md "double-check stale CC knowledge")

- **D1 — Monitors ARE a bundleable plugin component (verified via `claude-code-guide` + the docs).**
  A plugin ships `monitors/monitors.json` (auto-discovered like `agents/`/`commands/`/`hooks/`;
  `claude plugin validate --strict` accepts it). Schema: an array of
  `{ name, command, description, when }`; `when` is `"always"` or `"on-skill-invoke:<skill>"`
  (so `"on-skill-invoke:visual-check"` is valid). A monitor runs a shell command for the session
  lifetime and **streams each stdout line as a notification** — it is **read-only / non-gating**
  (it cannot block a command or force a failure) and needs Claude Code ≥ 2.1.105. **Consequence:**
  the dev-server monitor *surfaces* readiness + route/index health continuously; it does **not**
  replace `capture.ts`'s hard origin probe — the R2 fast-fail stays the gate. "Closes R2" is
  therefore softened to "gives continuous readiness visibility around a check."
- **D2 — the CI exit code comes from the engine, not from `claude -p` (verified).** `claude -p`
  (print/headless) does **not** auto-exit non-zero when a skill/command "fails" — the caller must
  inspect output, or the invoked process must set its own exit code. So the reliable CI gate is a
  **deterministic engine script** (`scripts/ci.ts`) whose own process exit is `0` (clean) / `1`
  (unapproved regressions). The `claude -p --init` path is documented as an *optional* wrapper; the
  authoritative gate is the engine script. (SessionStart deps bootstrap runs in `-p` with `--init`.)
- **D3 — the PR comment is GENERATED, never POSTED.** Visual Guard stays local (SPEC "everything is
  local · never send a screenshot to an external service"). `scripts/pr-report.ts` writes Markdown to
  `<runDir>/pr-comment.md` (a `.visual-guard/` run artifact) + stdout; **the CI system posts it**
  (`gh pr comment -F …`, shown in docs). No screenshots are embedded/uploaded; the report links the
  run-relative diff-PNG paths. (Image hosting is a deferred opt-in.)
- **D4 — CI gate policy.** A `fail` (pixel/dimension regression) **always blocks** (exit 1). `new`
  (no baseline = unapproved) and `error` (undecodable render) **block by default** — CI must be
  clean — relaxable with `--allow-new` / `--allow-error` for a first-baseline bootstrap. This is the
  SPEC's "exit non-zero on **unapproved** regressions" (a `new` render is unapproved).
- **D5 — no new runtime deps.** All four deliverables use Node builtins + existing engine modules
  (`Manifest`/`report.ts`, `config.ts`, `resolveTargets`, `walkPngFiles`, `latestRunId`). The
  monitor follows the no-dep `.mjs` hook pattern (it runs under a bare `node`). (SPEC "Ask first:
  adding a dependency" — none added.)

## Track legend
- **P2-A (report+gate):** `scripts/ci.ts` (pure gate decision + exit code) → `scripts/pr-report.ts`
  (pure Markdown) — both consume `manifest.json`; pure-core-first, the day-one de-riskers.
- **P2-B (coverage):** `scripts/coverage.ts` + `skills/visual-coverage/SKILL.md` — the state ×
  component map with gaps, derived from the resolved render grid × committed baselines.
- **P2-C (monitor):** `scripts/monitor-targets.mjs` + `monitors/monitors.json` — readiness watcher
  (independent track).
- **P2-D (surface + exit):** `commands/visual-ci.md` (in-session entry) → CP7 e2e + docs.

```
T-21 (ci gate) ─┬─→ T-25 (visual-ci cmd) ─┐
T-22 (pr-report)┘                          ├─→ T-26 (CP7)
T-23 (coverage) ───────────────────────────┤
T-24 (monitor) ────────────────────────────┘
```

---

## P2-A — report + CI gate (parallel, TDD)

- [x] **T-21 · `scripts/ci.ts` — non-interactive CI gate (TDD; the de-risker)** ✅
  - Done: `scripts/ci.ts` — pure `evaluateGate` (target-level `fail`/`new`/`error` counts → `ok`/
    `exitCode`/`blockingTargets`/`summaryLine`) + `runGate` (latest-run fallback via `latestRunId`,
    reads `manifest.json`) + a CLI exiting `0` clean / `1` blocked / `2` could-not-run, with `--json`.
    14 tests; smoke-tested directly (exit codes + `--json`). typecheck + lint + plugin-validate clean.
  - Acceptance: a pure `evaluateGate(manifest, policy) → { ok, exitCode, blocking: { fail, new,
    error }, blockingTargets: { instance, target, status }[], summaryLine }` (per D4: `fail` always
    blocks; `new`/`error` block unless `policy.allowNew`/`allowError`). `runGate(config, { runId?,
    outRoot, policy })` resolves the latest run when `--run` is omitted (reuses `baseline.ts`
    `latestRunId`), reads `manifest.json`, evaluates, and (CLI) prints a human line + an optional
    `--json` object, then `process.exit(exitCode)`. **Read-only** under `.visual-guard/`; never
    captures, never approves a baseline, sends nothing external.
  - Verify: `npm test -- ci` — clean manifest → `ok`/exit 0; one `fail` target → exit 1 and it is
    listed; `new`/`error` → exit 1 by default, exit 0 with `allowNew`/`allowError`; a missing
    `manifest.json` → an actionable error.
  - Files: `scripts/ci.ts`, `tests/ci.test.ts`
  - Depends on: T-09 (manifest contract), T-11 (`latestRunId`) — done.
  - Hardening (from the Phase-2 adversarial review):
    - **Zero-target manifest no longer passes green:** a `manifest.json` with `targets: []` (a
      truncated/corrupt manifest, or a config that resolved no renders) now returns `ok:false`,
      `exitCode: 2` ("could not run") with an actionable summary — the gate must never report a run
      that verified nothing as clean. `capture.ts` fails fast on zero targets so a normal pipeline
      can't produce this, but the gate is the build verdict and must be loud. Tested.
    - **`runId` path-safety (documented, no partial guard):** `runId` is a trusted internal pipeline
      value (the invoker's `RUN_ID`, never external/file-derived); `ci.ts` joins it exactly as the
      already-shipped `compare.ts`/`report.ts` do (the writer `capture.ts` sanitizes at creation). A
      future hardening could add one shared `assertSafeRunId` to all run-dir-resolving stages;
      guarding only the new files would be inconsistent, so it's left uniform.

- [x] **T-22 · `scripts/pr-report.ts` — PR-comment Markdown generator (TDD; pure)** ✅
  - Done: `scripts/pr-report.ts` — pure `renderPrComment` (header + gate line via `evaluateGate` so
    the PR verdict can't disagree with the CI exit; summary table; evidence-then-verdict per flagged
    target) + `writePrComment` (→ `<runDir>/pr-comment.md`) + CLI. Generates only; nothing posted/
    uploaded. 11 tests; eyeballed the rendered Markdown. Gates clean.
  - Acceptance: a pure `renderPrComment(manifest, opts) → string` — a status header (✅/⚠️ + the gate
    line), a summary table (targets · images · fail/new/error/pass), and a per-**flagged**-target
    section that shows **evidence first** (ratio %, `dimensionDelta`, changed regions, the diff-PNG
    path) **then the verdict** (classification · cause · `file:line` · impact · fix) when populated.
    A footer states baselines are local and how to approve (`/visual-baseline`). `writePrComment(
    config, { runId?, outRoot })` writes `<runDir>/pr-comment.md` + returns `{ path, markdown }`;
    CLI prints to stdout and the file. **Generates only** (D3) — never posts, embeds no remote
    images, sends nothing external.
  - Verify: `npm test -- pr-report` — a manifest with a `fail`+verdict, a `new`, and a `pass` →
    Markdown contains the gate line, the table counts, the flagged target's evidence + verdict, the
    `file:line`; a clean manifest → a "0 regressions" body. Deterministic string assertions.
  - Files: `scripts/pr-report.ts`, `tests/pr-report.test.ts`
  - Depends on: T-09, T-11 — done.
  - Hardening (from the Phase-2 adversarial review):
    - **Summary cell describes the flagged image, not a higher-ratio passing one.** `worstImage` now
      ranks by status first (reusing `report.ts`'s exported `STATUS_RANK`), then by dimension-change,
      then ratio — so a dimension-only `fail` (which `classify` flags at ratio≈0) is never masked in
      the "Change" cell by a passing image whose sub-gate noise ratio is higher. Tested.
    - **"Verdict" and "Change" cells describe the same image.** `verdictCell` now prefers the worst
      (flagged) image's verdict, so a row is internally consistent and a verdict can't read as
      "reviewed" while the blocking image is unjudged. Tested.
    - **Generate-not-post / write-boundary:** unchanged from D3 — writes only `<runDir>/pr-comment.md`
      under `.visual-guard/` (the same write pattern as `compare.ts`/`report.ts`); see the T-21
      `runId` note for the shared trusted-pipeline-value posture.

## P2-B — coverage map

- [x] **T-23 · `scripts/coverage.ts` + `/visual-coverage` skill (TDD)** ✅
  - Done: `scripts/coverage.ts` — pure `buildCoverage` (covered cells / gaps / orphans, dedupes
    duplicate render keys to match capture's one-PNG-per-key) + `runCoverage` (`resolveTargets` ×
    injected baseline walk) + a text matrix + `--json`; `skills/visual-coverage/SKILL.md` runs and
    presents it. `renderKey` is held in lockstep with `capture.ts` `renderRelPath` by a drift-guard
    test (avoids importing capture's heavy `playwright`). 10 tests. Gates clean.
  - Acceptance: a pure `buildCoverage(renders, baselineKeys) → CoverageMap` crosses the config's
    **resolved render grid** (`resolveTargets` — targets × discovered stories / config states ×
    viewports, the *same* expansion capture uses, so the expected grid can't drift from what is
    shot) with the committed baselines (`walkPngFiles(baselineDir)`), producing per
    `<instance>/<target>`: the covered `state@viewport` cells, the **gaps** (config-expected but
    unbaselined), and the **orphans** (a baseline on disk no longer in config). `runCoverage(config,
    { baselineDir }, { fetch })` resolves targets (injected `fetch` for Storybook discovery), walks
    the baseline dir, and emits a text matrix + `--json`. `skills/visual-coverage/SKILL.md` runs it
    and presents the map. Read-only; sends nothing external.
  - Verify: `npm test -- coverage` — 1 target × 2 states × 2 viewports with 3 of 4 baselines present
    → 1 gap, 0 orphan; an on-disk baseline not in config → 1 orphan; the matrix renders cells.
    Storybook discovery mocked. `claude plugin validate . --strict`.
  - Files: `scripts/coverage.ts`, `skills/visual-coverage/SKILL.md`, `tests/coverage.test.ts`
  - Depends on: T-06 (`resolveTargets`), T-08 (`walkPngFiles`) — done.
  - Hardening (caught during TDD): `runCoverage` calls the injected `walk` directly (no `existsSync`
    pre-guard) — `walkPngFiles` already returns `[]` for a missing dir, and guarding on the real fs
    defeated the injected walker in tests. The Phase-2 review found no further coverage defects.

## P2-C — dev-server monitor

- [x] **T-24 · `scripts/monitor-targets.mjs` + `monitors/monitors.json`** ✅
  - Done: no-dep `scripts/monitor-targets.mjs` — `resolveConfig`/`targetsFromConfig` (config-precedence
    mirror), `pollTarget` (origin reachability + Storybook story count / app route health, `fetch`
    injected, `AbortController` timeouts), `formatLine`/`statusKey`, `runOnce`/`runPass` (logs only on
    transitions), `--once`/`--interval` CLI. `monitors/monitors.json` registers it
    (`when: on-skill-invoke:visual-check`). 23 tests; smoke-tested `--once` against a live Storybook
    (`✓ ready (2 stories)`) + a down app (`… unreachable`). **`claude plugin validate --strict` passes
    WITH the monitor present** (confirms monitors are a valid bundled component — see
    [[plugin-monitors-and-ci-mode]]).
  - Acceptance: a no-dep, node-builtins-only `monitor-targets.mjs` that resolves the project's config
    (same precedence as the hook/command), and polls each configured target — origin reachability
    **and** health (Storybook `/index.json` parses → story count; app `routes` return a non-5xx
    status) — on an interval, printing **one line per state transition** (e.g.
    `✓ storybook localhost:6006 ready (42 stories)`, `✗ app localhost:3000 /checkout → HTTP 500`,
    `… localhost:3000 unreachable`) so the monitor surfaces them as notifications. Long-running,
    **read-only**, never throws out of `main` (an error becomes a logged line; keep polling). A
    `--once` mode does a single pass (for tests / manual use). `monitors/monitors.json` registers it
    with `when: "on-skill-invoke:visual-check"`. `claude plugin validate . --strict` passes.
  - Verify: `npm test -- monitor-targets` (pure helpers: config resolution reuse, the per-target
    poll → status, transition detection, line formatting — `fetch` injected); `node
    scripts/monitor-targets.mjs --once` against a mock prints a status line; `claude plugin validate
    . --strict`.
  - Files: `scripts/monitor-targets.mjs`, `monitors/monitors.json`, `tests/monitor-targets.test.ts`
  - Depends on: T-02 — independent track.
  - Boundary (D1): monitors are read-only / non-gating — this *surfaces* readiness; `capture.ts`'s
    probe stays the hard R2 fail-fast. No capture, no engine import (runs under a bare `node`).
  - Hardening (from the Phase-2 adversarial review):
    - **Readiness matches the engine contract.** A Storybook is `ready` only on the SB7+ `entries`
      shape; a legacy SB6 `stories`-only index is reported `degraded` ("capture requires SB >= 7") —
      because `targets.ts parseStoryIndex` hard-rejects SB6, so a "ready" there would contradict the
      capture the monitor exists to de-risk. An index with no entries is also `degraded`. Tested.
    - **Colliding labels don't drop transitions.** The monitor reads raw config JSON (no
      `resolveTargets` duplicate-label guard), so two targets can share a display `label`. Each target
      now carries a unique `id`, and `runPass` keys its transition state by `id` (not `label`), so one
      target's status can't overwrite another's and silently suppress its notification. Tested.
    - **`--interval` no longer swallows a following flag.** `parseArgs` consumes the next token as the
      interval value only when it parses as a finite positive number, so `--interval --once` keeps
      `--once`. Tested. (Self-targeting fetch against the project's own config is not an SSRF vector;
      the static `monitors.json` command takes no config value, so no injection surface.)

## P2-D — surface + exit

- [x] **T-25 · `commands/visual-ci.md` — in-session CI / PR entry** ✅
  - Done: `commands/visual-ci.md` — preflight → capture/compare/report → `ci.ts` gate (exit code) →
    `pr-report.ts` (Markdown) → present, plus a §5 copy-paste CI recipe and a `gh pr comment -F`
    posting snippet. Encodes read-only · local-only · generate-not-post · the D2 "`-p` doesn't
    auto-exit so `ci.ts` owns the exit code" caveat. `claude plugin validate --strict` passes.
  - Acceptance: a command that runs capture → compare → report → **gate** (`ci.ts`) and generates the
    **PR comment** (`pr-report.ts`), presents the gate result + the Markdown, and tells the user the
    **authoritative CI exit code** comes from running `scripts/ci.ts` directly in CI (the D2 `-p`
    caveat) — with a `gh pr comment -F` snippet they run to post (D3). Read-only on source; never
    approves a baseline; nothing is sent externally by the plugin.
  - Verify: `claude plugin validate . --strict`; the doc encodes read-only · local-only ·
    engine-authoritative-exit · generate-not-post boundaries.
  - Files: `commands/visual-ci.md`
  - Depends on: T-21, T-22.

## End-to-end

- [x] **T-26 · CP7 — Phase 2 exit verification** ✅
  - Done: `tests/e2e/ci-flow.e2e.test.ts` (gated, real Chromium) drives the sample end-to-end and
    proves the Phase-2 exit: an unapproved `new` render BLOCKS the strict gate (exit 1) and passes with
    `--allow-new`; once approved, an unchanged re-run is CLEAN (exit 0) and the PR report says "0
    regressions"; a real Button geometry regression BLOCKS (exit 1) and the generated `pr-comment.md`
    cites `sample/button` with a pixel-ratio. **All 4 gated e2es (CP3/CP5/CP6/CP7) pass with real
    Chromium.** README updated with the Phase-2 flow (CI gate recipe, PR comment, coverage, monitor).
    Full suite **434 unit tests green**, typecheck + lint + `claude plugin validate --strict` clean.
  - Acceptance: on the bundled sample, the deterministic engine gate flags an **unapproved**
    regression with a **non-zero exit** and `pr-report.ts` emits Markdown citing it; `/visual-coverage`
    shows the sample grid with any gap; the monitor prints a readiness line for the sample server.
    README documents the Phase 2 flow (CI gate recipe, PR comment, coverage, monitor).
  - Verify: a gated e2e (`VG_E2E=1`, real Chromium) drives capture → compare → report → `runGate`
    (exit 1 on the regression, 0 once approved) → `writePrComment` on the sample; `npm test` green;
    `claude plugin validate . --strict`.
  - Files: `tests/e2e/ci-flow.e2e.test.ts`, `README.md`, `TASKS.md`
  - Depends on: T-21–T-25.

---

## Suggested execution (Phase 2)

Open **two parallel tracks**, mirroring Phase 0/1:
- **T-21 → T-22** (CI gate + PR Markdown) — pure, day-one de-riskers over the existing
  `manifest.json` contract; they need no browser and lock the gate/report shape the rest depends on.
- **T-23** (coverage) and **T-24** (monitor) are independent and can land alongside.

They converge at **T-25** (`/visual-ci` surface), then **T-26 (CP7)** proves the CI gate + PR report
end-to-end on the sample. **Decided up front** (see Decisions D1–D5): the monitor primitive, the
engine-owned CI exit code, generate-not-post for PR comments, the gate policy, and no new deps.
