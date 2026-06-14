# Visual Guard

> AI visual regression reviewer — a Claude Code plugin. Give every UI change a visual review
> before it merges. Inspired by Chromatic's visual tests, but **agent-native**: built around
> Claude Code's commands, subagents, hooks, and dynamic workflows.

Visual Guard detects UI code changes, renders the affected components/pages with a pinned
headless Chromium, pixel-diffs them against an approved baseline, and explains what changed —
with a deliberate, local **sign-off** workflow to approve new baselines. No one has to eyeball
screenshots by hand.

**Phase 0 (MVP)** delivers deterministic capture + diff, the `/visual-check` and
`/visual-baseline` commands, and the one-time engine bootstrap. **Phase 1 (agent-native depth)**
adds the structured `visual-reviewer` subagent, a `token-auditor` for design-token drift,
`PostToolUse`/`Stop` checkpoint hooks, and the `/visual-review` fan-out workflow that
adversarially verifies each finding — see the [Phase 1 flow](#phase-1--agent-native-review) below
and the [Roadmap](#roadmap).

---

## The canonical flow

```text
> Update the Button component to support a larger touch target

Running Visual Guard…
Changed UI files:  src/Button.css
Capturing: button [default] @ [400]
Comparing against baseline…

⚠️  Visual change detected — button
  changed pixels: 11,464 / 360,000  (3.18%, gate 1.00%)
  cause: src/Button.css — `padding: var(--vg-space-pad)` replaced by a hardcoded `48px 40px`
  the button grew taller; spacing no longer tracks the design token

Approve as new baseline?  →  /visual-baseline button
```

If the change is intended, approve it:

```text
> /visual-baseline button
Approve 1 render from run 20260613-180659 as the baseline for `button`?  yes
✓ wrote .visual-baselines/sample/button/default@400.png  (commit it to share with the team)

> /visual-check button
✓ button — 0 regressions
```

A runnable version of exactly this flow lives in
[`tests/e2e/sample/`](tests/e2e/sample/) and is asserted end-to-end by
[`tests/e2e/canonical-flow.e2e.test.ts`](tests/e2e/canonical-flow.e2e.test.ts).

---

## Phase 1 — agent-native review

Phase 1 turns the pixel numbers into a **structured, verified verdict** and catches regressions
the pixels can't see.

**Structured verdict.** When `/visual-check` flags a target, it invokes the read-only
`visual-reviewer` subagent per changed image. The reviewer opens the baseline/current/diff PNGs,
reads the changed source, and — when a diff is ambiguous — **re-renders the live element** via the
Playwright MCP before deciding. It returns a typed verdict that is merged back into `manifest.json`:

```text
⚠️  button — fail (3.18%)
  classification: design-system-violation
  cause:  src/Button.css:12 — padding: 48px 40px replaces var(--vg-space-pad)
  impact: off-system spacing · taller button
  fix:    restore padding: var(--vg-space-pad)
```

**Token drift the pixels miss.** The `token-auditor` flags a hardcoded value that inlines a design
token **even when the pixel delta is below the gate** — e.g. a `--vg-brand` color written as its
identical hex moves zero pixels (the screenshot diff says `pass`) yet is still a design-system
regression. This is the Phase-1 exit criterion, proven end-to-end in
[`tests/e2e/review-flow.e2e.test.ts`](tests/e2e/review-flow.e2e.test.ts) (CP6).

**Fan-out review.** `/visual-review` launches a **dynamic workflow** that fans review out across
many components × viewports (the `visual-reviewer` + `token-auditor` subagents), **adversarially
verifies each finding** with independent skeptics behind a majority gate, and synthesizes **one**
report — so only independently-verified findings reach you. Plugins can't bundle a workflow, so it
ships as a skill ([`skills/visual-review/`](skills/visual-review/)) that launches the bundled
template and offers to save it as `/visual-review`.

**Checkpoint hooks.** A `PostToolUse` hook records edited UI files into `.visual-guard/pending.json`
(detection only — never a capture in the hook), and a `Stop` hook nudges you to run `/visual-check`
if anything is pending.

---

## Phase 2 — operations & CI

Phase 2 makes Visual Guard a pipeline gate and adds the operational tooling around it.

**CI gate (deterministic non-zero exit).** `scripts/ci.ts` turns a run's `manifest.json` into a
pass/fail decision and a process exit code, so a pipeline fails on an **unapproved** regression.
A `fail` (pixel/dimension regression) always blocks; a `new` render (no baseline = unapproved) and
an `error` (undecodable) block by default and can be relaxed with `--allow-new` / `--allow-error`.

```bash
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"; S="${CLAUDE_PLUGIN_ROOT}/scripts"
export PLAYWRIGHT_BROWSERS_PATH="${CLAUDE_PLUGIN_DATA}/browsers"
"$RUNNER" "$S/capture.ts" --config "$CONFIG" --run "$RUN_ID" \
  && "$RUNNER" "$S/compare.ts" --config "$CONFIG" --run "$RUN_ID" \
  && "$RUNNER" "$S/report.ts"  --config "$CONFIG" --run "$RUN_ID"
"$RUNNER" "$S/ci.ts" --run "$RUN_ID"      # exit 0 = clean · 1 = unapproved regressions · 2 = could not run
```

> A `claude -p` headless run does **not** auto-exit non-zero when a check fails, so the
> authoritative gate is `ci.ts`'s own exit code — that is what fails the pipeline. `/visual-ci`
> orchestrates the same steps interactively and reports the result.

**PR-comment generator.** `scripts/pr-report.ts` renders the run as Markdown (a summary table plus
evidence-then-verdict per flagged target) to `.visual-guard/runs/<id>/pr-comment.md`. Visual Guard
**generates, never posts** — everything stays local; your CI posts it:
`gh pr comment "$PR" -F .visual-guard/runs/$RUN_ID/pr-comment.md`.

**Coverage map.** `/visual-coverage` crosses the config's resolved render grid (the same expansion
capture uses) with the committed baselines to show, per component, which `state@viewport` cells are
covered, which are **gaps** (a regression could slip through there), and which baselines are
**orphans** (on disk but no longer in config).

**Readiness monitor.** `monitors/monitors.json` registers a `dev-server-readiness` monitor
(`when: on-skill-invoke:visual-check`) that polls each configured target's reachability and health
(Storybook `/index.json` story count; app route status) and reports each status transition. It is
read-only and non-gating — `capture.ts`'s origin probe stays the hard fail-fast; the monitor just
gives continuous visibility so a check isn't run blind against a down or erroring server.

---

## Install

### Install from the marketplace

Visual Guard ships as a standard Claude Code plugin. From inside Claude Code, add the marketplace
and install it:

```text
/plugin marketplace add lucksy/visual-guard
/plugin install visual-guard@lucksy
```

Then scaffold a project-specific config and run your first check:

```text
/visual-init     # probe your dev servers + tokens, write visual.config.json
/visual-check    # capture → pixel-diff → explain
```

`/visual-init` detects your running Storybook / dev server and design-token files and writes a
working `visual.config.json`, so the first `/visual-check` runs against *your* project instead of
the sample defaults. It never overwrites an existing config without `--force`.

### Local development

Or point Claude Code at this directory:

```bash
claude --plugin-dir /path/to/visual-check
```

On the **first session**, a `SessionStart` hook bootstraps the engine: it installs the runtime
dependencies (`playwright`, `pixelmatch`, `sharp`, `pngjs`) and the `tsx` runner plus a pinned
Chromium into the plugin's persistent data dir (`${CLAUDE_PLUGIN_DATA}`), then bridges them to
the plugin root so the bundled scripts are runnable. Nothing heavy is committed to the repo.

- It is **idempotent**: subsequent sessions are a no-op once the deps and browser are present.
- A **failed** install leaves no "installed" marker, so the next session retries cleanly.
- If a command reports the engine isn't bootstrapped, start a fresh session (or share the
  `SessionStart` hook output if it keeps failing).

