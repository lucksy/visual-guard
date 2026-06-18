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
- Resolve the project's config — the first that exists of `visual.config.json`,
  `config/visual.config.json`, else the bundled default
  `${CLAUDE_PLUGIN_ROOT}/config/visual.config.json`. Call it `$CONFIG`.

## 1. Gather — parse the arguments into a scope intent

Read `$ARGUMENTS` and set three shell-ready values for §2 (default them to empty):

- A bare word (no leading `--`, e.g. `Button` or `components/Button`) → **`EXPLICIT`** = that word.
  An explicit target is captured directly and is **never** change-scoped.
- `--all` present → **`ALL`** = `1` (full sweep — the source of truth; what CI uses).
- `--since <ref>` present → **`SINCE`** = `<ref>` (scope the change against that git base instead of
  `HEAD`).
- Nothing (the common case) → all three empty → **change-scoped** vs `HEAD`.

Then surface the changed UI files as context: run `git diff --name-only HEAD` and
`git ls-files --others --exclude-standard`, keep the ones matching the config's `uiGlobs`, and show
them, e.g. `Changed UI files: Button.tsx · button.css`. (The actual scope decision is made
deterministically by `scope.ts` in §2 — this is just the human-facing banner.)

## 2. Act — capture → compare → report

Run all three from the **project root** (the current working directory), tied together by one
run id. The engine writes only under `.visual-guard/runs/<id>/` (gitignored); it writes
nothing else. Before capture, echo `Capturing: <target or "all targets">…`, and before the
diff, echo `Comparing against baseline…`, so the run reads like the canonical flow.

**Managed harness:** if the config has a Visual-Guard-scaffolded Ladle target (`"type": "ladle",
"managed": true`), its dev server isn't expected to be already running — `managed-serve start` boots it,
waits until it's reachable, and a `trap … EXIT` **always** stops it afterward (even if capture fails).
For a project whose server you run yourself (Storybook / app), `managed-serve start` is a **no-op**, so
the same block is safe for every config.

