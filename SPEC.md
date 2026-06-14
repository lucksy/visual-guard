# Spec: Visual Guard — AI Visual Regression Reviewer (Claude Code Plugin)

> Status: **Draft for review** · Owner: @systergon · Last updated: 2026-06-12
> A Claude Code plugin that gives every UI change a visual review before it merges.
> Inspired by Chromatic's visual tests, but **agent-native**: one powerful feature (UI
> regression review) reimagined around Claude Code's subagents, dynamic workflows,
> hooks, and monitors.

---

## Assumptions

These were chosen to proceed. **Correct any that are wrong before implementation.**

1. **Distribution**: ships as a standard Claude Code plugin (`.claude-plugin/plugin.json`), installable from a marketplace or via `--plugin-dir`. Plugin name `visual-guard`; this repo (`visual-check/`) is the development root.
2. **Runtime**: Node.js ≥ 20 with TypeScript run directly via `tsx` (no compile step). Engine deps (`playwright`, `pixelmatch`, `sharp`, `pngjs`) are installed once into `${CLAUDE_PLUGIN_DATA}` by a `SessionStart` hook, not committed.
3. **Target projects**: web frontends (React/Vue/Svelte/etc.) that expose either a **Storybook** (default `:6006`) or a running **dev server** with known routes. Native mobile is out of scope.
4. **Baselines live in the consuming repo** under `.visual-baselines/`, committed to version control so the whole team shares the same source of truth. Transient run artifacts go to `.visual-guard/` (gitignored).
5. **Decided in clarification** (see Open Questions for the reasoning trail):
   - Render target: **auto-detect** Storybook, fall back to app + route map.
   - Engine: **hybrid** — bundled scripts do deterministic pixel diff (the numeric gate); the `visual-reviewer` subagent uses Playwright/Chrome-DevTools MCP for deep probing.
   - Trigger: **hook flags** UI edits as "pending review"; full capture runs at a **checkpoint** (`/visual-check` or pre-commit), not on every keystroke.
   - Ambition: **full phased architecture** (Phase 0 MVP → Phase 1 → Phase 2).

---

## Objective

### What we're building
A plugin that detects UI code changes, renders the affected components/pages, captures
screenshots, pixel-diffs them against an approved baseline, and then has an AI reviewer
**explain** each visual difference, **classify** it (intentional / bug / design-system
violation), and **recommend a fix** — with a local sign-off workflow to approve new
baselines. No human has to eyeball screenshots manually.

### Why
UI regressions (spacing drift, broken responsive layouts, theme contrast loss, design-token
violations) slip through code review because diffs show *code*, not *pixels*. As AI agents
increasingly author UI code, an automated visual gate becomes the safety net that keeps
unintended visual change from merging.

### Who the user is
- **Primary**: a developer (or an AI agent) editing UI in a project with a design system.
- **Secondary**: a reviewer who wants a structured "what changed visually and is it OK?"
  report instead of opening a browser.

### Success looks like
The canonical flow runs end-to-end without manual screenshotting:

```
> Update the Button component to support a loading state

Running Visual Guard…
Changed UI files:  Button.tsx · button.css
Capturing: Button [default · hover · disabled · loading] @ [375 · 1280]
Comparing against baseline…

⚠️  Visual change detected — Button
  height 32px → 36px  (padding-y increased)
  classification: design-system violation (medium)
  cause: hardcoded `padding: 14px` replaces `var(--space-md)`
  impact: Login, Checkout, Settings pages use <Button>
  fix: restore the spacing token  →  padding: var(--space-md)

Approve as new baseline?  /visual-baseline Button
```

### Reframed success criteria (testable)
- A run on an **unchanged** component reports **0 regressions** (no false positives above
  the configured pixel threshold).
- A run on a component with a **deliberate** visual change surfaces it, classifies it, and
  cites the file:line cause — and `/visual-baseline` accepts it so the next run is clean.
- A **hardcoded value replacing a design token** is flagged even when the pixel delta is
  below threshold (token-drift catches what pixels miss).