You also need a **running target** to capture against — a Storybook (default `:6006`) or a dev
server with known routes — before running `/visual-check`.

---

## Configuration

Visual Guard reads the first config it finds: `visual.config.json`,
`config/visual.config.json`, else the bundled default
([`config/visual.config.json`](config/visual.config.json)).

```json
{
  "detect": "auto",
  "targets": [
    { "type": "storybook", "url": "http://localhost:6006" },
    { "type": "app", "url": "http://localhost:3000", "routes": ["/login", "/checkout"] }
  ],
  "viewports": [375, 768, 1280],
  "states": ["default", "hover", "disabled"],
  "threshold": 0.1,
  "maxDiffRatio": 0.01,
  "baselineDir": ".visual-baselines",
  "uiGlobs": ["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss}"],
  "tokens": { "source": "src/styles/tokens.css" }
}
```

| Field | Meaning |
|---|---|
| `targets` | One or more Storybook or app instances. Each may carry a `name`; otherwise its instance label is derived from `host:port`. Labels must be unique. |
| `viewports` | Widths (px) to capture each target at. |
| `states` | App states realized via Playwright (e.g. `hover`). For **Storybook**, the story name *is* the state, so stories expand by viewport only. |
| `threshold` | Per-pixel match tolerance passed to `pixelmatch` (0–1). |
| `maxDiffRatio` | The gate: a render with a greater changed-pixel ratio — **or any dimension change** — is flagged `fail`. |
| `baselineDir` | Where approved baselines live (commit these). |
| `uiGlobs` | Which changed files count as "UI" when tagging targets with their related changes. |
| `tokens.source` | Design-token source (used by the Phase 1 token auditor). |

