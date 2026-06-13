---
description: Capture a UI target (or all configured targets), pixel-diff against the baseline, and explain what changed.
argument-hint: "[target]"
---

# /visual-check — capture → pixel-diff → explain a UI change

Execute Visual Guard's Phase-0 visual regression check now, following the
**gather → act → verify** loop below. Use `Bash` to run the engine and `Read` to read its
JSON output. The optional target is `$ARGUMENTS` (a component name, an instance label, or
`instance/name`). This command is **read-only** with respect to the user's source — never
edit a file to "make the check pass", and never approve a baseline (that is `/visual-baseline`).

## 0. Preflight (fail fast, actionably)

The engine and a pinned Chromium are installed into `${CLAUDE_PLUGIN_DATA}` by the
`SessionStart` hook (`install-deps.mjs`); that installer is the contract for where the runner
and browser live. Before running anything:

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't running as an
  installed plugin — tell the user and **stop**.
- The runner is `${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx` and the browser lives under
  `${CLAUDE_PLUGIN_DATA}/browsers`. If either is missing, the engine isn't bootstrapped yet —
  tell the user it installs on session start, ask them to start a fresh session (or share the
  SessionStart hook output if it keeps failing), and **stop**. Do not improvise another runner.
- Resolve the project's config — the first that exists of `visual.config.json`,
  `config/visual.config.json`, else the bundled default
  `${CLAUDE_PLUGIN_ROOT}/config/visual.config.json`. Call it `$CONFIG`.

## 1. Gather

- Surface the changed UI files as context (the banner the user expects). Run
  `git diff --name-only HEAD` and `git ls-files --others --exclude-standard`, then keep the
  ones matching the config's `uiGlobs`. Show them, e.g. `Changed UI files: Button.tsx · button.css`.
- Decide scope: if `$ARGUMENTS` is non-empty, pass it as `--target`. If it is empty, capture
  **all configured targets** — Phase 0 has no edit-tracking hook, so there is no "pending" set
  to narrow to; instead the report tags each target with the changed files that relate to it,
  so a real regression is never skipped by a target-name guess.

## 2. Act — capture → compare → report

Run all three from the **project root** (the current working directory), tied together by one
run id. The engine writes only under `.visual-guard/runs/<id>/` (gitignored); it writes
nothing else. Before capture, echo `Capturing: <target or "all targets">…`, and before the
diff, echo `Comparing against baseline…`, so the run reads like the canonical flow.

```bash
RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
export PLAYWRIGHT_BROWSERS_PATH="${CLAUDE_PLUGIN_DATA}/browsers"
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"
TARGET="$ARGUMENTS"

"$RUNNER" "$SCRIPTS/capture.ts" --config "$CONFIG" --run "$RUN_ID" ${TARGET:+--target "$TARGET"}
"$RUNNER" "$SCRIPTS/compare.ts" --config "$CONFIG" --run "$RUN_ID"
"$RUNNER" "$SCRIPTS/report.ts"  --config "$CONFIG" --run "$RUN_ID"
```

- If `capture.ts` fails with **"could not reach …"**, relay its message verbatim — the dev
  server / Storybook isn't running on that port. Stop; do not fabricate results.
- If capture reports **"no targets matched"**, tell the user the target didn't match any
  configured story/route and list a few valid ones from the config. Stop.

## 3. Verify — present the manifest (evidence before verdict)

`Read` `.visual-guard/runs/$RUN_ID/manifest.json`. Its paths are relative to the project root.
Walk `targets` worst-status first and, for each, give the user **evidence, then verdict**:

- **Status** — `fail` (a regression), `new` (no baseline yet), `error` (couldn't decode), or
  `pass` — stated plainly.
- **Pixel evidence** per image, first: the `ratio` as a percentage, any `dimensionDelta`
  (e.g. `height 32px → 36px`), the changed `regions`, and the `diffPath` PNG to open.
- **A plain-language explanation**, second. In Phase 0 *you*, the main loop, explain; the
  structured `visual-reviewer` subagent (classification · cause · impact · fix verdict) is
  wired in Phase 1, so `verdict` is `null` for now. Use the target's `changedFiles`, and
  `Read` the relevant source if it helps you say *what* likely changed (e.g. a spacing token
  replaced by a hardcoded value). Be honest about uncertainty — never invent a cause.
- For `new`: it's unreviewed; suggest `/visual-baseline <target>` to approve the first render.
- For `error`: surface that render's `error` message.

End with a one-line summary (`N fail · N new · N error`) and:

- If a flagged change is **intended**, tell the user to approve it with
  `/visual-baseline <target>` so the next run is clean.
- Never report a finding you could not tie back to the manifest, and never send any screenshot
  to an external service — all capture, diff, and review is local.