- A full review of **N components** completes via a dynamic workflow whose findings have
  each been independently verified before they're reported (no unverified noise).
- Engine capture + diff for one component across its states/viewports completes in **< 30s**
  on a warm dev server.

---

## Tech Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript (ESM), run via `tsx` | No build step; scripts executed directly |
| Runtime | Node.js ≥ 20 | |
| Browser / capture | `playwright` (Chromium) | Bundled script; deterministic capture |
| Pixel diff | `pixelmatch` + `pngjs` | Numeric per-pixel delta + changed-region boxes |
| Image normalize | `sharp` | Decode, resize/align, anti-alias normalization |
| Tests | `vitest` | TS-native, fast, fixture-image friendly |
| Lint / format | `eslint` + `prettier` | |
| Deep visual probe | Playwright MCP / Chrome-DevTools MCP | Used *by the subagent*, not bundled |
| Orchestration | Claude Code: subagents, dynamic workflows, hooks, monitors | See "Claude Code Feature Map" |

---

## Claude Code Feature Map

This is the heart of the design — each capability maps to a current Claude Code primitive
(verified against the June 2026 docs: Workflows, Sub-agents, Plugins reference, Agent loop).

| Capability | Claude Code primitive | File |
|---|---|---|
| `/visual-check`, `/visual-baseline` | **Skills/commands** (`/name` shortcuts) | `commands/*.md` |
| AI reviewer (classify + explain + fix) | **Subagent** (read-only, own context, returns structured verdict) | `agents/visual-reviewer.md` |
| Token-drift detection | **Subagent** (lightweight, Grep over git diff) | `agents/token-auditor.md` |
| Detect UI edits → mark "pending review" | **Hook** `PostToolUse` matcher `Write\|Edit` (`command`) | `hooks/hooks.json` |
| Nudge before finishing if reviews pending | **Hook** `Stop` (`prompt`) | `hooks/hooks.json` |
| Install engine deps once, refresh on update | **Hook** `SessionStart` (`command`) | `hooks/hooks.json` |
| Fan-out review across many components/viewports, adversarially verify findings, synthesize one report | **Dynamic workflow** (JS script, `parallel`/`pipeline`/`phase`), launched by a skill | `skills/visual-review/` + `.claude/workflows/` |
| Watch dev-server / Storybook readiness & render errors | **Monitor** (`when: on-skill-invoke:visual-check`) | `monitors/monitors.json` |
| capture → diff → explain → fix → re-verify | **Agent loop** (`maxTurns`, `effort` on the subagent) | subagent frontmatter |

> **Workflow integration note.** Dynamic workflows are project-scoped scripts saved under
> `.claude/workflows/`, not a packaged plugin component. So the plugin ships a **skill**
> (`/visual-review`) plus a workflow **script template**; invoking the skill instructs Claude
> to launch that template as a dynamic workflow (and offer to `s`ave it as `/visual-review`
> for reuse). This keeps us honest about what a plugin can and cannot bundle.

---

## Commands

### Plugin-provided slash commands (what users type)
```
/visual-check [target]      Capture → pixel-diff → AI review the target (or all pending UI changes)
/visual-baseline [target]   Approve current render(s) as the new baseline ("sign-off")
/visual-review              [Phase 1] Launch the fan-out dynamic workflow across many targets
/visual-coverage            [Phase 2] Print the component × state coverage map
```

### Developer / engine commands (full, executable)
```bash
# One-time / on plugin update — bootstrap engine deps into the persistent data dir
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"     # invoked by SessionStart hook

# Capture screenshots for a target (writes PNGs into .visual-guard/runs/<id>/current/)
npx tsx scripts/capture.ts --target Button --config config/visual.config.json

# Compare a run against baseline (writes diff PNGs + diff.json)
npx tsx scripts/compare.ts --run <id> --baseline .visual-baselines

# Assemble the machine-readable run manifest the reviewer subagent consumes
npx tsx scripts/report.ts --run <id>

# Quality gates
npm test                    # vitest, all suites
npm test -- --coverage      # with coverage report
npm run lint                # eslint
npm run lint:fix            # eslint --fix
npm run format              # prettier --write
npm run typecheck           # tsc --noEmit

# Plugin validation (CI gate before publishing)
claude plugin validate . --strict
```

