---
description: Reconfigure an existing visual.config.json — add or remove a Figma library, add a Storybook/Ladle target, regenerate stories for new components, or change capture preferences — without losing your committed baselines.
argument-hint: ""
---

# /visual-config — change sources & preferences (reconfigure)

Edit an **existing** `visual.config.json` after the first-run `/visual-init`. Use this to **add or
remove a Figma library**, **add a Storybook/Ladle target**, **regenerate stories** for components added
since you scaffolded a harness, or **change preferences** (viewports / states / thresholds) — all while
**preserving your committed baselines** (they live in `baselineDir`, independent of the config).

Use the **AskUserQuestion** tool for every choice. This command rewrites exactly one file
(`visual.config.json`) through the same validated, `--force`-gated writer `/visual-init` uses; it never
touches a baseline and sends nothing external. (For a brand-new project with no config, use
`/visual-init` instead.)

## Show this first — banner + plan

Open your response with this banner, **printed verbatim in a code block**, before any tool call:

```text
         ▄██▄
    ████▄████▄████
    █████▀██▀█████     V I S U A L  G U A R D
   ▄▄██▀██▀▀██▀██▄▄    ─────────────────────────
  ███████ ██ ███████   Catch visual bugs before they merge
   ▀▀██▄██▄▄██▄██▀▀    for design system teams.
    █████▄██▄█████     reconfigure
    ████▀████▀████
         ▀██▀
```

Then lay out the plan in plain language:

- **1 · Preflight** — engine ready + an existing config found (read-only)
- **2 · Review** — show your current sources (targets · tokens · Figma)
- **3 · Change** — pick what to add / remove / adjust
- **4 · Write** — save the updated `visual.config.json` (only after your final yes)

**Narrate as you go.** Before each tool call, print a one-line `▸ Step N/4 · <name>` that says in plain
words what it does and whether it changes anything (read-only vs writes).

## 0. Preflight

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't running as an installed
  plugin — tell the user and **stop**.
- **Check the engine** (read-only) exactly as `/visual-init` does: `node
  "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs" --check`; if not installed, run the same
  setup-consent flow, and only continue once it's installed.
- Resolve `$CONFIG` — the first that exists of `visual.config.json` or `config/visual.config.json`.
  **If neither exists**, there's nothing to reconfigure — tell the user to run **`/visual-init`** first
  and **stop**.

## 1. Review the current config (read-only)

`Read` `$CONFIG` and show the user, in plain language, what's configured today:

- **Targets** — each `type` + `url` (+ `name`/`managed` if set). Note whether capture is per-component
  (`storybook`/`ladle`) or per-page (`app`).
- **Tokens** — the `tokens.sources` paths (or "engine default" if absent).
- **Figma** — the linked `figma.files` (by `label`/key), or "not linked — code-only".
- **Scope & performance** — `concurrency` (capture-pool size, "auto" if absent) and the `scope` block
  (`fanoutThreshold` · `fanoutMinStories` · `scope.globalGlobs` · `fingerprintSkip`), or "engine
  defaults" if absent.
- **Matrix size** — multiply discovered stories × `viewports` (× `states` for app targets) and state
  the full-sweep size, e.g. *"4,800 stories × 3 viewports = 14,400 renders. A full sweep; `/visual-check`
  is change-scoped by default and captures only what a change affects; `--all` sweeps everything."* If
  that's large (> ~2,000 renders), suggest setting `concurrency` (and a static `build-storybook` target
  for `--all`).

## 2. Choose what to change

Ask with **AskUserQuestion** (multi-select) which changes to make. Offer the options that apply:

- **Add / connect Figma** — link a design library (only if `figma` is absent or to add another file).
- **Remove Figma** — drop the `figma` block (the studio falls back to code-only; nothing else changes).
- **Add a target** — a Storybook or Ladle URL, or an app target with routes.
- **Regenerate stories** — for a project with a scaffolded Ladle harness, re-run the scaffolder to add
  stories for components created since (idempotent — never overwrites edited stories).
- **Change preferences** — `viewports`, `states`, `threshold`, `maxDiffRatio`.
- **Scope & performance** — set `concurrency` (parallel capture), and tune change-scoping via the
  `scope` block: `fanoutThreshold` (0–1, default 0.4 — a changed file imported by more than this
  fraction of the library widens to a full sweep), `fanoutMinStories` (default 8), and
  `scope.globalGlobs` (extra globs that force a full sweep — use it to mark a project-specific global
  file, e.g. a theme provider applied via a Storybook decorator that no story closure reaches).
