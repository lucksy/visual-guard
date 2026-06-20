---
description: Capture the UI a change affects (or all targets), pixel-diff against the baseline, and explain what changed.
argument-hint: "[target] [--all] [--since <ref>]"
---

# /visual-check — capture → pixel-diff → explain a UI change

Execute Visual Guard's Phase-0 visual regression check now, following the
**gather → act → verify** loop below. Use `Bash` to run the engine and `Read` to read its
JSON output. The optional target is `$ARGUMENTS` (a component name, an instance label, or
`instance/name`). This command is **read-only** with respect to the user's source — never
edit a file to "make the check pass", and never approve a baseline (that is `/visual-baseline`).

## Show this first — banner + plan

Open your response with this banner, **printed verbatim in a code block**, before any tool call:

```text
         ▄██▄
    ████▄████▄████
    █████▀██▀█████     V I S U A L  G U A R D
   ▄▄██▀██▀▀██▀██▄▄    ─────────────────────────
  ███████ ██ ███████   Catch visual bugs before they merge
   ▀▀██▄██▄▄██▄██▀▀    for design system teams.
    █████▄██▄█████     visual check
    ████▀████▀████
         ▀██▀
```

Then lay out the plan in plain language, so the user knows what's coming before anything runs:

- **1 · Preflight** — engine ready + config found (read-only)
- **2 · Scope** — decide what to capture: only the components your change affects (default), or everything (`--all`)
- **3 · Capture** — screenshot the in-scope UI in a headless browser
- **4 · Diff** — compare each render against its approved baseline
- **5 · Explain** — what changed visually, and the likely cause

**Narrate as you go.** Before each step's tool call, print a one-line `▸ Step N/5 · <name>` that says in plain words what it does and whether it changes anything (read-only vs writes) — so a permission prompt is never a surprise. Never run a raw command without that context.

## 0. Preflight (fail fast, actionably)

The engine and a pinned Chromium are installed into `${CLAUDE_PLUGIN_DATA}` by the
`SessionStart` hook (`install-deps.mjs`); that installer is the contract for where the runner
and browser live. Before running anything:

- If `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` is unset, this isn't running as an
  installed plugin — tell the user and **stop**.
- **Check the engine first — every run.** The engine (runtime deps + a pinned Chromium) installs into
  `${CLAUDE_PLUGIN_DATA}` on the first session. Detect it **without installing anything**:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs" --check
  ```

  `Read` the one-line JSON (`$STATE`). If `$STATE.installed` is **false**, do **not** improvise a
  download — run the setup-consent flow inline (the same one `/visual-setup` performs): with
  **AskUserQuestion**, show *what* (`$STATE.engineDeps` + `$STATE.browser`), *why* (render screenshots
  of the UI locally so Visual Guard can diff it), *where* (`$STATE.dataDir` — the plugin's data dir,
  **not** your project), and *size* (~150 MB, one-time). On **Install now** → run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"` and continue once it exits `0`; on **Not
  now** → **stop** (nothing changes). When `$STATE.installed` is true, just continue. Never improvise
  another runner or download anything yourself.
- **Native health (every run).** If `$STATE.installed` is true but `$STATE.healthy` is **false**
  (`$STATE.brokenNatives` lists the broken addons), the engine's native bindings didn't load from the
  tree the scripts use; run `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-deps.mjs"` to repair them in
  place, then continue (if `brokenNatives` is still non-empty afterward, relay it and **stop**).
- Resolve the project's config — the first that exists of `visual.config.json`,
  `config/visual.config.json`, else the bundled default
  `${CLAUDE_PLUGIN_ROOT}/config/visual.config.json`. Call it `$CONFIG`.

## 1. Gather — parse the arguments into a scope intent

Read `$ARGUMENTS` and decide the scope intent below — in §2 you turn it into `check.ts` flags:

- A bare word (no leading `--`, e.g. `Button` or `components/Button`) → **`EXPLICIT`** = that word.
  An explicit target is captured directly and is **never** change-scoped.
- `--all` present → **`ALL`** = `1` (full sweep — the source of truth; what CI uses).
- `--since <ref>` present → **`SINCE`** = `<ref>` (scope the change against that git base instead of
  `HEAD`).
- `--skip-unchanged` present → **`SKIP`** = `1`. This is the explicit, per-invocation opt-in to copy a
  baseline forward instead of re-screenshotting a render whose inputs are byte-identical to approval
  (capture fingerprint-skip). It is REQUIRED to skip under `--all` — a plain `--all` always stays a true
  full capture (the backstop). In a scoped run, the persisted config `scope.fingerprintSkip: true`
  enables it without the flag.
- Nothing (the common case) → all empty → **change-scoped** vs `HEAD`.

Then surface the changed UI files as context: run `git diff --name-only HEAD` and
`git ls-files --others --exclude-standard`, keep the ones matching the config's `uiGlobs`, and show
them, e.g. `Changed UI files: Button.tsx · button.css`. (The actual scope decision is made
deterministically by `scope.ts` in §2 — this is just the human-facing banner.)

## 2. Act — capture → diff → report (one engine command)

Run the whole pipeline as a **single command** from the **project root**. The `check.ts` orchestrator
does the coordination that used to live in shell — it starts a managed harness if the config has one
and **always** stops it afterward (even on failure), resolves scope, captures (explicit/scoped/all),
diffs against the baseline, writes the report, and clears the pending-review marker — and the engine
writes nothing outside `.visual-guard/` (gitignored). Generating the whole run from one analyzable
command (no `trap`/`$( )`/branching in the prompt) is also what keeps the permission prompt to one.

