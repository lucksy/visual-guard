---
description: Run the full Visual Guard gate (capture → pixel-diff → report → CI gate) and generate a PR-comment Markdown report. Shows pass/fail and how to wire the deterministic non-zero-exit gate into CI and post the report on a pull request.
argument-hint: "[target]"
---

# /visual-ci — gate a change + generate the PR report

**Output style — keep it lean.** Write for a non-technical user, in plain text with no emoji or status icons; keep the banner (it is line-art). Before each action, print ONE short line of what it is doing and whether it only reads or also changes things — so a permission prompt is never a surprise — then report the result in a few plain lines. Never show raw JSON, internal variable names (`$STATE`, `$RUNNER`, `dataDir`, install markers), absolute plugin paths, or a technical health/diagnostics table. End with one short `Next: …` line. The steps below are your runbook: follow them exactly, but surface only what the user needs to see.

Run Visual Guard as a **gate**: capture → compare → report, then turn the run's `manifest.json` into
(1) a pass/fail decision with a process exit code, and (2) a PR-comment Markdown report. This command
is **read-only** on source (never edits a file to pass, never approves a baseline) and **local-only**
(it generates the PR report; it does not post it — your CI does). The optional target is `$ARGUMENTS`.

> **Where the authoritative CI exit code comes from (read this).** A `claude -p` headless run does
> **not** automatically exit non-zero when a check "fails" — so the trustworthy CI gate is the engine
> script `scripts/ci.ts`, whose own process exit is `0` (clean) / `1` (unapproved regressions) / `2`
> (could not run). In an interactive session this command *reports* the gate result; in CI you run
> `scripts/ci.ts` directly (see §5) so the pipeline actually fails.

## Show this first — the banner

Open your response with this banner, **printed verbatim in a code block**, before any tool call:

```text
         ▄██▄
    ████▄████▄████
    █████▀██▀█████     V I S U A L  G U A R D
   ▄▄██▀██▀▀██▀██▄▄    ─────────────────────────
  ███████ ██ ███████   Catch visual bugs before they merge
   ▀▀██▄██▄▄██▄██▀▀    for design system teams.
    █████▄██▄█████     CI gate + PR report
    ████▀████▀████
         ▀██▀
```

Then go straight to work — no upfront plan and no numbered step list. Before each action, print one short line of what it is doing and whether it only reads or also changes things, then run it. Keep the running output to those short progress lines plus the final result, as the Output style note above describes.

## 0. Preflight

If `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` are unset, this isn't an installed plugin — stop.

**Check the engine first — every run.** Detect it **without installing anything**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs" --check
```

`Read` the one-line JSON (`$STATE`). If `$STATE.installed` is **false**, run the setup-consent flow
inline (the same one `/visual-setup` performs): with **AskUserQuestion**, show *what*
(`$STATE.engineDeps` + `$STATE.browser`), *why* (render screenshots of the UI locally), *where*
(`$STATE.dataDir` — the plugin's data dir, **not** your project), and *size* (~150 MB, one-time). On
**Install now** → run `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"` and continue once it
exits `0`; on **Not now** → **stop** (nothing changes). When `$STATE.installed` is true, continue — but
if `$STATE.healthy` is **false** (`$STATE.brokenNatives` lists the broken addons), the engine's native
bindings didn't load; run the exact command in **`$STATE.repair`** (the sanctioned in-place self-heal —
do **NOT** improvise a manual `npm rebuild` in a guessed directory), then continue. If still unhealthy
— or `$STATE.systemSupported` is **false** — relay `$STATE.reason` and **stop**.

> In a non-interactive CI run (no one to approve), don't prompt — assume the engine is provisioned by
> the pipeline (a prior session or `node install-deps.mjs` step) and let the capture fail loudly if not.

Resolve `$CONFIG` as the first of `visual.config.json`, `config/visual.config.json`, else
`${CLAUDE_PLUGIN_ROOT}/config/visual.config.json`.

## 1. Run the gate (one engine command)

From the **project root**, run the whole gate as a **single command**. `ci-run.ts` captures → diffs →
reports → runs the CI gate → writes the PR-comment markdown under one run id (the engine writes only
under `.visual-guard/runs/<id>/`, gitignored). Doing it in one analyzable command — no `$(date)`/
`export`/`$?` in the prompt — is also what keeps this to a single permission prompt.

Append `--target <name>` if `$ARGUMENTS` named one; add `--allow-new` / `--allow-error` only to relax
the gate for a first-baseline bootstrap. Print one short line — e.g. `Capturing, diffing, and gating the change (writes only under .visual-guard/)…` — then run:

```bash
"${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx" "${CLAUDE_PLUGIN_ROOT}/scripts/ci-run.ts" --config "$CONFIG" --cwd "$PWD"
```

`Read` **`.visual-guard/last-ci.json`** — `{ runId, ranGate, gateExit, manifestPath, prCommentPath, error }`:

- `error` set (command exits non-zero) → relay the streamed message **verbatim** (e.g. capture *"could
  not reach …"* — the dev server / Storybook isn't up) and **stop**.
- otherwise the gate ran: `gateExit` is the verdict for §2, and `manifestPath` / `prCommentPath` feed §2–§3.

Optionally, before presenting, invoke `visual-reviewer` per flagged target and
`tsx report.ts --run <runId> --apply-verdicts` (as in `/visual-check` §3), then re-run pr-report so the
PR report carries structured verdicts — or just present the pixel evidence.

## 2. Gate — the pass/fail decision

Present the verdict from `gateExit`:

- **`0`** — clean (no blocking targets).
- **`1`** — blocked: a `fail` target, or (unless relaxed) a `new` (no-baseline) / `error` (undecodable)
  target. `Read` the run's `manifest.json` and list each blocking `instance/target`.
- **`2`** — the gate could not run (no manifest). Surface that; do **not** treat it as "clean".

> This command *reports* the gate. The pipeline's authoritative non-zero exit comes from running
> `scripts/ci.ts` directly (see §5).

## 3. PR comment — show the Markdown (don't post it)

`Read` the `prCommentPath` from the result (`.visual-guard/runs/<runId>/pr-comment.md`) and show the
rendered Markdown (evidence-then-verdict per flagged target). It is a local run artifact — **Visual
Guard never posts it**; tell the user to post it from their CI with the GitHub CLI:

```bash
gh pr comment "$PR_NUMBER" -F .visual-guard/runs/<runId>/pr-comment.md
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
