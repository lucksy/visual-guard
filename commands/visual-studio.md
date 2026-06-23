---
description: Open Component Studio — a localhost web app to browse Figma↔code component parity (gallery, timeline, variants). Reads the studio DB; serves only already-captured local images; makes zero external calls and uses no token. Launches the server backgrounded so the turn completes.
argument-hint: ""
---

# /visual-studio — open the Component Studio web app

**Output style — keep it lean.** Write for a non-technical user, in plain text with no emoji or status icons; keep the banner (it is line-art). Before each action, print ONE short line of what it is doing and whether it only reads or also changes things — so a permission prompt is never a surprise — then report the result in a few plain lines. Never show raw JSON, internal variable names (`$STATE`, `$RUNNER`, `dataDir`, install markers), absolute plugin paths, or a technical health/diagnostics table. End with one short `Next: …` line. The steps below are your runbook: follow them exactly, but surface only what the user needs to see.

Boot Component Studio's **localhost-only** web app and open it in the browser. The server reads the
gitignored studio index (`.visual-guard/studio.db`) and streams the already-captured PNGs under
`.visual-baselines/`/`.visual-guard/` — it makes **zero external calls** and there is **no token**
anywhere. It is launched **backgrounded/detached** so this turn returns immediately while the server
keeps running; a second `/visual-studio` reuses the running instance instead of double-starting.

## Show this first — the banner

Open your response with this banner, **printed verbatim in a code block**, before any tool call:

```text
         ▄██▄
    ████▄████▄████
    █████▀██▀█████     V I S U A L  G U A R D
   ▄▄██▀██▀▀██▀██▄▄    ─────────────────────────
  ███████ ██ ███████   Catch visual bugs before they merge
   ▀▀██▄██▄▄██▄██▀▀    for design system teams.
    █████▄██▄█████     Component Studio
    ████▀████▀████
         ▀██▀
```

Then go straight to work — no upfront plan and no numbered step list. Before each action, print one short line of what it is doing and whether it only reads or also changes things, then run it. Keep the running output to those short progress lines plus the final result, as the Output style note above describes.

## 0. Preflight

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't an installed plugin —
  tell the user and **stop**.
- **Engine check (every run), install nothing:**

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs" --check
  ```

  `Read` the one-line JSON. If `.installed` is **false**, run the `/visual-setup` consent flow inline
  (AskUserQuestion: *what* / *why* / *where* / *size ~150 MB*); on **Install now** run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"` and continue on exit `0`; on **Not now** stop.
- **Native health — the studio loads SQLite (`better-sqlite3`), so this matters here.** If `.installed`
  is true but `.healthy` is **false** (`.brokenNatives` lists the broken addons), the bindings didn't
  load from the tree the scripts use; run the exact command in **`.repair`** (the sanctioned in-place
  self-heal — do **NOT** improvise a manual `npm rebuild` in a guessed directory), then continue. If
  still unhealthy — or `.systemSupported` is **false** (`.systemIssues`, e.g. Node too old) — relay
  `.reason` and **stop** (launching anyway would crash with `ERR_DLOPEN_FAILED`).
- Resolve `$CONFIG`: the first that exists of `visual.config.json`, `config/visual.config.json`, else
  `${CLAUDE_PLUGIN_ROOT}/config/visual.config.json`.
- **Empty studio (advisory, never blocking).** If `.visual-guard/studio.db` does not exist, tell the
  user *"the studio is empty — run `/visual-sync` first to populate it"*, but still launch (the app
  renders a friendly empty state and the API returns empty lists).

## 1. Launch the server (backgrounded) and read its URL

From the **project root**, run the launcher as a **single command**. `studio-launch.ts` starts the
server **detached** (so it outlives this turn), waits for it to write its pidfile, and prints that
pidfile's JSON — replacing the old `nohup … & disown` + poll-loop shell (which the permission engine
couldn't statically analyze), so this is one analyzable prompt:

```bash
"${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx" "${CLAUDE_PLUGIN_ROOT}/scripts/studio-launch.ts" --config "$CONFIG" --cwd "$PWD"
```

`Read` the printed pidfile JSON (`{ pid, port, url, startedAt }`) — or `Read`
`.visual-guard/studio.pid`. The server binds **`127.0.0.1`** on an OS-chosen port and **opens the
browser itself**. If the launcher reports the server did not start within ~5s (it exits non-zero), it
prints the exact foreground command to run to see the error — relay that and stop.

## 2. Present

Tell the user the studio is open at the `url` from the pidfile (the browser was opened automatically;
they can also paste the URL). Mention the next steps: **`/visual-sync`** to (re)populate Figma↔code
parity, and the in-app **Sync** button which re-runs the **code** capture only (Figma capture needs
the desktop MCP, so it stays in `/visual-sync`). To stop the server, `kill` the `pid` from the pidfile.

Briefly point out what each component page now offers: the **pixel-diff %** and a **drift sparkline**
(how much the code render moved from its baseline, and the trend over time), an **Approve as baseline**
button that signs off the current render as the new committed baseline (the same durable action as
`/visual-baseline`, right from the page), **shift-click two timeline points** to compare any two
versions, and keyboard shortcuts (press **?** for the list). The gallery search also matches a
component's description.

## Boundaries

- **Localhost only** (`127.0.0.1`), **no token**, **zero external calls** — the page consumes only
  already-captured local images, under a strict same-origin CSP.
- Reads `.visual-guard/studio.db` and streams images **path-confined** to `.visual-baselines/` /
  `.visual-guard/` — never your source, never anything outside those roots. Nothing is sent off-machine.
- Two mutating routes, both CSRF-guarded (same-origin only): `POST /api/sync` (the in-app **Sync** button)
  re-runs only the headless **code** capture and never touches Figma; `POST /api/snapshots/:id/approve`
  (the **Approve as baseline** button) writes ONE committed baseline PNG under `.visual-baselines/`
  (path-confined) and mirrors it into the index — the only thing the studio ever writes to your repo.
