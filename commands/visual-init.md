---
description: Scaffold a visual.config.json for this project — probes your dev servers, detects design tokens, and writes a working config so your first /visual-check just works.
argument-hint: ""
---

# /visual-init — scaffold a working visual.config.json

Bootstrap a project-specific `visual.config.json` so a freshly-installed engineer's **first**
`/visual-check` runs against *their* servers and tokens instead of the sample defaults
(`localhost:6006` + `localhost:3000` routes, `src/styles/tokens.css`). The engine probes the
common dev-server / Storybook ports, classifies what answers, scans the project for design-token
files, and writes a minimal valid config (every other field falls back to the engine defaults).

This command **writes one file** (`visual.config.json` in the project root) and **never clobbers**
an existing config without `--force`. It is otherwise read-only: it does not touch your source,
never captures or approves a baseline, and sends nothing external — the probe is local-only.

## 0. Preflight (same contract as /visual-check)

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't running as an
  installed plugin — tell the user and **stop**.
- The runner is `${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx`. If it's missing, the engine isn't
  bootstrapped yet (it installs on `SessionStart`) — say so and **stop**. Do not improvise another
  runner. (No `$CONFIG` to resolve here — this command *creates* it.)

## 1. Detect (dry run — writes nothing)

From the **project root** (the current working directory), ask the engine what it would scaffold:

```bash
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"

"$RUNNER" "$SCRIPTS/init.ts" --dry-run
```

It prints JSON: `{ detection: { probes, targets, tokenCandidates, tokenSources, usedFallback },
config, configPath, existingPath, written, dryRun }`. The probe is robust — an unreachable port
is reported `reachable: false`, never an error, so this step **cannot crash on a down network**.

Show the user what was detected, plainly:

- **Ports that answered** — from `detection.probes`, the `reachable: true` ones. For a Storybook
  (a probe with `storyEntryCount`), say how many stories were discovered (e.g. "Storybook on
  `:6006` — 23 stories"). For a plain app, note it was seeded with the default route `/`, which
  they will likely want to edit to their real routes.
- **Token source** — `detection.tokenSources` (the file + detected `format`), or that none were
  found so the engine default `src/styles/tokens.css` will apply.
- **The proposed `config`** — the `targets` (and `tokens`) that would be written. Mention that
  `viewports`, `states`, `threshold`, `maxDiffRatio`, `baselineDir`, and `uiGlobs` are intentionally
  omitted so the engine defaults apply (`[375, 768, 1280]`, `["default", "hover", "disabled"]`, …).
- **If `usedFallback` is true** — nothing was reachable. The scaffold is a template Storybook
  target (`http://localhost:6006`). Warn the user to **start their dev server / Storybook** (or edit
  the URLs) before `/visual-check`, since capture will otherwise fail with "could not reach …".
- **If `existingPath` is non-null** — a `visual.config.json` (or `config/visual.config.json`)
  already exists. Tell the user the path and that you will **not** overwrite it without `--force`.

## 2. Confirm + write

Decide based on §1, then write (without `--dry-run`):

```bash
"$RUNNER" "$SCRIPTS/init.ts" ${FORCE:+--force}
```

- **No existing config** (`existingPath` was null): write it. Report `configPath` and `written: true`.
- **A config already exists**: this would replace it. Ask the user explicitly —
  "Overwrite the existing config at `<existingPath>`?" — and pass `--force` **only** on a clear yes.
  If they decline, change nothing and point them at the existing file to edit by hand.

The engine writes the file as pretty-printed JSON and validates it round-trips through the same
`parseConfig` the rest of Visual Guard loads with — so a scaffold it writes is always loadable.

## 3. Present — what's next

- Tell the user the config was written to `configPath` and that they should **review and edit** it:
  app targets need their real `routes` (Phase 0 can't auto-discover them — the default is just `/`),
  and they may want to add `name`s, tune `viewports`, or point `tokens.source` at the right file.
- Hand off the canonical first run: once their Storybook / dev server is up, run **`/visual-check`**
  to capture and diff, then **`/visual-baseline`** to approve the first renders as the baseline.
- Remind them the config lives at the project root and should be **committed** so the whole team
  shares the same targets and gates.

## Boundaries

- **Writes exactly one file** (`visual.config.json` at the project root) — never your source, never
  a baseline, never anything outside the project root (the engine hard-guards the write path).
- **Never clobbers** an existing config without an explicit `--force` you obtained a yes for.
- **Local-only.** The port probe and token scan happen on your machine; nothing is sent anywhere.
