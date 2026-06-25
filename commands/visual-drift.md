---
description: Show the advisory Figma↔code drift report — components renamed, removed, newly appeared since the last sync, and mappings that have gone stale (design moved ahead of code). Reads the gitignored studio index only; makes zero external calls, uses no token, and NEVER gates CI.
argument-hint: ""
---

# /visual-drift — what drifted between Figma and code

**Output style — keep it lean.** Write for a non-technical user, in plain text with no emoji or status
icons. Before each action, print ONE short line of what it is doing and that it only **reads** — so a
permission prompt is never a surprise — then report the result in a few plain lines. Never show raw
JSON, internal variable names, absolute plugin paths, or a diagnostics table. End with one short
`Next: …` line.

This is a **maintenance / drift** view: it surfaces when a Figma variant or code prop was **renamed**,
when a **new** Figma or code component appeared, when a code component was **removed**, and when a
matched mapping has gone **stale** (the design was modified after the code was last captured). It is
purely **advisory** — it reads the gitignored studio index (`.visual-guard/studio.db`), reads no
`components.status` (the code-regression axis CI gates on), makes **zero external calls**, uses **no
token**, and always exits successfully. It never fails a build.

## 0. Preflight

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't an installed plugin —
  tell the user and **stop**.
- **Engine check (every run), install nothing** — the report loads SQLite (`better-sqlite3`):

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs" --check
  ```

  `Read` the one-line JSON. If `.installed` is **false**, point the user to `/visual-setup` and
  **stop**. If `.installed` is true but `.healthy` is **false**, run the exact command in `.repair`
  (the sanctioned in-place self-heal), then continue; if still unhealthy, relay `.reason` and **stop**.
- Resolve `$CONFIG`: the first that exists of `visual.config.json`, `config/visual.config.json`, else
  `${CLAUDE_PLUGIN_ROOT}/config/visual.config.json`.

## 1. Run the report (read-only)

From the **project root**, run the orchestrator as a **single command**. `drift.ts` opens the studio
index read-only, computes the advisory drift report, prints a plain-text summary, and writes
`.visual-guard/last-drift.json` — one statically-analyzable invocation (no inline shell):

```bash
"${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx" "${CLAUDE_PLUGIN_ROOT}/scripts/drift.ts" --cwd "$PWD"
```

If the studio index does not exist yet, the report says so and exits 0 — tell the user to run
`/visual-sync` first to populate it, then stop.

## 2. Present

`Read` `.visual-guard/last-drift.json` and relay it in plain language:

- **New since last sync** — components that appeared on the Figma side (`delta.newFigma`) or the code
  side (`delta.newCode`) since the previous sync. (Empty until at least two syncs have run.)
- **Renamed / moved** — `renamed` is the count of recorded rename events; a Figma node whose name
  changed, or a code component re-pointed within its instance. Run `studio.ts renames` for the list.
- **Removed** — code components that were present before but were not rendered in the last full sync
  (`removed`). Reversible — they resurrect if the component returns.
- **Stale mappings** — matched components whose Figma design was modified after the code was last
  captured (`stale`): the implementation may not reflect the latest design.
- **Presence** — `matched` / `figmaOnly` / `codeOnly` at-a-glance coverage.

Make clear this is **advisory** — nothing here fails CI; it is a maintenance checklist. End with a
short `Next: …` (e.g. *re-run `/visual-sync` to refresh, or open `/visual-studio` to browse*).

## Boundaries

- **Read-only**, **advisory**, **never gates** — exits 0 even when drift is found.
- Reads `.visual-guard/studio.db` only; **zero external calls**, **no token**, nothing sent off-machine.
- Writes exactly one file: `.visual-guard/last-drift.json` (gitignored), for this command to read back.