From §1's intent, append **only the flags that apply** (each is a literal flag, not a shell variable):

- explicit target → `--target <name>`
- `--all` → `--all`
- `--since <ref>` → `--since <ref>`
- `--skip-unchanged` → `--skip-unchanged`

Echo `▸ Step 2/5 · Capture + Diff — screenshot the in-scope UI and compare to baseline (writes only under .visual-guard/).` then run (append the §1 flags to this command):

```bash
"${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx" "${CLAUDE_PLUGIN_ROOT}/scripts/check.ts" \
  --config "$CONFIG" --cwd "$PWD"
```

`scope.ts`'s scope summary and any engine errors stream to your output as it runs. When it finishes,
`Read` **`.visual-guard/last-check.json`** — `{ runId, mode, ranCapture, manifestPath, error }`:

- `mode` is **`"none"`** → no UI changed since the base. Tell the user *"No UI changes since base —
  nothing to check. Run `/visual-check --all` to sweep everything."* and **stop** (the harness was
  already stopped).
- **`error` is set** (the command also exits non-zero) → relay the message the engine streamed above
  **verbatim** and **stop** — never fabricate results. Common cases: a managed harness that *"did not
  become reachable"* (suggest the user run their package manager's install so `@ladle/react` is
  present, then retry); capture *"could not reach …"* (a non-managed Storybook/app isn't running on
  that port); *"no targets matched"* (list a few valid stories/routes from the config).
- otherwise → keep `runId` + `manifestPath` for §3–§4.

**Surface the scope honestly.** Echo the `scope.ts` summary that streamed above — e.g. `Scoped —
2 components, 6 of 55,200 renders (55,194 out of scope). Full sweep: /visual-check --all.` A scoped
pass means "everything **in scope** passed," never "everything is fine." The full sweep (`--all`, and
CI) is the source of truth; the Phase-0 heuristic can miss a component imported by another, and
`--all` is the backstop. A **managed** harness run is render-error-tolerant: an auto-generated story
that fails to render is recorded as an `error`-status image (surfaced in §4), not a whole-run abort.

## 3. Review — structured verdict via the `visual-reviewer` subagent (Phase 1)

`Read` `.visual-guard/runs/<runId>/manifest.json` (the `runId` from `.visual-guard/last-check.json`; its paths are relative to the project root).
For every **flagged** target — one whose `status` is `fail`, `new`, or `error` (a `pass` target
needs no review) — invoke the read-only **`visual-reviewer`** subagent once, passing that target's
manifest entry (its `images` with `currentPath`/`baselinePath`/`diffPath`, pixel evidence,
`renderTarget`, `changedFiles`). The subagent classifies each changed image and returns a JSON
**array of verdicts** (`target`/`state`/`viewport` + `severity`/`classification`/`issue`/`file`/
`line`/`cause`/`impact`/`fix`).

Collect every verdict object from every target into one array, write it to
`.visual-guard/runs/<runId>/verdicts.json` (the `runId` from `.visual-guard/last-check.json`), then
merge it into the manifest with the tested engine helper (it routes each verdict to its image by
`target`/`state`/`viewport` and stores the verdict — never hand-edit `manifest.json`). Substitute that
same `runId` for `<runId>` below (`--apply-verdicts` merges `verdicts.json` into the existing
`manifest.json`; it reads no config, so none is passed):

```bash
"${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx" "${CLAUDE_PLUGIN_ROOT}/scripts/report.ts" --run "<runId>" --apply-verdicts
```

- **Fallback:** if the `visual-reviewer` subagent is unavailable (not found / errors), skip this
  step and explain the diffs yourself in §4 as in Phase 0 — never block the check on the subagent.
- The subagent is **read-only** and so are you here: do not edit source to "make it pass", and do
  not approve a baseline. `verdicts.json`/`manifest.json` live only under `.visual-guard/` (a run
  artifact); nothing is sent to an external service.

## 4. Present — evidence before verdict

Re-`Read` the now-merged `manifest.json` and walk `targets` worst-status first. For each, give the
user **evidence, then verdict**:

- **Status** — `fail` (a regression), `new` (no baseline yet), `error` (couldn't decode), or
  `pass` — stated plainly.
- **Pixel evidence** per image, first: the `ratio` as a percentage, any `dimensionDelta`
  (e.g. `height 32px → 36px`), the changed `regions`, and the `diffPath` PNG to open.
- **The structured verdict**, second: the image's populated `verdict` — `classification`
  (`intentional` / `bug` / `design-system-violation`) · `cause` · `file:line` · `impact` · `fix`.
  If `verdict` is `null` (the subagent fallback fired), *you* explain it: use the target's
  `changedFiles` and `Read` the relevant source to say *what* likely changed (e.g. a spacing token
  replaced by a hardcoded value). Either way, be honest about uncertainty — never invent a cause.
- For `new`: it's unreviewed; suggest `/visual-baseline <target>` to approve the first render.
- For `error`: surface that render's `error` message.

End with a one-line summary (`N fail · N new · N error`) and:

- If a flagged change is **intended**, tell the user to approve it with
  `/visual-baseline <target>` so the next run is clean.
- Never report a finding you could not tie back to the manifest, and never send any screenshot
  to an external service — all capture, diff, and review is local.
