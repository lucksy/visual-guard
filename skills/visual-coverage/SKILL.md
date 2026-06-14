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

## 0. Preflight

- If `${CLAUDE_PLUGIN_ROOT}` is unset, this isn't running as an installed plugin — tell the user and
  **stop**.
- The runner is `${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx`. If it's missing, the engine isn't
  bootstrapped yet (it installs on `SessionStart`) — ask the user to start a fresh session and **stop**.
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
