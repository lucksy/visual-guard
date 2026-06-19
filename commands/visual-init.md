---
description: Guided wizard that scaffolds a visual.config.json — detects your dev servers and design tokens, optionally links your Figma design library (no token), confirms each with you, lets you enter your own when something's wrong or missing, then writes the config.
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

## Show this first — banner + plan

Open your response with this banner, **printed verbatim in a code block**, before any tool call:

```text
         ▄██▄
    ████▄████▄████
    █████▀██▀█████     V I S U A L  G U A R D
   ▄▄██▀██▀▀██▀██▄▄    ─────────────────────────
  ███████ ██ ███████   Catch visual bugs before they merge
   ▀▀██▄██▄▄██▄██▀▀    for design system teams.
    █████▄██▄█████     setup wizard
    ████▀████▀████
         ▀██▀
```

Then lay out the plan in plain language, so the user knows what's coming before anything runs:

- **1 · Preflight** — confirm the engine is installed (read-only, nothing changes)
- **2 · Detect** — find your running dev servers and design-token files
- **3 · Confirm** — you approve each target, token source, and optional Figma link
- **4 · Write** — save `visual.config.json` (only after your final yes)

**Narrate as you go.** Before each step's tool call, print a one-line `▸ Step N/4 · <name>` that says in plain words what it does and whether it changes anything (read-only vs writes) — so a permission prompt is never a surprise. Never run a raw command without that context.

## 0. Preflight

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't running as an installed
  plugin — tell the user and **stop**.
- **Check the engine first — every run.** The wizard's detection step uses the engine runner, so
  detect it **without installing anything**:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs" --check
  ```

  `Read` the one-line JSON (`$STATE`). If `$STATE.installed` is **false**, run the setup-consent flow
  inline (the same one `/visual-setup` performs): with **AskUserQuestion**, show *what*
  (`$STATE.engineDeps` + `$STATE.browser`), *why* (render screenshots of the UI locally), *where*
  (`$STATE.dataDir` — the plugin's data dir, **not** your project), and *size* (~150 MB, one-time).
  On **Install now** → run `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"` and continue once
  it exits `0`; on **Not now** → **stop** (nothing changes). When `$STATE.installed` is true, continue.

## 1. Detect (writes nothing)

Run the detector in dry-run from the **project root** to see what's reachable and what tokens exist:

```bash
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"

"$RUNNER" "$SCRIPTS/init.ts" --dry-run
```

It prints JSON: `{ detection: { probes, targets, tokenCandidates, tokenSources, usedFallback,
projectKind, harness?, componentLibrary?, framework, scaffoldableHarness }, config, configPath,
existingPath, written, dryRun }`. The
probe never errors on a down port, so this step cannot crash. Use `detection` as the wizard's
**starting answers** — do not just write `config` blindly; confirm it with the user first.

## 1.5 Capture layer — design system vs app (read this BEFORE asking about targets)

**Visual Guard is for design-system teams, and a design system is _components_, not pages.** The engine
captures a component in isolation only through a **story explorer** (Storybook / Ladle / Histoire),
because that's what gives each component a URL. App **routes** (`/login`, `/dashboard`) are *pages a
design system consumes* — the app-regression fallback, **not** the design system. Branch on
`detection.projectKind`:

- **`harness`** — a story explorer was detected (`detection.harness`) or a reachable Storybook was
  probed. This is the design-system path: Visual Guard captures **each component (story) in isolation**.
  Use the `storybook` target. Tell the user *"Detected `<harness>` — I'll capture your components, not
  pages."* and **skip the routes question entirely**. Go to step 3.

- **`component-library`** — a component library exists in code (`detection.componentLibrary`, e.g.
  *"360 component files in `src/components`"*) but there's **no story explorer**. Do **not** default to
  routes. **Branch on `detection.framework`** (the wizard now detects React/Vue/Svelte):

  - **React** (`detection.framework === "react"`) — Visual Guard can **scaffold a story explorer for
    you**. Tell the user: *"You have `<fileCount>` components in `<dir>` but no story explorer. I can
    scaffold Ladle — a lightweight React story explorer — into your repo (one config file + one story
    per component), then capture each component in isolation."* Ask with **AskUserQuestion**:
    - **Scaffold Ladle for me** (recommended) — go to **§1.6** (the consent-gated scaffold).
    - **Point me at a running explorer** — collect the URL (a Storybook/Ladle on some port) and use it
      as a `storybook` (or `ladle`) target. Go to step 3.
    - **Capture app pages instead** — proceed to step 2 as an **app** target, but say clearly this is
      *app-page regression, not a review of your design system*.

  - **Vue / Svelte / other** (`detection.framework !== "react"`) — auto-scaffolding isn't wired for your
    framework yet (it's coming). Tell the user plainly they have a design system but no story explorer,
    then ask with **AskUserQuestion**: **Point me at a running explorer** (collect URL → `storybook`
    target, step 3), **I'll set up a story explorer first** (recommended — point them at
    `https://storybook.js.org/docs` or Histoire for Vue/Svelte, write a template `storybook` target,
    tell them to run it then re-run `/visual-check`), or **Capture app pages instead** (step 2, framed
    as app pages, not the design system).

