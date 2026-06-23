---
description: One-time engine setup with consent — checks whether the Visual Guard engine (runtime deps + a pinned Chromium) is installed, and if not, shows exactly what it will download, where, and how big, then installs it only after you approve.
argument-hint: ""
---

# /visual-setup — install the engine, with consent

**Output style — keep it lean.** Write for a non-technical user, in plain text with no emoji or status icons; keep the banner (it is line-art). Before each action, print ONE short line of what it is doing and whether it only reads or also changes things — so a permission prompt is never a surprise — then report the result in a few plain lines. Never show raw JSON, internal variable names (`$STATE`, `$RUNNER`, `dataDir`, install markers), absolute plugin paths, or a technical health/diagnostics table. End with one short `Next: …` line. The steps below are your runbook: follow them exactly, but surface only what the user needs to see.

Get Visual Guard's engine ready to run. The engine (a few runtime packages plus a pinned Chromium,
~150MB) normally installs itself on the **first session** via the `SessionStart` hook. But if you
added the plugin **mid-session**, that hook never ran, so `/visual-check` and friends will report the
runner/browser missing. This command closes that gap: it **detects** the state, **explains** what
would be installed (what / why / where / size), **asks** for your approval, and only then installs.

Use the **AskUserQuestion** tool for the approval gate. This command installs **only** into the
plugin's own data dir — never your project — and sends nothing external.

## Show this first — the banner

Open your response with this banner, **printed verbatim in a code block**, before any tool call:

```text
         ▄██▄
    ████▄████▄████
    █████▀██▀█████     V I S U A L  G U A R D
   ▄▄██▀██▀▀██▀██▄▄    ─────────────────────────
  ███████ ██ ███████   Catch visual bugs before they merge
   ▀▀██▄██▄▄██▄██▀▀    for design system teams.
    █████▄██▄█████     engine setup
    ████▀████▀████
         ▀██▀
```

Then go straight to work — no upfront plan and no numbered step list. Before each action, print one short line of what it is doing and whether it only reads or also changes things, then run it. Keep the running output to those short progress lines plus the final result, as the Output style note above describes.

## 0. Preflight

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't running as an installed
  plugin — tell the user and **stop**.
- `node` must be on `PATH` (the installer is a plain `.mjs` run with `node`). If it isn't, say so and
  **stop**.

## 1. Detect (read-only, installs nothing)

Ask the installer for the current state in its non-installing `--check` mode:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs" --check
```

It prints one line of JSON to stdout: `{ dataDir, installed, depsPresent, browserPresent,
markerMatches, missing, engineDeps, browser }`. `--check` **never installs** — it only reads the data
dir. `Read` the JSON; call it `$STATE`.

- If the command itself fails (e.g. `CLAUDE_PLUGIN_DATA` unset), relay its message and **stop**.

## 2. Already set up?

If `$STATE.installed` is `true`, Visual Guard is **already bootstrapped** — the engine deps and
Chromium are in place. Tell the user there's nothing to do and they can run `/visual-init` (to create
a config) or `/visual-check` (to run). **Stop** — do not reinstall.

## 3. Explain + ask (the consent gate)

If `$STATE.installed` is `false`, present a clear, honest plan with **AskUserQuestion** before doing
anything. State all of:

- **What** — the engine packages from `$STATE.engineDeps` (list them by name, e.g. `playwright`,
  `sharp`, `pngjs`, `pixelmatch`, `culori`, `postcss` (+ `postcss-less` / `postcss-scss`), `tsx`,
  `typescript`) **plus a pinned browser**: `$STATE.browser` (Chromium, pinned, via Playwright).
- **Why** — these render screenshots of *your* UI locally so Visual Guard can pixel-diff it; without
  them `/visual-check` can't run.
- **Where** — the plugin's own data dir, `$STATE.dataDir` (**not** your project, not your
  `node_modules`). Nothing is added to your repo.
- **Size + time** — roughly **~150 MB** download (mostly Chromium) — a few hundred MB on disk once
  unpacked — **one-time**, about **1–2 minutes** on a normal connection.
- **Privacy** — everything stays on your machine; nothing is sent to any external service.

Then ask the gate question with two options:

- **Install now** — proceed to §4.
- **Not now** — decline; go to §5.

Wait for an explicit choice. Do not install on silence or a hedge.

## 4. Install (only after approval)

Run the installer with **no flag** (the default install path — same one the `SessionStart` hook
uses). It installs the deps + Chromium into the data dir and wires the engine into the plugin root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"
```

- This streams progress to the terminal and can take a minute or two.
- Judge success by the **exit code**: `0` = installed, non-zero = failed.
  - On success, tell the user the engine is ready and hand off: run `/visual-init` to create a config
    (if they don't have one), then `/visual-check` to run.
  - On failure, surface the installer's error output verbatim and suggest retrying `/visual-setup`
    (or starting a fresh session so the `SessionStart` hook retries). Change nothing else.

## 5. Declined

If the user chose **Not now**, change nothing — install **nothing**. Explain plainly that none of the
capture commands (`/visual-check`, `/visual-baseline`, `/visual-ci`, `/visual-coverage`, `/visual-init`,
`/visual-review`) can run until the engine is installed — each one will offer to install it again the
next time it's run, or they can run `/visual-setup` whenever they're ready to approve it.

## Boundaries

- **Consent-gated.** NEVER installs without an explicit "Install now". On decline, NOTHING changes.
- **Data-dir only.** Installs into `${CLAUDE_PLUGIN_DATA}` (the plugin's own dir) — NEVER your
  project, source, or repo `node_modules`.
- **Local-only.** The download is from the npm registry + Playwright's browser CDN; no screenshot or
  project data is sent anywhere.
- **Idempotent.** If already installed (`$STATE.installed`), it does nothing.

> Non-interactive use (CI / scripting): the `SessionStart` hook installs automatically on first
> session, or run `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"` directly.
