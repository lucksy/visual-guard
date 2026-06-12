# Plan: Visual Guard — Technical Implementation Plan

> Phase 2 of spec-driven development. Reviewable companion to [SPEC.md](./SPEC.md).
> Status: **Draft for review** · Last updated: 2026-06-12
>
> This plan details **Phase 0 (MVP)** — the immediately buildable unit — and sketches the
> build order and risks for Phases 1–2. Do not start Phase 3 (Tasks) until this is approved.

---

## 1. Component dependency graph (Phase 0 MVP)

```
            ┌────────────────────────────┐
            │  A. Scaffolding            │  package.json · tsconfig · eslint/prettier
            │     + plugin.json manifest │  · directory skeleton · .gitignore
            └─────────────┬──────────────┘
                          │ (everything depends on A)
        ┌─────────────────┼───────────────────────────────┐
        ▼                 ▼                                ▼
┌───────────────┐  ┌──────────────────┐          ┌──────────────────────┐
│ B. config     │  │ H. install-deps  │          │ E. lib/diff.ts       │
│   visual.     │  │    .mjs          │          │   (PURE logic —      │
│   config.json │  │  + I. hooks.json │          │    pixelmatch/sharp) │
│  + lib/config │  │   (SessionStart) │          │   TDD from day one   │
└───────┬───────┘  └──────────────────┘          └──────────┬───────────┘
        │                                                    │
        ▼                                                    │
┌───────────────┐                                            │
│ C. lib/targets│  Storybook story discovery /               │
│    .ts        │  app route expansion (auto-detect)         │
└───────┬───────┘                                            │
        ▼                                                    │
┌───────────────┐                                            │
│ D. capture.ts │  Playwright; per target × state × viewport │
└───────┬───────┘                                            │
        │                                                    │
        └──────────────────────┬─────────────────────────────┘
                               ▼
                     ┌──────────────────┐
                     │ F. compare.ts    │  orchestrate diff: run/current vs baseline
                     └─────────┬────────┘
                               ▼
                     ┌──────────────────┐
                     │ G. report.ts     │  assemble manifest.json (subagent contract)
                     └─────────┬────────┘
                               ▼
              ┌────────────────┴────────────────┐
              ▼                                  ▼
   ┌────────────────────┐            ┌────────────────────────┐
   │ J. /visual-check   │            │ K. /visual-baseline    │
   │    command (skill) │            │    command (skill)     │
   └────────────────────┘            └────────────────────────┘
```

**Critical path:** `A → B → C → D → F → G → J → end-to-end verification`.
Everything else (`E`, `H+I`, `K`, tests) hangs off that spine and parallelizes against it.

---

## 2. Implementation order — sequential vs parallel

| Step | Component | Depends on | Can run in parallel with |
|---|---|---|---|
| 1 | **A.** Scaffolding + manifest | — | — (gate for everything) |
| 2 | **B.** config + `lib/config.ts` | A | H, E |
| 2 | **H+I.** `install-deps.mjs` + `hooks.json` (SessionStart) | A | B, E |
| 2 | **E.** `lib/diff.ts` (+ `diff.test.ts`) | A | B, H — *pure logic, no browser* |
| 3 | **C.** `lib/targets.ts` (+ `targets.test.ts`) | B | E (if still in flight) |
| 4 | **D.** `capture.ts` | C, H (Playwright installed) | — |
| 5 | **F.** `compare.ts` | D, E | — (convergence point) |
| 6 | **G.** `report.ts` (+ golden `report.test.ts`) | F | — |
| 7 | **J/K.** commands | G | each other |
| 8 | End-to-end verification | J, K | — |

**Three parallel tracks open after step 1:**
- **Track 1 (capture):** B → C → D
- **Track 2 (diff):** E — fully independent, pure, test-first, the lowest-risk highest-value start
- **Track 3 (plumbing):** H+I — get Playwright + deps landing into `${CLAUDE_PLUGIN_DATA}` early so D isn't blocked

> Recommended kickoff: **start Track 2 (diff.ts) and Track 3 (deps) immediately** while
> Track 1 builds. `diff.ts` is the algorithmic core and is testable with static PNG fixtures
> — no browser, no flake — so it de-risks the whole project on day one.

---

## 3. Risks & mitigations

