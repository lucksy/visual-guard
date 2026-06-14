---
name: visual-review
description: Launch a fan-out visual-regression review across many components × viewports. Spawns the visual-reviewer and token-auditor subagents in parallel, adversarially verifies every finding before it is reported, and synthesizes one report of only independently-verified findings. Use after a multi-component capture, or when the user asks to review a whole UI / design system for regressions and token drift.
argument-hint: "[target-glob]"
---

# /visual-review — fan-out review + adversarial verify → one report

This skill orchestrates Visual Guard's Phase-1 deep review as a **dynamic workflow**. Plugins can't
bundle a workflow directly, so this skill ships the orchestration as a **script template**
(`workflow.template.js`, next to this file) and launches it for you with the Workflow tool. It is
read-only on source and sends nothing to an external service — all capture, diff, and review is local.

## 1. Build (or locate) a run to review

The workflow reviews an existing run's `manifest.json`. If there isn't a fresh one, produce it first
(same engine as `/visual-check`, from the project root):

```bash
RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
export PLAYWRIGHT_BROWSERS_PATH="${CLAUDE_PLUGIN_DATA}/browsers"
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"
CONFIG="$(first of visual.config.json, config/visual.config.json, else ${CLAUDE_PLUGIN_ROOT}/config/visual.config.json)"

"$RUNNER" "$SCRIPTS/capture.ts" --config "$CONFIG" --run "$RUN_ID"
"$RUNNER" "$SCRIPTS/compare.ts" --config "$CONFIG" --run "$RUN_ID"
"$RUNNER" "$SCRIPTS/report.ts"  --config "$CONFIG" --run "$RUN_ID"
```

If `capture.ts` reports **"could not reach …"**, relay it and stop (the dev server/Storybook isn't up).

## 2. Compute the review units

`Read` `.visual-guard/runs/$RUN_ID/manifest.json`. Build `units` = one entry **per flagged image**
(a target whose `status` is `fail`/`new`/`error`, expanded by its images' `state`×`viewport`):
`{ instance, target, viewport }`. Optionally, if you ran the token audit, point `driftPath` at the
`DriftFinding[]` JSON so the `token-auditor` channel runs too. Pass `$ARGUMENTS` as a target glob to
narrow the units (else review all flagged).

## 3. Launch the workflow

Invoke the **Workflow** tool with the bundled template and the run context as `args`:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/visual-review/workflow.template.js",
  args: { manifestPath: ".visual-guard/runs/$RUN_ID/manifest.json", units: [...], driftPath: <optional> }
})
```

The template (see [workflow.template.js](workflow.template.js)) fans review out across components ×
viewports (the `visual-reviewer` + `token-auditor` subagents), **adversarially verifies each finding**
with independent skeptics behind a majority gate, and returns **one** synthesized report — so no
unverified noise reaches the user. Present that report: evidence (pixels) then the verified verdict.

## 4. Offer to save it as `/visual-review`

A plugin can't pre-save a workflow, so after the run, tell the user they can keep it: run `/workflows`,
select this run, press **`s`** to save it to `.claude/workflows/visual-review.js` — then `/visual-review`
is a one-step command in future sessions.

## Boundaries

- **Read-only** on source; never edit a file to "make a check pass"; never approve or overwrite a
  baseline (that is `/visual-baseline`).
- Report **only independently-verified** findings — the workflow's majority gate drops the rest.
- Run artifacts live only under `.visual-guard/` (gitignored); nothing is sent anywhere external.