Render artifacts are always nested by instance:
`<instance>/<target>/<state>@<viewport>.png` — so two instances exposing the same component
never collide, and baselines are stable as instances are added.

---

## Commands

| Command | What it does |
|---|---|
| `/visual-init` | Scaffold a `visual.config.json` for this project — probes your dev servers / Storybook, detects design-token files, and writes a working config so the first `/visual-check` just works. Never clobbers an existing config without `--force`. |
| `/visual-check [target]` | Capture → pixel-diff → explain. With no target, captures **all** configured targets and tags each with its related changed files. |
| `/visual-baseline [target]` | Approve the latest run's renders as the new committed baseline (the sign-off). Previews first, confirms before any overwrite, and writes only under `baselineDir`. |
| `/visual-review` | **[Phase 1]** Fan-out review across many components/viewports, with each finding adversarially verified before it's reported. |
| `/visual-coverage` | **[Phase 2]** The component × state coverage map — covered cells, gaps (expected but unbaselined), and orphan baselines. |
| `/visual-ci` | **[Phase 2]** Run the full gate (capture → diff → report → CI gate) and generate a PR-comment Markdown report. The deterministic non-zero exit for CI comes from `scripts/ci.ts`. |

The engine the commands orchestrate is also runnable directly:

```bash
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
export PLAYWRIGHT_BROWSERS_PATH="${CLAUDE_PLUGIN_DATA}/browsers"
"$RUNNER" scripts/capture.ts --config <cfg> --run <id> [--target <name>]
"$RUNNER" scripts/compare.ts --config <cfg> --run <id>
"$RUNNER" scripts/report.ts  --config <cfg> --run <id>
"$RUNNER" scripts/baseline.ts --config <cfg> [--target <name>] [--dry-run] [--overwrite --confirmed]
```

---

## How it works

1. **Capture** (`scripts/capture.ts`) — resolves the config into individual renders
   (auto-discovering Storybook stories via `/index.json`, expanding app routes × viewports ×
   states), fails fast with an actionable message if a target server is unreachable, then
   screenshots each render with Playwright.
