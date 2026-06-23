---
description: Approve a run's current renders as the new visual baseline (sign-off) for a target.
argument-hint: "[target]"
---

# /visual-baseline — approve current renders as the new baseline

**Output style — keep it lean.** Write for a non-technical user, in plain text with no emoji or status icons; keep the banner (it is line-art). Before each action, print ONE short line of what it is doing and whether it only reads or also changes things — so a permission prompt is never a surprise — then report the result in a few plain lines. Never show raw JSON, internal variable names (`$STATE`, `$RUNNER`, `dataDir`, install markers), absolute plugin paths, or a technical health/diagnostics table. End with one short `Next: …` line. The steps below are your runbook: follow them exactly, but surface only what the user needs to see.

Approve the most recent run's renders as the committed baseline for a target. This is a
**deliberate sign-off**: only ever run it when the user explicitly invokes `/visual-baseline`
— never as a step inside `/visual-check` or any other flow, and never to "make a check pass".
It writes **only** under the configured `baselineDir`; it touches nothing else.

The optional target is `$ARGUMENTS` (a component name, an instance label, or `instance/name`).

## Show this first — the banner

Open your response with this banner, **printed verbatim in a code block**, before any tool call:

```text
         ▄██▄
    ████▄████▄████
    █████▀██▀█████     V I S U A L  G U A R D
   ▄▄██▀██▀▀██▀██▄▄    ─────────────────────────
  ███████ ██ ███████   Catch visual bugs before they merge
   ▀▀██▄██▄▄██▄██▀▀    for design system teams.
    █████▄██▄█████     approve baseline
    ████▀████▀████
         ▀██▀
```

Then go straight to work — no upfront plan and no numbered step list. Before each action, print one short line of what it is doing and whether it only reads or also changes things, then run it. Keep the running output to those short progress lines plus the final result, as the Output style note above describes.

## 0. Preflight (same contract as /visual-check)

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't running as an
  installed plugin — tell the user and **stop**.
- **Check the engine first — every run.** Detect it **without installing anything**:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs" --check
  ```

  `Read` the one-line JSON (`$STATE`). If `$STATE.installed` is **false**, run the setup-consent flow
  inline (the same one `/visual-setup` performs): with **AskUserQuestion**, show *what*
  (`$STATE.engineDeps` + `$STATE.browser`), *why* (render screenshots of the UI locally), *where*
  (`$STATE.dataDir` — the plugin's data dir, **not** your project), and *size* (~150 MB, one-time).
  On **Install now** → run `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"` and continue once
  it exits `0`; on **Not now** → **stop** (nothing changes). When `$STATE.installed` is true, continue —
  but if `$STATE.healthy` is **false** (`$STATE.brokenNatives` lists the broken addons), the engine's
  native bindings didn't load; run the exact command in **`$STATE.repair`** (the sanctioned in-place
  self-heal — do **NOT** improvise a manual `npm rebuild`), then continue. If still unhealthy — or
  `$STATE.systemSupported` is **false** — relay `$STATE.reason` and **stop**.
- Resolve `$CONFIG` — the first that exists of `visual.config.json`,
  `config/visual.config.json`, else `${CLAUDE_PLUGIN_ROOT}/config/visual.config.json`.

## 1. Preview the sign-off (dry run — writes nothing)

From the **project root**, ask the engine what would be approved (latest run by default):

```bash
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"
TARGET="$ARGUMENTS"

"$RUNNER" "$SCRIPTS/baseline.ts" --config "$CONFIG" ${TARGET:+--target "$TARGET"} --dry-run
```

It prints JSON: `{ runId, baselineDir, planned: [{ key, existed, ... }], ... }`. If it fails
with **"no runs"**, tell the user to run `/visual-check` first. If it fails with
**"no renders matched"**, list a few valid targets from the config.

Show the user what will be approved: the `runId`, the list of `planned` keys, and which of
them **already have a baseline** (`existed: true` → those would be overwritten).

## 2. Confirm (the gate — required before any overwrite)

Ask for an explicit yes/no and wait for the answer; do not proceed on silence or a hedge.

- If **no target was given**, you are about to approve *every* render in the run. Ask:
  "Approve all N renders from run `<id>` as baselines?" — proceed only on a clear yes.
- If any planned render has `existed: true`, you are about to **replace approved baselines**.
  List those targets and ask: "Overwrite the existing baseline(s) for <targets>?" — proceed
  only on a clear yes. The engine itself refuses to overwrite without confirmation (below), so
  this is enforced, not just etiquette.
- If the user declines either, stop and change nothing.

## 3. Apply

Re-run without `--dry-run`. Pass `--overwrite --confirmed` **only** when the user confirmed
replacing existing baselines in step 2 (the engine requires `--confirmed` to overwrite, and
errors out otherwise). Omit both to approve only the new renders (existing baselines are skipped):

```bash
"$RUNNER" "$SCRIPTS/baseline.ts" --config "$CONFIG" ${TARGET:+--target "$TARGET"} ${OVERWRITE:+--overwrite --confirmed}
```

Report the result from its JSON (`written` / `skipped`, and `failed` if any copy errored). Then:

- Remind the user that baselines live in `baselineDir` and should be **committed** to version
  control so the whole team shares the same source of truth. Approving also records a
  `baselineDir/fingerprints.json` (the inputs each baseline was approved against) — **commit it too**;
  it travels with the baselines and is what lets `scope.fingerprintSkip` cheaply copy an unchanged
  render forward instead of re-screenshotting it.
- Suggest re-running `/visual-check $ARGUMENTS` to confirm it now reports **0 regressions** for
  the approved target.

Never approve a baseline the user didn't ask for, and never write outside `baselineDir`
(the engine enforces this — if it errors with "outside the baseline dir", surface it and stop).
