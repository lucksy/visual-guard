---
description: Guided wizard that scaffolds a visual.config.json — detects your dev servers and design tokens, confirms each with you, lets you enter your own when something's wrong or missing, then writes the config.
argument-hint: ""
---

# /visual-init — guided setup wizard

Walk the user through creating a project-specific `visual.config.json` so their **first**
`/visual-check` runs against *their* servers and tokens instead of the sample defaults. The flow is
**detect → confirm → fill the gaps → write**: probe for what's already running, show the user what
was found, let them **confirm, replace, or skip** each item (and **add** anything that wasn't
found), then write the config they approved.

Use the **AskUserQuestion** tool for every choice below. This command writes exactly one file
(`visual.config.json` at the project root) and **never overwrites an existing config without an
explicit confirmation**. It is otherwise read-only: it never touches source, never captures or
approves a baseline, and sends nothing external.

## 0. Preflight

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't running as an installed
  plugin — tell the user and **stop**.
- The runner is `${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx`. If it's missing, the engine isn't
  bootstrapped yet (it installs on `SessionStart`) — say so and **stop**.

## 1. Detect (writes nothing)

Run the detector in dry-run from the **project root** to see what's reachable and what tokens exist:

```bash
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"

"$RUNNER" "$SCRIPTS/init.ts" --dry-run
```

It prints JSON: `{ detection: { probes, targets, tokenCandidates, tokenSources, usedFallback },
config, configPath, existingPath, written, dryRun }`. The probe never errors on a down port, so this
step cannot crash. Use `detection` as the wizard's **starting answers** — do not just write
`config` blindly; confirm it with the user first.

## 2. Confirm the targets (one decision per item)

For **each** target in `detection.targets`, ask the user with AskUserQuestion. Describe what was
found plainly — for a storybook target with a story count say e.g. *"Storybook on `:6006` — 23
stories"*; for an app target note its URL. Offer three choices:

- **Use it** — keep the detected target as-is.
- **Enter a different URL** — the detected URL is wrong; collect the correct one (the user types it
  via the "Other" field) and use that instead.
- **Skip** — don't include this target.

**If a target the user expects is missing** (e.g. `usedFallback` is true, or no app server answered),
don't silently fall back — **ask whether to add one**: offer *"Add a Storybook URL"*, *"Add an app
URL"*, and *"Skip — I'll start my server and re-run"*. When they add one, collect the URL.

**For every app target** (detected or added), the routes default to just `/`, which Phase 0 can't
auto-discover. Ask for the routes to capture (e.g. `/login, /checkout`); accept the default `/` if
they don't have specifics yet.

End with at least one target. If the user skipped/added nothing and no target remains, explain that a
config needs at least one target and ask again.

## 3. Confirm the design-token source

If `detection.tokenSources` is present, show the file + detected `format` and ask:

- **Use it** — keep the detected token source.
- **Pick a different file** — collect the path (typed via "Other").
- **None** — omit `tokens`; the engine default (`src/styles/tokens.css`) applies at load time.

If no token source was detected, ask whether to **point at a token file now** (collect the path) or
**leave the default**.

## 4. Confirm + write

Build the final config object from the confirmed answers — `{ "targets": [...] }`, plus
`"tokens": { "sources": [...] }` only if the user chose a token source. Everything else
(`viewports`, `states`, `threshold`, `maxDiffRatio`, `baselineDir`, `uiGlobs`) is intentionally
omitted so the engine defaults apply.

**Show the final config and ask for a final yes** before writing.

**If `detection.existingPath` is non-null**, a `visual.config.json` (or `config/visual.config.json`)
already exists. Confirm explicitly — *"Overwrite the existing config at `<existingPath>`?"* — and:

- **Yes, overwrite** → write with `--force`.
- **No — write somewhere else** → ask for an alternate path and write with `--config <path>` (no
  `--force` needed for a fresh path), so the user still gets a scaffold without losing their file.
- **No — cancel** → change nothing; point them at the existing file to edit by hand.

Write the confirmed config by piping it to the engine on stdin (it validates the config round-trips
through the same `parseConfig` the rest of Visual Guard loads with, and re-checks the no-clobber and
project-root guards):

```bash
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"

# FORCE is "--force" only when the user approved an overwrite; CONFIG is "--config <path>" only when
# they chose to write elsewhere. Both expand to nothing when not applicable (harmless extra spaces).
# Substitute the confirmed config between the heredoc markers.
"$RUNNER" "$SCRIPTS/init.ts" --stdin ${FORCE} ${CONFIG} <<'JSON'
{
  "targets": [{ "type": "storybook", "url": "http://localhost:6006" }]
}
JSON
```

Confirm success from the result JSON (`written: true`, the `configPath`).

## 5. What's next

- Tell the user where the config was written and remind them to **review/edit** it (add `name`s,
  tune `viewports`, adjust app `routes`).
- Hand off the first run: once their Storybook / dev server is up, run **`/visual-check`** to capture
  and diff, then **`/visual-baseline`** to approve the first renders.
- Remind them to **commit** `visual.config.json` so the whole team shares the same targets and gates.

## Boundaries

- **Writes exactly one file** (`visual.config.json`, at the project root or a path the user chose) —
  never your source, never a baseline, never outside the project root (the engine hard-guards it).
- **Never overwrites** an existing config without an explicit confirmation (`--force`).
- **Local-only.** The port probe and token scan happen on your machine; nothing is sent anywhere.

> Non-interactive use (CI / scripting): `init.ts` with no `--stdin` auto-detects and writes without
> prompting; `--dry-run` previews and `--force` allows an overwrite.