- **`app`** — no harness and no component library, but a reachable app. Proceed to step 2 (routes) and
  frame it as **app pages** — make clear this captures pages, not a design system.

- **`empty`** — nothing detected. Offer a Storybook template (the DS default) or ask what they have.

## 1.6 Scaffold a Ladle harness — consent-gated (React component-library only)

This is the **one** Visual Guard action that writes into your **source tree** (not just
`visual.config.json`): it adds `.ladle/config.mjs`, one `*.stories.tsx` per component, and the
`@ladle/react` dev dependency, then installs it. So it is **explicitly gated** — preview first, write
only on a clear yes. Reached only from §1.5's React branch when the user chose *"Scaffold Ladle for me"*.

1. **Preview (writes nothing).** Run the scaffolder in dry-run from the project root, pointing `--dir`
   at the detected component library (`detection.componentLibrary.dir`):

   ```bash
   RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
   SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"
   DIR="src/components"   # ← detection.componentLibrary.dir
   "$RUNNER" "$SCRIPTS/harness.ts" --dir "$DIR"
   ```

   It prints JSON: `{ applied: false, files: [{ path, role }], skipped, devDependency,
   needsPropsWarnings, componentCount, packageManager, installCommand }`. Nothing is written.

2. **Show the user EXACTLY what will happen** and ask with **AskUserQuestion** (*"Scaffold these N
   files and install Ladle?"*). State all of:
   - the file list — `.ladle/config.mjs` + each `*.stories.tsx` (and `skipped`, if re-running),
   - that `@ladle/react` will be added to `package.json` and **`<installCommand>` will run in your
     project** (this touches your `node_modules`),
   - any `needsPropsWarnings` — *"`<Modal>`, `<Form>` may render blank until you pass props; I leave a
     TODO in each generated story so you know where to edit."*

   Proceed only on a clear **Yes**. On **No**, fall back to §1.5's other options (point at a running
   explorer, or app pages).

3. **Apply** (only after Yes): write the files, then install so the harness can run. `harness.ts
   --apply` is **idempotent** (never overwrites a story you've edited) and **path-guarded** (refuses to
   write outside the project root or into `node_modules`/`.git`/`.visual-*`/`dist`).

   ```bash
   "$RUNNER" "$SCRIPTS/harness.ts" --dir "$DIR" --apply
   # then run the install the dry-run reported, from the project root (e.g. `npm install`):
   <installCommand>
   ```

4. **Write a managed Ladle target and continue.** Pick a free port (e.g. `61000`) and use this as the
   project's single target — `managed: true` tells `/visual-check` to start/stop the harness for you.
   **Skip step 2** (the target is decided) and continue at **step 3** (token source) → 3.5 (Figma,
   still optional) → 4 (write):

   ```json
   { "type": "ladle", "url": "http://localhost:61000", "managed": true }
   ```

   Tell the user: *"Done — `/visual-check` will boot Ladle, capture every component, and stop it. Edit
   the generated `*.stories.tsx` to pass props or add states; re-run `/visual-config` later to add more."*

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

## 3.5 Design system (Figma) — optional, no token

Visual Guard can also track each component's **Figma design** beside its code render (Component
Studio). This step is **fully optional and skippable** — code-only mode works with zero Figma
config. **There is no token to enter:** Figma is read through the Figma desktop app's MCP
(`mcp__figma-desktop`), so nothing secret is ever stored — only the non-secret file key(s).

Ask with **AskUserQuestion**: *"Connect a Figma design library now?"*

- **Skip** (recommended for a first run) — write **no** `figma` block; the studio runs code-only.
  Continue to step 4.
- **Connect Figma** — collect the library as below.

If they connect:

1. **Check the Figma MCP is available (advisory).** Probe that the desktop app is connected and a
   file is open by calling **`mcp__figma-desktop__get_metadata`** with no node id (the open file's
   root). Map what you see to one status and relay the matching message:

   - tool **missing / errors as unavailable** → **no-server**: *"Open the Figma desktop app, enable
     its MCP / Dev Mode server, then continue."*
   - tool **responds but reports no open document** → **no-file**: *"Open your Figma file in the
     desktop app, then continue."*
   - tool **returns a node tree** → **ready**.

   This check is **advisory** — the user can record the file key(s) now and run the real capture
   later with `/visual-sync` once Figma is open. **Do not block** on it; never treat a closed Figma
   as a failure.

2. **Collect the file key(s).** Ask the user to paste the **Figma file URL** for each library file
   (the desktop app's *Copy link*, or the browser address bar). For each, optionally ask for a short
   **label** (e.g. "Core", "Marketing") used as the gallery's library filter. **Paste the URL
   verbatim** — the engine extracts the file key from it (`figma.com/design/<key>/…`) and validates
   it on write; you do **not** extract the key yourself. (Paste the **file** URL, not a Figma
   *community* link — `figma.com/community/file/…` is out of scope and is rejected.)

3. **Component map (optional).** If the user already knows a Figma-name → code-name override (e.g.
   `BtnPrimary` → `Button`), collect it into `figma.componentMap`. Otherwise omit it — `/visual-sync`
   matches by normalized name and surfaces the rest as `figma-only` / `code-only`.

## 4. Confirm + write

Build the final config object from the confirmed answers — `{ "targets": [...] }`, plus
`"tokens": { "sources": [...] }` only if the user chose a token source, plus
`"figma": { "files": [...] }` only if the user connected Figma (omit it entirely otherwise).
Everything else (`viewports`, `states`, `threshold`, `maxDiffRatio`, `baselineDir`, `uiGlobs`) is
intentionally omitted so the engine defaults apply.

**Show the final config and ask for a final yes** before writing.

**If `detection.existingPath` is non-null**, a `visual.config.json` (or `config/visual.config.json`)
already exists. Confirm explicitly — *"Overwrite the existing config at `<existingPath>`?"* — and:

- **Yes, overwrite** → write with `--force`.
- **No — write somewhere else** → ask for an alternate path and write with `--config <path>` (no
  `--force` needed for a fresh path), so the user still gets a scaffold without losing their file.
- **No — cancel** → change nothing; point them at the existing file to edit by hand.

Write the confirmed config to `.visual-guard/pending-config.json` with the **`Write` tool**, then hand
it to the engine with `--from-file`. (Writing the file + one `--from-file` command — instead of a
heredoc the permission engine can't analyze — is what keeps this to a single prompt.) The engine still
validates the config round-trips through the same `parseConfig` the rest of Visual Guard loads with,
and re-checks the no-clobber and project-root guards.

The JSON to `Write` — include the `figma` block **only when the user connected Figma** (drop it for
code-only setups); a pasted Figma **URL** is fine in `files[].key`, the engine extracts the bare key:

```json
{
  "targets": [{ "type": "storybook", "url": "http://localhost:6006" }],
  "figma": {
    "files": [
      { "key": "https://www.figma.com/design/AbCdEf1234567890/Acme?node-id=0-1", "label": "Core" }
    ]
  }
}
```

Then run — append `--force` **only** when the user approved an overwrite, and `--config <path>` **only**
when they chose to write elsewhere:

```bash
"${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx" "${CLAUDE_PLUGIN_ROOT}/scripts/init.ts" --from-file .visual-guard/pending-config.json
```

Confirm success from the result JSON (`written: true`, the `configPath`).

## 5. What's next

- Tell the user where the config was written and remind them to **review/edit** it (add `name`s,
  tune `viewports`, adjust app `routes`).
- Hand off the first run: once their Storybook / dev server is up, run **`/visual-check`** to capture
  and diff, then **`/visual-baseline`** to approve the first renders.
- **If they connected Figma:** with the Figma desktop app open on the library file, run
  **`/visual-sync`** to populate the design baselines, then **`/visual-studio`** to browse parity.
- Remind them to **commit** `visual.config.json` so the whole team shares the same targets and gates.

## Boundaries

- **Writes exactly one file** (`visual.config.json`, at the project root or a path the user chose) —
  never your source, never a baseline, never outside the project root (the engine hard-guards it).
- **Never overwrites** an existing config without an explicit confirmation (`--force`).
- **Local-only.** The port probe and token scan happen on your machine; nothing is sent anywhere.
  The optional Figma-MCP availability check talks only to your local Figma desktop app — **no token
  is ever created or stored**, and the only thing written to config is the non-secret file key.

> Non-interactive use (CI / scripting): `init.ts` with no `--stdin` auto-detects and writes without
> prompting; `--dry-run` previews and `--force` allows an overwrite.