---

## Project Structure

```
visual-guard/                        # plugin root (dev root: visual-check/)
├── .claude-plugin/
│   └── plugin.json                  # manifest (name, version, component paths, userConfig)
│
├── commands/                        # Skills as flat .md → /name shortcuts
│   ├── visual-check.md              # Phase 0
│   └── visual-baseline.md           # Phase 0
│
├── skills/
│   ├── visual-review/               # Phase 1 — launches the dynamic workflow
│   │   ├── SKILL.md
│   │   └── workflow.template.js     # fan-out script template (parallel + adversarial verify)
│   └── visual-coverage/             # Phase 2
│       └── SKILL.md
│
├── agents/                          # Plugin-shipped subagents
│   ├── visual-reviewer.md           # Phase 0/1 — classify + explain + fix (read-only)
│   └── token-auditor.md             # Phase 1 — design-token drift over git diff
│
├── hooks/
│   └── hooks.json                   # SessionStart (deps) · PostToolUse (detect) · Stop (nudge)
│
├── monitors/
│   └── monitors.json                # Phase 2 — dev-server / storybook log watcher
│
├── scripts/                         # The deterministic engine (TypeScript via tsx)
│   ├── capture.ts                   # Playwright; auto-detect Storybook vs app routes
│   ├── compare.ts                   # pixelmatch + sharp → diff.png + diff.json
│   ├── report.ts                    # assemble run manifest for the subagent
│   ├── detect-ui-change.mjs         # PostToolUse hook script (fast, no deps)
│   ├── install-deps.mjs             # SessionStart dep bootstrap into ${CLAUDE_PLUGIN_DATA}
│   └── lib/
│       ├── config.ts                # load + validate visual.config.json
│       ├── targets.ts               # Storybook story discovery / app route expansion
│       └── diff.ts                  # pixel-diff + dimension-delta + region extraction
│
├── config/
│   └── visual.config.json           # default config (overridable per project)
│
├── tests/
│   ├── diff.test.ts                 # pixel diff thresholds, dimension deltas (fixtures)
│   ├── targets.test.ts              # story/route expansion
│   ├── report.test.ts               # manifest shape (golden)
│   └── fixtures/                    # baseline/current/diff PNG fixtures
│
├── package.json
├── tsconfig.json
├── CHANGELOG.md
├── LICENSE
└── SPEC.md                          # this file

# --- Created inside the *consuming* project, not the plugin ---
.visual-baselines/<instance>/<target>/<state>@<viewport>.png  # committed approved baselines
.visual-guard/runs/<id>/current/<instance>/<target>/<state>@<viewport>.png  # transient renders (gitignored)
.visual-guard/runs/<id>/{diff,manifest.json}        # transient run output (gitignored)
.visual-guard/pending.json                          # "needs review" markers from the hook
```

---

## Code Style

One example per layer beats prose. Match these when implementing.

### Engine (TypeScript, ESM, `tsx`)
- Named exports, explicit return types on exported functions, `camelCase` functions /
  `PascalCase` types. No default exports. Side-effect-free `lib/` modules; CLI entrypoints
  do the I/O. Fail fast with actionable errors (never swallow).

```ts
// scripts/lib/diff.ts
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export interface DiffResult {
  changedPixels: number;
  totalPixels: number;
  ratio: number;                 // 0..1 — gate against config.threshold
  dimensionDelta: { width: number; height: number } | null;
  regions: BoundingBox[];        // clustered changed areas, for the reviewer to focus on
}

/** Compare two same-state renders. Throws on undecodable input — never returns a guess. */
export function diffImages(baseline: PNG, current: PNG, threshold: number): DiffResult {
  const dimensionDelta =
    baseline.width !== current.width || baseline.height !== current.height
      ? { width: current.width - baseline.width, height: current.height - baseline.height }
      : null;

  const { width, height } = baseline;
  const diff = new PNG({ width, height });
  const changedPixels = pixelmatch(
    baseline.data, current.data, diff.data, width, height,
    { threshold, includeAA: false },
  );

  const totalPixels = width * height;
  return {
    changedPixels,
    totalPixels,
    ratio: changedPixels / totalPixels,
    dimensionDelta,
    regions: clusterChangedRegions(diff),
  };
}
```

