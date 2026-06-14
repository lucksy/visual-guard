---
description: Run the full Visual Guard gate (capture → pixel-diff → report → CI gate) and generate a PR-comment Markdown report. Shows pass/fail and how to wire the deterministic non-zero-exit gate into CI and post the report on a pull request.
argument-hint: "[target]"
---

# /visual-ci — gate a change + generate the PR report

Run Visual Guard as a **gate**: capture → compare → report, then turn the run's `manifest.json` into
(1) a pass/fail decision with a process exit code, and (2) a PR-comment Markdown report. This command
is **read-only** on source (never edits a file to pass, never approves a baseline) and **local-only**
(it generates the PR report; it does not post it — your CI does). The optional target is `$ARGUMENTS`.

> **Where the authoritative CI exit code comes from (read this).** A `claude -p` headless run does
> **not** automatically exit non-zero when a check "fails" — so the trustworthy CI gate is the engine
> script `scripts/ci.ts`, whose own process exit is `0` (clean) / `1` (unapproved regressions) / `2`
> (could not run). In an interactive session this command *reports* the gate result; in CI you run
> `scripts/ci.ts` directly (see §5) so the pipeline actually fails.

## 0. Preflight

Same as `/visual-check`: if `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` are unset, this isn't an
installed plugin — stop. The runner is `${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx` and Chromium is
under `${CLAUDE_PLUGIN_DATA}/browsers`; if either is missing, the engine isn't bootstrapped (it
installs on `SessionStart`) — ask for a fresh session and stop. Resolve `$CONFIG` as the first of
`visual.config.json`, `config/visual.config.json`, else `${CLAUDE_PLUGIN_ROOT}/config/visual.config.json`.

## 1. Capture → compare → report

From the **project root**, tied together by one run id (the engine writes only under
`.visual-guard/runs/<id>/`, gitignored):

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

If `capture.ts` reports **"could not reach …"**, relay it and stop (the dev server / Storybook isn't
up). Optionally invoke `visual-reviewer` per flagged target and `report.ts --apply-verdicts` (as in
`/visual-check` §3) so the PR report carries structured verdicts, not just pixels.

## 2. Gate — the pass/fail decision (exit code)

```bash
"$RUNNER" "$SCRIPTS/ci.ts" --run "$RUN_ID" --json
echo "gate exit: $?"
```

- The gate **blocks** (exit 1) on any `fail` target; `new` (no baseline = unapproved) and `error`
  (undecodable) also block by default — add `--allow-new` / `--allow-error` to relax them for a
  first-baseline bootstrap. Exit `2` means it couldn't run (no manifest) — surface that, don't treat
  it as "clean".
- Present the gate verdict plainly: the summary line and each blocking `instance/target`.

## 3. PR comment — generate the Markdown (don't post it)

```bash
"$RUNNER" "$SCRIPTS/pr-report.ts" --run "$RUN_ID"   # writes .visual-guard/runs/$RUN_ID/pr-comment.md
```

Show the rendered Markdown (evidence-then-verdict per flagged target). It is a local run artifact —
**Visual Guard never posts it**; tell the user to post it from their CI with the GitHub CLI:

```bash
gh pr comment "$PR_NUMBER" -F .visual-guard/runs/$RUN_ID/pr-comment.md
```

## 4. Present

Give the user, in order: the changed UI files, the gate verdict (pass/fail + blocking targets), and
the PR-comment Markdown. If a flagged change is **intended**, tell them to approve it with
`/visual-baseline <target>` and commit the new baseline so the next gate is clean.

## 5. The CI recipe (copy into the pipeline)

The deterministic gate, runnable headless. The SessionStart hook installs the engine; run it with
`claude -p --init` first, or invoke the engine directly if the deps are already present:

```bash
# Auth for headless: ANTHROPIC_API_KEY (OAuth/keychain are not read in -p mode).
RUN_ID="ci-$(date -u +%Y%m%d-%H%M%S)"
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"; S="${CLAUDE_PLUGIN_ROOT}/scripts"
export PLAYWRIGHT_BROWSERS_PATH="${CLAUDE_PLUGIN_DATA}/browsers"

"$RUNNER" "$S/capture.ts" --config "$CONFIG" --run "$RUN_ID" \
  && "$RUNNER" "$S/compare.ts" --config "$CONFIG" --run "$RUN_ID" \
  && "$RUNNER" "$S/report.ts"  --config "$CONFIG" --run "$RUN_ID"

"$RUNNER" "$S/pr-report.ts" --run "$RUN_ID" > /dev/null   # write pr-comment.md (optional)
"$RUNNER" "$S/ci.ts" --run "$RUN_ID"                      # <-- exits non-zero on unapproved regressions
```

The final `ci.ts` exit code is what fails the pipeline — that is the gate.

## Boundaries

- **Read-only** on source; never edit to pass, never approve/overwrite a baseline (that's
  `/visual-baseline`).
- **Local-only.** The PR report is generated, not posted; no screenshot is sent anywhere — your CI
  posts the Markdown. Run artifacts live only under `.visual-guard/` (gitignored).
- **Evidence before verdict** in everything you present.