Substitute the `EXPLICIT` / `ALL` / `SINCE` you derived in §1 into the marked lines (leave a value
empty if it doesn't apply). The branch is deterministic — `scope.ts` decides, capture obeys.

```bash
RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
export PLAYWRIGHT_BROWSERS_PATH="${CLAUDE_PLUGIN_DATA}/browsers"
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"
SCOPE_FILE="$PWD/.visual-guard/scope.json"

EXPLICIT=""   # <- §1: a bare component target, or empty
ALL=""        # <- §1: "1" if --all, else empty
SINCE=""      # <- §1: a git ref if --since <ref>, else empty

# Start a managed (VG-scaffolded) harness if the config has one, and ALWAYS stop it on exit — even on
# failure. No-op when there's no managed target. The harness is only needed during capture/scope.
trap '"$RUNNER" "$SCRIPTS/managed-serve.ts" stop --config "$CONFIG" --cwd "$PWD" >/dev/null 2>&1 || true' EXIT
"$RUNNER" "$SCRIPTS/managed-serve.ts" start --config "$CONFIG" --cwd "$PWD"

# Build args in "$@" via positional params so each flag/value is a DISTINCT argv element under BOTH
# bash and zsh. (zsh does NOT word-split an unquoted "$VAR", so never stash flags in a string and
# re-expand — that would arrive as one combined argument and the scripts would reject it.)
if [ -n "$EXPLICIT" ]; then
  set -- --target "$EXPLICIT"               # explicit component → no change-scoping
else
  rm -f "$SCOPE_FILE"                        # never read a stale decision from a prior run
  set -- --config "$CONFIG" --cwd "$PWD"
  [ -n "$ALL" ]   && set -- "$@" --all
  [ -n "$SINCE" ] && set -- "$@" --since "$SINCE"
  # scope.ts writes .visual-guard/scope.json + prints a summary. It NEVER fails the run; on ANY
  # uncertainty (bad ref, server down, parse error) it writes mode "all" (full sweep).
  "$RUNNER" "$SCRIPTS/scope.ts" "$@"
  MODE="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).mode)}catch(e){process.stdout.write("all")}' "$SCOPE_FILE")"
  if [ "$MODE" = "none" ]; then
    echo "No UI changes since base — nothing to check. Run /visual-check --all to sweep everything."
    exit 0   # the trap stops the managed harness
  fi
  set --                                     # reset, then build the capture args
  [ "$MODE" = "scoped" ] && set -- --scope-file "$SCOPE_FILE"   # mode "all" → no flag → full sweep
fi

"$RUNNER" "$SCRIPTS/capture.ts" --config "$CONFIG" --run "$RUN_ID" "$@"
"$RUNNER" "$SCRIPTS/compare.ts" --config "$CONFIG" --run "$RUN_ID"
"$RUNNER" "$SCRIPTS/report.ts"  --config "$CONFIG" --run "$RUN_ID"

# Checkpoint complete — clear the pending-review markers (no-dep, never fails the run) so the
# Stop-hook nudge resets. Runs only after the three steps above succeed.
node "${CLAUDE_PLUGIN_ROOT}/scripts/detect-ui-change.mjs" --clear
```

**Surface the scope, always (the honest contract).** Echo `scope.ts`'s summary line so the user knows
exactly what was and wasn't checked — e.g. `Scoped — 2 components, 6 of 55,200 renders (55,194 out of
scope). Full sweep: /visual-check --all.` A scoped pass means "everything **in scope** passed," never
"everything is fine." The full sweep (`--all`, and CI) is the source of truth; the Phase-0 heuristic
can miss a component whose file is imported by another, and `--all` is the backstop.

- If `managed-serve.ts start` fails with **"did not become reachable"** or **"exited before becoming
  ready"**, the scaffolded harness couldn't boot — relay its message and suggest the user run their
  package manager's install (so `@ladle/react` is present) and retry. Stop.
- If `capture.ts` fails with **"could not reach …"**, relay its message verbatim — the dev
  server / Storybook isn't running on that port (a non-managed target you start yourself). Stop; do
  not fabricate results.
- If capture reports **"no targets matched"**, tell the user the target didn't match any
  configured story/route and list a few valid ones from the config. Stop.
- A **managed** harness run is render-error-tolerant: an auto-generated story that fails to render is
  recorded as an `error`-status image (surfaced in §4) instead of aborting the whole run — so one
  prop-required component can't block the rest.

## 3. Review — structured verdict via the `visual-reviewer` subagent (Phase 1)

`Read` `.visual-guard/runs/$RUN_ID/manifest.json` (its paths are relative to the project root).
For every **flagged** target — one whose `status` is `fail`, `new`, or `error` (a `pass` target
needs no review) — invoke the read-only **`visual-reviewer`** subagent once, passing that target's
manifest entry (its `images` with `currentPath`/`baselinePath`/`diffPath`, pixel evidence,
`renderTarget`, `changedFiles`). The subagent classifies each changed image and returns a JSON
**array of verdicts** (`target`/`state`/`viewport` + `severity`/`classification`/`issue`/`file`/
`line`/`cause`/`impact`/`fix`).

Collect every verdict object from every target into one array, write it to
`.visual-guard/runs/$RUN_ID/verdicts.json`, then merge it into the manifest with the tested engine
helper (it routes each verdict to its image by `target`/`state`/`viewport` and stores the verdict —
never hand-edit `manifest.json`). Re-establish the runner here (a fresh shell does not inherit §2's
variables) and reuse the **same** `$RUN_ID` from §2:

```bash
RUNNER="${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"
# Reuse the same $RUN_ID from §2. (--apply-verdicts merges verdicts.json into the existing
# manifest.json; it reads no config, so none is passed.)
"$RUNNER" "$SCRIPTS/report.ts" --run "$RUN_ID" --apply-verdicts
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
