---
description: Open Component Studio — a localhost web app to browse Figma↔code component parity (gallery, timeline, variants). Reads the studio DB; serves only already-captured local images; makes zero external calls and uses no token. Launches the server backgrounded so the turn completes.
argument-hint: ""
---

# /visual-studio — open the Component Studio web app

Boot Component Studio's **localhost-only** web app and open it in the browser. The server reads the
gitignored studio index (`.visual-guard/studio.db`) and streams the already-captured PNGs under
`.visual-baselines/`/`.visual-guard/` — it makes **zero external calls** and there is **no token**
anywhere. It is launched **backgrounded/detached** so this turn returns immediately while the server
keeps running; a second `/visual-studio` reuses the running instance instead of double-starting.

## Show this first — banner + plan

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

Then lay out the plan in plain language, so the user knows what's coming before anything runs:

- **1 · Preflight** — engine + studio index check (read-only; advisory if empty)
- **2 · Launch** — start the localhost-only server, backgrounded
- **3 · Open** — hand you the `127.0.0.1` URL (the browser opens automatically)

**Narrate as you go.** Before each step's tool call, print a one-line `▸ Step N/3 · <name>` that says in plain words what it does and whether it changes anything (read-only vs writes) — so a permission prompt is never a surprise. Never run a raw command without that context.

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

## Boundaries

- **Localhost only** (`127.0.0.1`), **no token**, **zero external calls** — the page consumes only
  already-captured local images, under a strict same-origin CSP.
- Reads `.visual-guard/studio.db` and streams images **path-confined** to `.visual-baselines/` /
  `.visual-guard/` — never your source, never anything outside those roots. Nothing is sent off-machine.
- `POST /api/sync` (the in-app button) re-runs only the headless **code** capture; it never touches Figma.
