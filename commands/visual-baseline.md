---
description: Approve a run's current renders as the new visual baseline (sign-off) for a target.
argument-hint: "[target]"
---

# /visual-baseline — approve current renders as the new baseline

Approve the most recent run's renders as the committed baseline for a target. This is a
**deliberate sign-off**: only ever run it when the user explicitly invokes `/visual-baseline`
— never as a step inside `/visual-check` or any other flow, and never to "make a check pass".
It writes **only** under the configured `baselineDir`; it touches nothing else.

The optional target is `$ARGUMENTS` (a component name, an instance label, or `instance/name`).

## Show this first — banner + plan

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

Then lay out the plan in plain language, so the user knows what's coming before anything runs:

- **1 · Preflight** — engine + the latest run found (read-only)
- **2 · Review** — show exactly which renders would become the new baseline
- **3 · Approve** — write the baseline, only on your explicit go-ahead

**Narrate as you go.** Before each step's tool call, print a one-line `▸ Step N/3 · <name>` that says in plain words what it does and whether it changes anything (read-only vs writes) — so a permission prompt is never a surprise. Never run a raw command without that context.

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
  native bindings didn't load; run `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"` to repair
  them in place, then continue (if `brokenNatives` is still non-empty afterward, relay it and **stop**).
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