- **Fingerprint-skip** — `scope.fingerprintSkip` (default `false`). When `true`, `/visual-check` COPIES
  a baseline forward instead of re-screenshotting a render whose inputs are **byte-identical to
  approval** (component closure + globals + the pinned engine), making big-library sweeps far cheaper.
  Explain the **trust boundary** before enabling: a skip trusts the baseline; it cannot witness host-OS
  font drift, a swapped Chromium binary at the same version, remote/CDN assets, or shell-injected env
  (a rotating ~`sqrt(N)` sample is re-shot each run so such drift is caught within a bounded number of
  runs, and a plain `/visual-check --all` is always the full backstop). With it enabled, scoped runs
  skip automatically; a full `--all` sweep skips **only** with an explicit `--all --skip-unchanged`.

Then gather the details for each chosen change:

- **Figma (add):** collect the **file URL** for each library (paste verbatim — the engine extracts the
  key) and an optional `label`. Probe the Figma desktop MCP for availability (advisory, as in
  `/visual-init` §3.5); never block on a closed Figma. Set/extend `figma.files`.
- **Figma (remove):** drop the `figma` key entirely from the config object.
- **Add a target:** collect the URL; for an app target, collect routes; classify Storybook vs Ladle by
  asking (or by what the user runs). Append to `targets`.
- **Regenerate stories:** run `harness.ts --dir <componentDir>` (dry-run) → show the new files →
  **AskUserQuestion** to confirm → `harness.ts --dir <componentDir> --apply` → run the reported install
  if `@ladle/react` was newly added. This writes source files (consent-gated, idempotent), exactly as
  `/visual-init` §1.6 — the config target usually doesn't change.
- **Preferences:** collect the new values; include them explicitly in the written config.

## 3. Preserve baselines (important)

Config edits never touch `baselineDir` — your committed baseline PNGs are safe. The **one** risk is a
target **rename**: a target's `name` (or its URL host:port when `name` is absent) is the `instance`
path segment under `baselineDir`, so renaming it **orphans** the existing baselines under the old path.
If a change would rename a target, **warn the user explicitly** and offer to keep the existing `name`.
Removing Figma is always safe (code-only is byte-compatible).

## 4. Confirm + write

Assemble the **full** updated config object — start from the current `$CONFIG`, apply the chosen
changes, and keep everything else unchanged. Show it and ask for a **final yes**.

Write it through the engine (same validated, no-clobber writer as `/visual-init`; `--force` because a
config already exists, `--config` only if the existing file isn't at the default path):

```bash
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"

"$RUNNER" "$SCRIPTS/init.ts" --stdin --force ${CONFIG_FLAG} <<'JSON'
{
  "targets": [ ... the full, confirmed targets ... ],
  "figma": { "files": [ ... ] },
  "tokens": { "sources": [ ... ] }
}
JSON
```

- Include `figma` **only** when the user wants it linked (omit the key entirely to remove it).
- Include `tokens` only when a token source is configured; omit `viewports`/`states`/etc. unless the
  user changed them (so the engine defaults keep applying to the rest).
- Include `scope` and/or `concurrency` **only** when the user set them (omit to keep engine defaults).
- Confirm success from the result JSON (`written: true`, the `configPath`).

## 5. What's next

- Remind the user to **commit** `visual.config.json` (and any newly-scaffolded `.ladle/` + `*.stories.*`).
- If they added a source, hand off to **`/visual-check`** (capture + diff) then **`/visual-baseline`**.
- If they connected Figma, with the desktop app open run **`/visual-sync`** then **`/visual-studio`**.

## Boundaries

- **Writes `visual.config.json`** (and, only via the consent-gated `harness.ts --apply` regenerate path,
  scaffolded `.ladle/` + `*.stories.*`) — never a baseline, never outside the project root.
- **Never clobbers** without the explicit final yes (the engine requires `--force` to overwrite).
- **Local-only.** No screenshots or project data are sent anywhere; the optional Figma-MCP check talks
  only to your local Figma desktop app, and only the non-secret file key is written.