### Subagent (the contract that makes findings trustworthy)
The reviewer is **read-only** (no `Write`/`Edit`) and returns a **structured verdict**, so
its output is data the command/workflow can act on — not prose to re-parse.

```markdown
---
name: visual-reviewer
description: Reviews a screenshot diff and decides if a UI change is intentional, a bug, or a
  design-system violation. Invoke after capture+compare produce a diff manifest.
model: sonnet
effort: high
maxTurns: 15
tools: Read, Grep, Bash, mcp__playwright__playwright_navigate, mcp__playwright__playwright_screenshot
disallowedTools: Write, Edit
---

You are a UI regression reviewer. You are given a diff manifest (baseline PNG, current PNG,
diff PNG, pixel ratio, dimension deltas, changed regions), the relevant git diff, and the
component source.

For each changed target, classify the change as one of: `intentional`, `bug`,
`design-system-violation`. Check spacing/tokens, typography, color & contrast (WCAG),
responsive behavior, and dark/light consistency. When pixels are ambiguous, use the
Playwright MCP tools to re-render and probe the live element before deciding.

Return ONLY a JSON array — one self-addressing object per changed image (the typed `Verdict`
plus `target`/`state`/`viewport` identifiers = `VerdictReport`; the engine routes each back to
its image and stores the 8-field `Verdict`). `state`/`viewport` are null for a source-level
finding (token-auditor).
[{ "target": "Button", "state": "default", "viewport": 1280,
   "severity": "low|medium|high", "classification": "...",
   "issue": "...", "file": "src/Button.tsx", "line": 42,
   "cause": "...", "impact": ["..."], "fix": "..." }]
```

### Hook config
```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write|Edit",
        "hooks": [{ "type": "command",
          "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/detect-ui-change.mjs\"" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command",
          "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs\"" }] }
    ]
  }
}
```

### Config (`config/visual.config.json`)
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

---

## Testing Strategy

- **Framework**: `vitest`. Tests in `tests/`, mirroring `scripts/` module names.
- **Unit (core, must be deterministic)** — `lib/diff.ts`: identical images → ratio 0;
  known-delta fixtures → expected ratio and dimension deltas; threshold boundary cases;
  undecodable input throws. `lib/targets.ts`: story-id and route → URL expansion.
- **Contract/golden** — `report.ts` manifest shape is snapshot-tested so the subagent's
  input contract can't drift silently.
- **Integration (gated, opt-in)** — capture a tiny bundled Storybook fixture with real
  Playwright; assert PNGs land and a no-op change yields 0 regressions. Skipped in
  environments without browsers (`VG_E2E=1` to enable).
- **Plugin self-validation** — `claude plugin validate . --strict` runs in CI alongside tests.
- **Coverage**: ≥ 80% on `scripts/lib/` (the pure logic). Capture/CLI glue and subagent
  prompts are covered by integration + manual review, not coverage %.
- **Test levels by concern**: pixel math → unit; target discovery → unit; manifest contract
  → golden; end-to-end capture → integration; AI classification quality → eval prompts +
  manual spot-check (not unit-tested).

---

## Boundaries

### Always do
- Run `npm test`, `npm run typecheck`, and `claude plugin validate . --strict` before
  marking a phase complete.
- Use `${CLAUDE_PLUGIN_ROOT}` for bundled paths and `${CLAUDE_PLUGIN_DATA}` for installed
  deps / caches; never hardcode absolute paths.
- Keep the `visual-reviewer` subagent **read-only** (no `Write`/`Edit`); it recommends fixes,
  it does not apply them.
- Write baselines only under the configured `baselineDir`; write run artifacts only under
  `.visual-guard/` (gitignored).
- Surface pixel-diff numbers AND the AI explanation together — evidence before verdict.

