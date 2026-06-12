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

- [ ] **T-03 · Dep bootstrap + SessionStart hook** (Track 3) → CP1
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

- [ ] **T-05 · `lib/diff.ts` + tests + fixtures** → CP2
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

- [ ] **T-04 · `lib/config.ts` + tests**
  - Acceptance: loads + validates `visual.config.json`; applies defaults; missing/invalid
    fields throw an actionable error naming the field; exported `Config` type matches SPEC.
  - Verify: `npm test -- config`
  - Files: `scripts/lib/config.ts`, `tests/config.test.ts`
  - Depends on: T-02

- [ ] **T-06 · `lib/targets.ts` + tests** → R3
  - Acceptance: `detect: auto` discovers Storybook stories via `/index.json` (fallback
    `/stories.json`); expands stories → iframe URLs; app `routes` → URLs × `viewports` ×
    `states`; an explicit story/route list bypasses discovery; Storybook < 7 documented
    unsupported with a clear error.
  - Verify: `npm test -- targets` (fetch mocked)
  - Files: `scripts/lib/targets.ts`, `tests/targets.test.ts`
  - Depends on: T-04

- [ ] **T-07 · `scripts/capture.ts`** → CP3, R2
  - Acceptance: launches pinned Chromium with R1 settings (deviceScaleFactor 1, reducedMotion,
    animations off); captures every target × state × viewport from `targets.ts` into
    `.visual-guard/runs/<id>/current/<target>/<state>@<viewport>.png`; **probes the target URL
    and fails fast** with a "start your dev server/storybook on :PORT" message when
    unreachable.
  - Verify: start sample Storybook → `npx tsx scripts/capture.ts --target Button` → PNGs present;
    **determinism gate:** capture twice → `diffImages` ratio 0
  - Files: `scripts/capture.ts`, (optional) `scripts/lib/browser.ts`
  - Depends on: T-06, T-03, T-05 (for the determinism check)

---

## Engine — diff orchestration + report

- [ ] **T-08 · `scripts/compare.ts`** → CP4
  - Acceptance: diffs a run's `current/` against `baselineDir`; writes `diff/<...>.png` per
    image and per-image results; a target with **no baseline** is reported as `new` (not an
    error); flags any image above `maxDiffRatio`.
  - Verify: run against a fixture run dir; a deliberately altered fixture is flagged, an
    unchanged one is not
  - Files: `scripts/compare.ts`
  - Depends on: T-05, T-07

- [ ] **T-09 · `scripts/report.ts` + golden test** → CP4, R6
  - Acceptance: assembles `manifest.json` = the subagent input contract (per-target: baseline
    / current / diff paths, `ratio`, `dimensionDelta`, `regions`, changed git files, verdict
    placeholder); snapshot/golden-tested so the contract can't drift silently.
  - Verify: `npm test -- report`
  - Files: `scripts/report.ts`, `tests/report.test.ts`
  - Depends on: T-08

---

## Commands (skills)

- [ ] **T-10 · `/visual-check` command**
  - Acceptance: skill runs the gather→act→verify loop — gather changed UI files via git +
    config, act = `capture.ts` → `compare.ts` → `report.ts`, present the `manifest.json`
    results with pixel numbers **and** a plain-language explanation (Phase 0: the main loop
    explains; the `visual-reviewer` subagent is wired in Phase 1); target arg optional
    (defaults to pending changes).
  - Verify: `claude plugin validate .`; manual `/visual-check Button` on the sample project
  - Files: `commands/visual-check.md`
  - Depends on: T-09

- [ ] **T-11 · `/visual-baseline` command**
  - Acceptance: copies a run's `current/` renders into `baselineDir` for the named target
    (the sign-off); confirms before overwriting an existing baseline; never runs
    automatically; writes only under `baselineDir`.
  - Verify: `/visual-baseline Button` → re-run `/visual-check Button` → 0 regressions
  - Files: `commands/visual-baseline.md`
  - Depends on: T-09

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
