---
description: Populate Component Studio — sync code snapshots with the headless engine and Figma design snapshots via the Figma desktop MCP. Code-first, idempotent, no token; works code-only and leaves components figma-pending when Figma is closed.
argument-hint: "[target]"
---

# /visual-sync — populate the studio (code = engine · Figma = MCP)

**Output style — keep it lean.** Write for a non-technical user, in plain text with no emoji or status icons; keep the banner (it is line-art). Before each action, print ONE short line of what it is doing and whether it only reads or also changes things — so a permission prompt is never a surprise — then report the result in a few plain lines. Never show raw JSON, internal variable names (`$STATE`, `$RUNNER`, `dataDir`, install markers), absolute plugin paths, or a technical health/diagnostics table. End with one short `Next: …` line. The steps below are your runbook: follow them exactly, but surface only what the user needs to see.

Run Component Studio's dual sync now. This command does the **engine + Figma-MCP preflight**, then
launches the bundled **visual-sync** dynamic workflow (the orchestration lives in
`skills/visual-sync/`). The optional `$ARGUMENTS` is a `--target` filter (a component name, an
instance label, or `instance/name`) that narrows the code capture. **No token** is involved — Figma
is read through the desktop app's MCP; only non-secret ids/names/paths/images are stored, under your repo.

## Show this first — the banner

Open your response with this banner, **printed verbatim in a code block**, before any tool call:

```text
         ▄██▄
    ████▄████▄████
    █████▀██▀█████     V I S U A L  G U A R D
   ▄▄██▀██▀▀██▀██▄▄    ─────────────────────────
  ███████ ██ ███████   Catch visual bugs before they merge
   ▀▀██▄██▄▄██▄██▀▀    for design system teams.
    █████▄██▄█████     Figma <-> code sync
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
- **Native health — code sync loads SQLite (`better-sqlite3`).** If `.installed` is true but `.healthy`
  is **false** (`.brokenNatives` lists the broken addons), run the exact command in **`.repair`** (the
  sanctioned in-place self-heal — do **NOT** improvise a manual `npm rebuild` in a guessed directory),
  then continue. If still unhealthy — or `.systemSupported` is **false** — relay `.reason` and **stop**
  (sync would crash otherwise).
- **Figma-MCP availability (advisory, never blocking).** Probe the desktop app: call
  **`mcp__figma-desktop__get_metadata`** with no node id. If it lists pages/a selection → Figma is
  ready. If it errors that the server/file is unavailable → tell the user *"Open your Figma file in the
  desktop app to sync designs; code will still sync now."* Do **not** stop — the workflow itself
  handles a closed Figma by syncing code and leaving Figma components `figma-pending`.
- Resolve `$CONFIG`: the first that exists of `visual.config.json`, `config/visual.config.json`, else
  `${CLAUDE_PLUGIN_ROOT}/config/visual.config.json`.

## 1. Launch the workflow

Invoke the **Workflow** tool with the bundled template (pass `$ARGUMENTS` as `target` only when set):

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/visual-sync/workflow.template.js",
  args: { pluginRoot: "${CLAUDE_PLUGIN_ROOT}", configPath: "$CONFIG", outRoot: ".visual-guard",
          fileKey: "<config.figma.files[0].key>", target: "$ARGUMENTS" }
})
```

Pass `fileKey` from the config's `figma.files[]` (the open file's key) so Figma↔code matching is
namespaced per file (D11); omit it for a code-only project.

The workflow runs **Preflight → Code → Enumerate → Reconcile → Capture → Conformance**: code syncs
headlessly first (value immediately), then — Figma app open — components are enumerated, matched to
code, and captured by fanned-out subagents through `record-figma.ts`; finally it scores the **advisory
Figma↔code parity** (`studio.ts conformance`). It is content-hash idempotent and resumable, and prunes
out-of-window history at the tail.

## 2. Present + next step

Relay the workflow summary (code synced · Figma enumerated/recorded · any figma-pending · conformance
scored), then suggest **`/visual-studio`** to browse the parity gallery, or **`/visual-check`** for a
code-only pass. Conformance is **advisory only** — it never gates a build (that's `/visual-ci`).

## Boundaries

- **No token**; Figma via the desktop MCP only. **Code-first**; Figma additive + interactive-only.
- Writes only under `.visual-guard/` (gitignored DB + blob cache) and the committed
  `.visual-baselines/.figma/` + `figma_meta.json` — never your source. Nothing is sent off-machine.