### Ask first
- Adding any runtime dependency beyond playwright / pixelmatch / sharp / pngjs.
- Changing the subagent's structured-output JSON contract (it's an interface).
- Changing default config thresholds (`threshold`, `maxDiffRatio`) or `uiGlobs`.
- Enabling auto-capture on every edit (vs. the agreed checkpoint trigger) — it forces a
  running dev server and adds cost to each edit.
- Anything that writes outside the plugin root or the consuming project's `.visual-*` dirs.

### Never do
- Auto-approve / overwrite baselines without an explicit `/visual-baseline` (an approved
  baseline is a deliberate human/agent sign-off).
- Commit `node_modules`, run artifacts, or `${CLAUDE_PLUGIN_DATA}` contents.
- Let the reviewer edit source files, delete failing visual checks to "make it pass," or
  report a finding it could not verify.
- Send screenshots to any external service (all capture/diff is local).
- Block the user's main turn on screenshot capture inside a `PostToolUse` hook (detection
  only — capture happens at the checkpoint).

---

## Phased Delivery

### Phase 0 — MVP (the brief's 2-week scope)
Playwright capture (auto-detect Storybook → app) · baseline storage & `/visual-baseline` ·
`pixelmatch`+`sharp` diff with numeric gate · `/visual-check` command that runs
capture→diff and has Claude explain the result · `SessionStart` dep bootstrap.
**Exit:** the canonical Button flow above runs end-to-end on a sample project.

### Phase 1 — Agent-native depth
`visual-reviewer` subagent (structured verdict, deep-probe via MCP) · `token-auditor`
subagent + token-drift detection · `PostToolUse`/`Stop` hooks for checkpoint triggering ·
`/visual-review` dynamic workflow that fans out across components/viewports and
**adversarially verifies** each finding before reporting.
**Exit:** a multi-component review returns only verified findings, in one synthesized report.

### Phase 2 — Operations & reporting
`dev-server` monitor · `/visual-coverage` map (state × component, with gaps) · PR comment
generator · `claude -p` / CI mode (non-interactive, exits non-zero on unapproved regressions).
**Exit:** Visual Guard can gate a CI pipeline and post a PR report.

---

## Success Criteria (definition of done, per the Objective)
- [ ] Unchanged component → 0 regressions (no false positives above threshold).
- [ ] Deliberate change → surfaced, classified, file:line cause cited; `/visual-baseline`
      clears it on the next run.
- [ ] Token replaced by a hardcoded value → flagged even when pixel delta < threshold.
- [ ] `/visual-review` returns only findings that passed independent verification.
- [ ] One component (all states × viewports) captures + diffs in < 30s on a warm server.
- [ ] `npm test` green, ≥ 80% coverage on `scripts/lib/`, `claude plugin validate --strict` passes.

---

## Open Questions
1. **Workflow packaging**: confirm the skill-launches-a-workflow-template approach (above) vs.
   shipping a pre-saved `.claude/workflows/visual-review.js` in consuming repos. Plugins can't
   bundle workflows directly today — is the skill+template indirection acceptable?
2. **Interaction states** (`hover`, `focus`, `loading`): driven via Storybook story args, or
   via Playwright actions on the app? Affects how `states` in config is interpreted.
3. **Anti-aliasing / font-rendering noise** across OSes — do we pin a Playwright Chromium
   version and a fixed device-scale-factor, or normalize via `sharp` before diffing? (Impacts
   false-positive rate and whether baselines are portable across machines/CI.)
4. **Token source format**: CSS custom properties only, or also `tokens.json` / Style
   Dictionary / Tailwind theme? The `token-auditor` needs one canonical source per project.
5. **Marketplace vs. local**: publish to a marketplace, or distribute via `--plugin-dir` for now?

---

## Next Steps (gated workflow)
This is **Phase 1: Specify**. On approval, proceed to **Phase 2: Plan** (component build order,
risks, what's parallelizable) → **Phase 3: Tasks** (discrete, verifiable units) →
**Phase 4: Implement** (incremental + test-driven). Do not start implementation until this spec
is approved.
