---
name: visual-coverage
description: Print the Visual Guard coverage map — which component/page states × viewports have an approved baseline, which are gaps (config expects a render but no baseline exists), and which baselines are orphans (on disk but no longer in config). Use to audit visual-test coverage before relying on it as a gate, or to find untested states.
argument-hint: "[--json]"
---

# /visual-coverage — the state × component coverage map

Show what Visual Guard actually covers: cross the config's **resolved render grid** (every target ×
state/story × viewport that `/visual-check` would capture) with the committed baselines on disk, and
report covered cells, **gaps** (expected but unbaselined), and **orphans** (a baseline no config
render expects). This is **read-only** — it captures nothing, approves no baseline, and sends nothing
to any external service.

## Show this first — banner + plan

Open your response with this banner, **printed verbatim in a code block**, before any tool call:

```text
         ▄██▄
    ████▄████▄████
    █████▀██▀█████     V I S U A L  G U A R D
   ▄▄██▀██▀▀██▀██▄▄    ─────────────────────────
  ███████ ██ ███████   Catch visual bugs before they merge
   ▀▀██▄██▄▄██▄██▀▀    for design system teams.
    █████▄██▄█████     coverage map
    ████▀████▀████
         ▀██▀
```

Then lay out the plan in plain language, so the user knows what's coming before anything runs:

- **1 · Preflight** — engine + config found (read-only)
- **2 · Resolve** — expand the render grid and read the baselines on disk
- **3 · Report** — covered cells, gaps (expected but unbaselined), and orphans

**Narrate as you go.** Before each step's tool call, print a one-line `▸ Step N/3 · <name>` that says in plain words what it does and whether it changes anything (this command is read-only throughout) — so a permission prompt is never a surprise. Never run a raw command without that context.

## 0. Preflight

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't running as an installed
  plugin — tell the user and **stop**.
- **Check the engine first — every run.** Detect it **without installing anything**:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs" --check
  ```

  `Read` the one-line JSON (`$STATE`). If `$STATE.installed` is **false**, run the setup-consent flow
  inline (the same one `/visual-setup` performs): with **AskUserQuestion**, show *what*
  (`$STATE.engineDeps` + `$STATE.browser`), *why* (render screenshots of the UI locally), *where*
  (`$STATE.dataDir` — the plugin's data dir, **not** your project), and *size* (~150 MB, one-time).
  On **Install now** → run `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"` and continue once
  it exits `0`; on **Not now** → **stop** (nothing changes). When `$STATE.installed` is true, continue.
- Resolve `$CONFIG` the same way `/visual-check` does: the first that exists of `visual.config.json`,
  `config/visual.config.json`, else `${CLAUDE_PLUGIN_ROOT}/config/visual.config.json`.

## 1. Run the coverage engine

From the **project root**:

```bash
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"
"$RUNNER" "$SCRIPTS/coverage.ts" --config "$CONFIG"
```

- Pass `--json` (i.e. when `$ARGUMENTS` contains `--json`) to get the machine-readable map instead of
  the text matrix.
- **Storybook auto-discovery needs the Storybook running** (it reads `/index.json` to learn the
  stories), or the config must list explicit `stories`. App targets resolve fully offline. If
  `coverage.ts` reports it "could not discover Storybook stories …", relay that and tell the user to
  start Storybook (or list `stories` in config), then **stop** — don't guess a grid.

## 2. Present the map

Read the engine's output and present it plainly:

- The **summary**: covered / expected cells, target count, gap count, orphan count.
- The **per-target matrix** (states × viewports), with covered cells (`✓`) and gaps (`·`) called out.
- The **gaps**, grouped by target — these are states/viewports a regression could slip through
  because there's no baseline to diff against. Suggest the user capture + approve them:
  `/visual-check <target>` then `/visual-baseline <target>`.
- The **orphans** — baselines on disk that no config render expects (a renamed/removed component, a
  dropped viewport/state). Suggest pruning them from `baselineDir` so the committed baselines stay in
  sync with the config (the user prunes/commits — this skill never deletes a baseline).

## Boundaries

- **Read-only.** Never capture, never write or delete a baseline, never edit source.
- **Everything is local.** Nothing is sent to any external service.
- Don't invent coverage: if the grid can't be resolved (Storybook down with no explicit `stories`),
  say so rather than reporting a partial map as if it were complete.