2. **Compare** (`scripts/compare.ts`) — diffs each render against its baseline, writes a diff
   PNG per image, and flags any render over `maxDiffRatio` (or with a dimension change) as
   `fail`. A render with no baseline is reported as `new`, not an error.
3. **Report** (`scripts/report.ts`) — assembles `manifest.json`, the machine-readable contract
   that ties each target to its pixel evidence and its related changed git files.

### Determinism

Capture pins a single Chromium, `deviceScaleFactor: 1`, `prefers-reduced-motion: reduce`,
`colorScheme: light`, freezes animations/transitions **before** page load, and waits for fonts
and images to settle — so the same component captured twice yields byte-identical pixels and
baselines are portable across machines. Images are **grayscale/luminance-normalized** before
diffing to suppress cross-machine anti-aliasing and subpixel color noise. A consequence worth
knowing: a change that alters **geometry, spacing, or luminance** is detected, while a recolor
that *preserves luminance* by design is not (that nuance is the Phase 1 reviewer's job).

> JS-animation libraries (Framer Motion, GSAP, …) only settle deterministically if they honor
> `prefers-reduced-motion`; fixtures must not render live timestamps or `Math.random()` content.

---

## Boundaries

- **Read-only on your source.** `/visual-check` never edits a file to make a check pass.
- **Sign-off is deliberate.** Baselines are only ever written by an explicit `/visual-baseline`,
  never automatically, and only under `baselineDir`.
- **Everything is local.** No screenshot is sent to any external service.
- **Evidence before verdict.** Pixel numbers and the explanation are always shown together.

Baselines (`baselineDir`) are committed to version control so the whole team shares one source
of truth. Transient run artifacts go to `.visual-guard/` (gitignored).

---

## Development

```bash
npm test                 # vitest, all suites
npm test -- --coverage   # ≥80% gate on scripts/lib (the pure logic)
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
claude plugin validate . --strict

# Opt-in integration tests that launch real Chromium (skipped by default):
VG_E2E=1 npx vitest run capture.e2e        # the determinism gate (CP3)
VG_E2E=1 npx vitest run canonical-flow     # the full canonical flow (CP5)
VG_E2E=1 npx vitest run review-flow        # the Phase-1 fan-out exit (CP6)
VG_E2E=1 npx vitest run ci-flow            # the Phase-2 CI gate + PR report (CP7)
```

The pure pixel/diff/target/config/token logic in `scripts/lib/` is unit-tested and coverage-gated;
the manifest + verdict contracts are golden/contract-tested; the subagent prompts and the
`/visual-review` workflow template are pinned by contract/structure tests; Playwright capture and
the canonical + review flows are covered by the opt-in `VG_E2E` integration tests.

---

## Roadmap

- **Phase 0 — MVP (shipped):** deterministic capture + diff, `/visual-check`,
  `/visual-baseline`, the `SessionStart` engine bootstrap.
- **Phase 1 — Agent-native depth (shipped):** the read-only `visual-reviewer` subagent (classify ·
  explain · cite cause · recommend fix, deep-probing live elements via MCP), a `token-auditor`
  for design-token drift (catches a hardcoded value replacing a token even when pixels don't
  move), `PostToolUse`/`Stop` hooks for checkpoint triggering, and the `/visual-review` fan-out
  workflow that adversarially verifies each finding.
- **Phase 2 — Operations (shipped):** a dev-server/Storybook readiness **monitor**
  (`monitors/monitors.json`), the **`/visual-coverage`** map (state × component, with gaps and
  orphan baselines), a **PR-comment generator** (`scripts/pr-report.ts` — generates Markdown
  locally; your CI posts it), and a non-interactive **CI gate** (`scripts/ci.ts`) that exits
  non-zero on unapproved regressions. See the [Phase 2 flow](#phase-2--operations--ci) below.

See [`SPEC.md`](SPEC.md) for the full design and [`TASKS.md`](TASKS.md) for the build log.

## License

MIT