| # | Risk | Severity | Mitigation | Proven by |
|---|---|---|---|---|
| R1 | **Anti-aliasing / font-rendering noise** produces false-positive diffs and non-portable baselines (Open Q #3) | **High** | Pin Playwright Chromium version; `deviceScaleFactor: 1`; disable animations/transitions/caret; `reducedMotion: "reduce"`; mask known-dynamic regions; `sharp` grayscale-normalize before diff; `pixelmatch({ includeAA: false })` + tuned `threshold`/`maxDiffRatio` | **CP3**: capture same component twice → ratio 0 |
| R2 | **Dev server not running** when capture starts | Med | Phase 0 does **not** manage server processes. `capture.ts` probes the target URL, and fails fast with an actionable message ("start your dev server / storybook on :PORT"). Auto-readiness is the Phase 2 monitor's job | CP3 (probe path) |
| R3 | **Storybook version differences** in story discovery (`index.json` vs legacy `stories.json`) | Med | Query `/index.json`, fall back to `/stories.json`; document supported Storybook ≥ 7; allow explicit story list in config to bypass discovery | `targets.test.ts` |
| R4 | **Playwright browser download** is large/slow/flaky in `install-deps.mjs` | Med | Install once into `${CLAUDE_PLUGIN_DATA}` using the docs' diff-package.json pattern; set `PLAYWRIGHT_BROWSERS_PATH=${CLAUDE_PLUGIN_DATA}/browsers`; on failure, leave no half-written marker so next session retries | CP1 + first real capture |
| R5 | **Baseline portability** across dev machines vs CI (downstream of R1) | Med | Same pins as R1; document that baselines are environment-scoped; Phase 2 adds containerized capture for CI parity | Re-run on second machine |
| R6 | **Subagent structured-output drift** breaks the command/workflow that consumes it (Phase 1) | Med | The manifest + verdict JSON is a versioned contract; golden-test `report.ts` output; subagent prompt says "return ONLY this JSON" | `report.test.ts` golden |
| R7 | **Dynamic workflow can't be bundled by a plugin** (Open Q #1) | Low | Ship a skill + workflow template; skill launches it via the Workflow tool and offers to save. Already reflected in SPEC | Phase 1 design review |
| R8 | **Hook latency** on every `Write/Edit` annoys users | Low | `detect-ui-change.mjs` is dependency-free, does only a glob match + append to `pending.json`, never captures. Capture is deferred to the checkpoint | Hook timing check |

R1 is the project's make-or-break. It gets a dedicated verification checkpoint (CP3) and
should be settled in Phase 0 before any baseline is trusted.

---

## 4. Verification checkpoints

| CP | After | Gate (must pass to proceed) |
|---|---|---|
| **CP1** | Scaffolding (A) + deps (H) | `claude plugin validate . --strict` passes · `npm run typecheck` clean · `install-deps.mjs` lands Playwright Chromium into `${CLAUDE_PLUGIN_DATA}` |
| **CP2** | `lib/diff.ts` (E) | Unit tests: identical images → ratio 0 · known-delta fixtures → expected ratio + dimension delta · undecodable input throws · ≥ 80% coverage on `lib/diff.ts` |
| **CP3** | `capture.ts` (D) | **Determinism gate (R1):** capture one sample component twice → diff ratio 0 · capture fails fast with a clear message when the server is down (R2) |
| **CP4** | `compare.ts` + `report.ts` (F,G) | `manifest.json` golden test passes · compare flags a deliberately altered fixture above `maxDiffRatio` |
| **CP5** | Commands (J,K) — **end-to-end** | Canonical flow: `/visual-check Button` on unchanged code → 0 regressions → make a real change → regression surfaced with file:line → `/visual-baseline Button` → re-run → clean |

---

## 5. Phase 1 — build order (sketch)

Sequence (each builds on Phase 0 engine output):
1. **`visual-reviewer` subagent** — consumes `manifest.json`, returns the verdict JSON.
   Wire `/visual-check` to invoke it after `compare.ts`. *Verify:* deliberate change →
   correct classification + cited file:line.
2. **`token-auditor` subagent + token-drift** — Grep the git diff for hardcoded values that
   equal a known token value (`tokens.source`). *Verify:* `var(--space-md)` → `14px` flagged
   even at sub-threshold pixel delta (Success Criterion).
3. **Hooks: `PostToolUse` (detect) + `Stop` (nudge)** — append to `pending.json`; nudge if
   pending at turn end. *Verify:* editing a UI file marks pending; non-UI edit does not.
4. **`/visual-review` dynamic workflow** — `pipeline(targets, capture→diff→review)` fan-out,
   then an adversarial-verify stage where a second agent tries to refute each finding before
   it's reported; synthesize one report. *Verify:* multi-component run returns only verified
   findings.

**Phase 1 risks:** R6 (output drift), workflow cost/concurrency (cap targets per run, log
anything dropped), classification quality (eval prompts + manual spot-check, not unit tests).

---

## 6. Phase 2 — build order (sketch)
1. **`dev-server` monitor** (`when: on-skill-invoke:visual-check`) — tail server/Storybook
   log so capture waits for readiness and reacts to render errors (closes R2 fully).
2. **`/visual-coverage`** — state × component map with gaps, derived from baselines + config.
3. **PR comment generator** — render the report as Markdown for a PR.
4. **CI mode** — `claude -p` non-interactive run; exit non-zero on unapproved regressions;
   containerized capture for baseline parity (closes R5).

---

## 7. What I need before Phase 3 (Tasks)
- **Approve this plan**, or adjust order/risks.
- Ideally settle **Open Q #3** (AA/normalization strategy) and **Q #4** (token source format)
  now — they shape `diff.ts` (CP2/CP3) and `token-auditor` respectively. They can also be
  decided at their checkpoints, but deciding R1's approach before writing `diff.ts` saves rework.

On approval I'll produce **Phase 3: Tasks** — discrete, individually verifiable units (each
≤ ~5 files, with acceptance + verify steps), ordered by the dependency graph above.
