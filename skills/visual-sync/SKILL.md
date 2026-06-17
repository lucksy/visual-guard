---
name: visual-sync
description: Populate Component Studio's dual baselines — code snapshots via the headless engine and Figma design snapshots via the Figma desktop MCP, fanned out across subagents. Code-first and idempotent; works code-only with zero Figma, and leaves components figma-pending when the Figma app is closed. Use to sync the studio before browsing it with /visual-studio.
argument-hint: "[target]"
---

# /visual-sync — populate the studio (code = engine · Figma = MCP workflow)

This skill orchestrates Component Studio's sync as a **dynamic workflow**. Plugins can't bundle a
workflow directly, so it ships the orchestration as a **script template** (`workflow.template.js`,
next to this file) and launches it for you with the Workflow tool. **Code capture is the headless
engine**; **Figma capture is the Figma desktop MCP** fanned out across subagents (MCP tools are
agent-callable only — that is exactly what the workflow is for). **There is no token** — Figma auth
lives in the desktop app; only non-secret ids/names/paths/images are stored, all under your repo.

## 0. Preflight — engine check (every run)

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't running as an installed
  plugin — tell the user and **stop**.
- **Check the engine first.** Code sync uses the same engine as `/visual-check`, so detect it
  **without installing anything**:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs" --check
  ```

  `Read` the one-line JSON (`$STATE`). If `$STATE.installed` is **false**, run the setup-consent flow
  inline (the same one `/visual-setup` performs): with **AskUserQuestion**, show *what*
  (`$STATE.engineDeps` + `$STATE.browser`), *why* (render screenshots of the UI locally), *where*
  (`$STATE.dataDir`), and *size* (~150 MB, one-time). On **Install now** → run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"` and continue once it exits `0`; on **Not
  now** → **stop**. When `$STATE.installed` is true, continue.
- **Figma is optional.** The workflow itself probes the Figma desktop MCP and, if it's unavailable,
  syncs code and leaves Figma-linked components `figma-pending` — never a hard failure. Code-only
  projects (no `figma` in config) sync fully with no Figma at all.

## 1. Launch the workflow

Invoke the **Workflow** tool with the bundled template and the project context as `args` (pass
`$ARGUMENTS` as an optional `target` to narrow the code capture):

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/visual-sync/workflow.template.js",
  args: {
    pluginRoot: "${CLAUDE_PLUGIN_ROOT}",
    configPath: "<visual.config.json | config/visual.config.json | ${CLAUDE_PLUGIN_ROOT}/config/visual.config.json>",
    outRoot: ".visual-guard",
    fileKey: "<config.figma.files[0].key for the open file>",  // omit for a code-only project
    target: "$ARGUMENTS"   // omit when empty
  }
})
```

> Pass `fileKey` from the config's `figma.files[]` (the key of the Figma file the user has open). The
> MCP is bound to the open desktop file, so this is how the sync namespaces matches per file (D11) —
> for a multi-file library, the user opens each file and re-runs.

The template (see [workflow.template.js](workflow.template.js)) runs **Preflight → Code → Enumerate →
Reconcile → Capture**: it syncs code headlessly first (value appears immediately), then — if the Figma
desktop app is open — enumerates components via `get_metadata`, matches Figma↔code (override map >
unambiguous normalized name > surfaced), and fans out subagents that `get_screenshot` each node and
record it through `record-figma.ts`. It is **content-hash idempotent** (an unchanged design adds no
history) and **resumable** (a node whose screenshot fails stays figma-pending).

## 2. Present the result + next step

Report the workflow's summary: code snapshots synced, Figma components enumerated/recorded, and any
left figma-pending (with why — Figma app closed mid-run, etc.). Then point the user at
**`/visual-studio`** to browse the gallery once it lands (P3/P4), or **`/visual-check`** for a
code-only regression pass.

## 3. Offer to save it as `/visual-sync`

A plugin can't pre-save a workflow, so after the run tell the user they can keep it: run `/workflows`,
select this run, press **`s`** to save it to `.claude/workflows/visual-sync.js` — then `/visual-sync`
is a one-step command in future sessions.

## Boundaries

- **No token, ever.** Figma is read through the desktop MCP; nothing secret is created or stored.
- **Code-first.** Code always syncs (headless); Figma is interactive-only and additive.
- Writes only under `.visual-guard/` (the gitignored DB + blob cache) and the committed
  `.visual-baselines/.figma/` + `figma_meta.json` design baselines — **never your source**.
