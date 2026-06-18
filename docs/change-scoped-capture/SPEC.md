# Change-Scoped Capture — SPEC

> Status: proposed. Targets the `/visual-check` capture path. Builds on the
> bounded-concurrency pool (v0.2.1) and the existing `pending.json` detection hook.

## 1. TL;DR

Today `/visual-check` (no target) captures **every** story × viewport, every run. Even
parallelized, a 20,000-component design system is `stories × viewports` screenshots — minutes at
best, and wasteful when a change touches three components.

Change-scoped capture makes the **default** `/visual-check` screenshot only the renders a change
*could* affect: collect changed files (git + the `pending.json` the PostToolUse hook already
writes), resolve which stories transitively depend on them via a static import graph, and capture
only those. A change to anything **global** (design tokens, global CSS, Storybook config, a widely
imported barrel) fans out to a full sweep. `--all` and CI always do the full sweep, which remains
the **source of truth**.

The cardinal rule, enforced by construction: **never silently skip a render that could have
changed.** On any ambiguity — an unresolved import, an unmapped file, a global edit — we *widen*,
never narrow, and we always print the scope ("checked 12 of 18,400 stories; run `--all` for a full
sweep").

## 2. Problem & vision

`captureAll` (scripts/capture.ts) renders the flat list from `resolveTargets`
(scripts/lib/targets.ts) = every discovered story crossed with every viewport. The serial→pool
change (v0.2.1) cut wall-clock by `workerCount×`, but the *work* is still O(all stories). At
enterprise scale:

| Stories × viewports | Full sweep @ concurrency 8 | Scoped (touched 3 components) |
|---|---|---|
| 20,000 × 3 = 60,000 | ~25 min | **~15s** |

The inner developer loop ("I changed `Button.css`, did anything regress?") should cost ~seconds and
screenshot ~the handful of stories that render `Button` — not all 60,000. The full sweep still
exists; it just stops being the thing you run on every edit.

## 3. Personas & top user stories

- **DS engineer (inner loop):** "I edited two components; `/visual-check` should check just those
  and finish in seconds." → scoped-by-default.
- **DS engineer (token change):** "I changed `tokens.css`; I want everything re-checked, because
  it can affect everything." → global fan-out to full.
- **CI / release:** "On merge to main, check everything so baselines stay complete." → `--all`.
- **Skeptic:** "How do I know it didn't skip the bug?" → the report always states scope + reasons,
  and the full sweep is the source of truth.

## 4. What it is / isn't

- **Is:** an *accelerator* for `/visual-check` that narrows capture to the affected story set, with
  a provably-conservative widening rule and an explicit, logged scope.
- **Isn't:** a replacement for full coverage. A scoped pass is never reported as "everything is
  fine" — only "everything *in scope* is fine, here's what was out of scope."

## 5. Scope

**In:** changed-file collection (git + `pending.json`); a static import graph for JS/TS (+ CSS
`@import`) with tsconfig-path resolution; file→story inversion; global-change classification +
fan-out; a `scope.json` capture seam; `/visual-check` flags + a scope line in the report; config
knobs + `/visual-config` wiring.

**Out (v1):** per-story-export granularity (story-*file* level is enough); runtime/coverage-based
graphs; following changes *into* `node_modules` (handled by lockfile→full); Vue/Svelte template
graphs (Phase 3); cross-package monorepo graphs beyond tsconfig path aliases.

## 6. Key architecture decisions (resolved)

- **CS-D1 — Scoped is the default; `--all` is the source of truth.** Interactive `/visual-check`
  scopes; CI and `/visual-check --all` sweep fully. Baselines are only ever *complete* after a full
  sweep, so a graph blind spot can't hide a regression past the next `--all` (CI on main).
- **CS-D2 — Conservative by construction.** Every ambiguity widens. Unresolved/dynamic import →
  include the story. Unmapped UI file → full sweep. Global edit → full sweep. New (baseline-less)
  story → always captured. We would rather over-capture than miss a diff.
- **CS-D3 — Static graph, no new dependency.** Build the JS/TS import graph with the **TypeScript
  compiler API** (already an engine dep — `typescript` in `ENGINE_DEPS`) for module + tsconfig-path
  resolution; build CSS `@import`/`composes` edges with **postcss** (already a dep). `madge` /
  bundler stats were considered and rejected: a new heavy dep / a required build, against
  PRINCIPLES.md "prefer minimal dependencies."
- **CS-D4 — Story-file granularity.** A changed file marks every story defined in any `*.stories.*`
  file whose transitive import set contains it. Per-export precision is a later optimization.
- **CS-D5 — The affected set travels via a file, not argv.** At 20k scale the story-id set can be
  thousands of entries — too large for a command line (ARG_MAX). Scope is written to
  `.visual-guard/scope.json` and read by capture, mirroring the existing run-artifact pattern.
- **CS-D6 — The graph is cached + incremental.** Reuse the Studio fingerprint infra
  (scripts/lib/studio/fingerprint.ts) to key `.visual-guard/graph.json`; only re-parse changed
  files' edges between runs. If a cold graph build exceeds a budget, degrade to `--all` with a
  warning (never block).

## 7. The selection pipeline

```
changed files ──┐
(git + pending) │     ┌─ global?  ──► FULL SWEEP (reasons logged)
                ├────►┤
import graph ───┘     └─ local ──► affected story-files ──► story ids ──► scope.json ──► capture
```

### 7.1 Changed-file collection
Union of:
- `git diff --name-only <base>` + `git ls-files --others --exclude-standard` (untracked), where
  `<base>` = `HEAD` interactively, or `merge-base origin/<default-branch> HEAD` in CI (CS-D1).
- `.visual-guard/pending.json` (the PostToolUse hook records edited UI files this session;
  reuse `detect-ui-change.mjs`'s `readPending` + `resolveUiGlobs` + `matchesAnyGlob`).

Filter to files matching `uiGlobs` ∪ token sources ∪ the global globs (§7.3). A non-UI, non-token
edit (e.g. a README) yields an **empty** affected set → "no UI changes; nothing to check"
(not a full sweep — there is provably nothing to capture).

### 7.2 The dependency graph (the crux)
- **Nodes:** source files. **Edges:** static imports. Roots: every `*.stories.*` (+ app entry
  files). Resolve relative imports, `tsconfig` `paths`/`baseUrl`, and package entrypoints via the
  TS compiler API; resolve CSS `@import`/`composes`/`url()` via postcss.
- **Traversal stops at `node_modules`** by default (a third-party change is handled by
  lockfile→full, §7.3). A barrel re-export (`export * from './x'`) is followed.
- **Inversion:** build `file → {storyFiles}` once; `storyFile → {storyIds}` comes from the
  discovered story index (`resolveTargets`). Compose to `changedFile → {storyIds}`.
- **Conservative rules (CS-D2), enforced here:**
  - Dynamic/unresolvable import (`import(expr)`, unanalyzable alias) → mark the importing story-file
    **graph-incomplete** → always in scope.
  - A changed UI file that resolves to **no** story-file (e.g. a util only used by app routes, or a
    file the graph couldn't reach) → **full sweep** (it may be used somewhere we didn't map).
  - Story with no baseline → always captured (it is `new`, independent of the diff).
  - Rename/delete (from `git status`) → its dependents are dirty; a deleted story drops out
    naturally.

### 7.3 Global-change classification → fan-out
A changed file is **global** (→ full sweep) when it is, or is imported by, any of:
- A configured token source (`config.tokens.sources[].source`) — `scope.tokensTriggerFull` (default
  true).
- A global stylesheet: heuristics (`**/global.*`, `**/index.css`, `*.global.*`) ∪ anything imported
  by Storybook `preview.*` ∪ `scope.globs.global` (configurable).
- Storybook/Ladle config: `.storybook/**`, `preview.*`, `main.*`, theme decorators/providers.
- Build/theme config: `tailwind.config.*`, `postcss.config.*`, design-token build config.
- A **fan-out barrel**: a file present in the import subgraph of more than `scope.fanoutThreshold`
  (default 40%) of stories — i.e. editing it plausibly touches "everything."
- A dependency manifest: `package.json` / lockfiles → full (a dep bump can change any render).

Every fan-out is **logged with its reason** ("global: src/styles/tokens.css → full sweep").

### 7.4 Scope decision → affected set
Output: `{ mode: "all" | "scoped" | "none", storyIds: string[], reasons: string[],
totalStories: number }`. `none` when there are no UI/token changes. `all` on any global trigger or
conservative fallback. `scoped` otherwise.

### 7.5 Capture integration
- New engine command `scope.ts` computes the decision and writes `.visual-guard/scope.json`
  (CS-D5).
- `capture.ts` gains a story-id filter parallel to `filterTargets`: when `--scope-file <path>` is
  passed, restrict resolved renders to those whose **story id** ∈ the set. This requires adding
  `storyId` to `RenderTarget` (today the id is only embedded in the iframe URL) so the filter is
  exact, not URL-substring.
- `--all` skips scope entirely (today's behavior). `<component>` arg still maps to the existing
  `--target` filter.

## 8. Config knobs (what `/visual-config` writes)

```jsonc
{
  "scope": {
    "default": "changed",          // interactive default; CI overrides to "all"
    "base": "auto",                // "auto" = HEAD (local) / merge-base (CI), or an explicit ref
    "tokensTriggerFull": true,
    "fanoutThreshold": 0.4,        // file in >40% of story subgraphs ⇒ global
    "globs": { "global": ["**/theme/**", "src/app/layout.tsx"] },
    "onUnknown": "full"            // "full" | "include-story" — conservative default "full"
  },
  "concurrency": 16                 // already shipped (v0.2.1)
}
```

All additive: an absent `scope` block = today's "capture all" behavior, byte-identical.
`/visual-config` measures the project (story count via `/index.json`, cores, token/global files)
and writes sensible defaults + a **warning** when the full matrix is large ("18,400 stories × 3 =
55,200 renders; a full sweep at concurrency 16 ≈ ~20 min — scoped checks will be ~seconds").

## 9. Command surface

- `/visual-check` → scoped since base (default).
- `/visual-check --all` → full sweep (source of truth; CI uses this).
- `/visual-check --since <ref>` → scope against an explicit base.
- `/visual-check <component>` → explicit single component (unchanged).
- **Report always opens with the scope line** (no silent truncation):
  `Scoped check — 12 of 18,400 stories affected by 3 changed files. Full sweep: /visual-check --all.`
  On fan-out: `Global change (src/styles/tokens.css) → full sweep of 18,400 stories.`

## 10. The honest contract

This is the section that keeps a speed feature from becoming a correctness regression:

1. **A scoped pass proves only what it captured.** It is reported as "everything in scope passed,"
   never "everything is fine." The skipped count and the reasons are always shown.
2. **The full sweep is the source of truth.** Baselines are only *complete* after `--all`. CI MUST
   run `--all` on the base branch (every merge to main, or nightly) so a graph blind spot cannot
   hide a regression beyond one merge cycle.
3. **Ambiguity always widens.** Unresolved import, unmapped file, global edit, graph-over-budget →
   capture more. There is no path where uncertainty captures *fewer* renders.
4. **No silent caps.** Every narrowing decision is logged with a reason the user can audit.

## 11. Caching & performance (20k scale)

- Cold graph build is O(files); cache `.visual-guard/graph.json` keyed by a fingerprint of the file
  set + content hashes (reuse `studio/fingerprint.ts`). Warm runs re-parse only changed files'
  edges, then re-invert.
- Budget the cold build (e.g. wall-clock or file-count ceiling); on exceed → `--all` + a warning,
  so the feature never *adds* latency to a run it can't accelerate.
- `scope.ts` is pure + injectable (fs/git/fetch) so the whole decision is unit-testable without a
  browser, matching the engine's existing seams.

## 12. Correctness & testing strategy

- **Graph:** relative + tsconfig-path resolution; barrel re-exports; import cycles; CSS `@import`;
  dynamic-import → graph-incomplete; file→story inversion on a fixture project.
- **Global classification:** tokens / global css / `.storybook/**` / lockfile / fan-out barrel each
  trigger `mode: "all"` with the right reason.
- **Conservative fallbacks:** unresolved import ⇒ story included; unmapped UI file ⇒ full; new
  story ⇒ captured regardless of diff.
- **Scope decision:** a fixture with N stories + a known change yields exactly the expected story
  set; a non-UI change yields `none`.
- **No-silent-skip invariant (the key test):** seed a regression in a component that is *out* of a
  scoped run's set, assert the scoped report states it was out of scope, then assert `--all` catches
  it. The feature must make skipping *visible*, never silent.
- Real-browser behavior is unchanged (capture seam is reused), so the e2e determinism test (CP3)
  needs no change.

## 13. Non-goals (v1)

Per-export story granularity · runtime/coverage graphs · third-party (`node_modules`) change
tracing beyond lockfile→full · Vue/Svelte template graphs (Phase 3) · multi-package monorepo graphs
beyond tsconfig aliases.

## 14. Risks & mitigations

- **Graph misses a dependency → missed regression.** Mitigated by CS-D2 (widen on ambiguity),
  global fan-out, and CI `--all` as the backstop. The graph is an *accelerator*, never the safety
  net.
- **Stale graph cache.** Fingerprint includes content hashes; a changed file invalidates its edges.
- **Dev server can't take the parallel load on a full sweep.** Recommend `build-storybook` (static)
  + higher `concurrency` for `--all`; document it.
- **"Global" is under-broad and misses a real global file.** `scope.globs.global` is
  user-extensible, `fanoutThreshold` catches barrels, and `onUnknown: "full"` is the default.

## 15. Phased delivery

- **Phase 0 — Plumbing + honest scope, heuristic mapping.** Changed-file collection (git +
  `pending.json`); `--all`/`--since` flags; `scope.json` seam; `storyId` on `RenderTarget` + the
  capture filter; the report scope line. First-cut mapping = filename→component-name heuristic with
  **full-sweep fallback** (labeled "heuristic" in the report). Ships value immediately, can't miss
  (falls back to full).
- **Phase 1 — Static import graph (JS/TS).** TS compiler API resolution + tsconfig paths; file→story
  inversion; transitive + barrel handling; graph-incomplete marking; cache.
- **Phase 2 — Global classification + fan-out.** Token/global/SB-config/lockfile/fan-out-barrel
  detection; reasons in the report.
- **Phase 3 — Breadth + polish.** CSS `@import` edges; Vue/Svelte; monorepo path aliases;
  incremental graph cache; `/visual-config` wiring + matrix warning; CI merge-base base ref.

## 16. Ties to existing code (implementation map)

| Concern | Reuse / touch |
|---|---|
| Changed UI files (session) | `scripts/detect-ui-change.mjs` — `readPending`, `resolveUiGlobs`, `matchesAnyGlob`, `globToRegExp` |
| Story enumeration | `scripts/lib/targets.ts` — `resolveTargets`; add `storyId` to `RenderTarget` |
| Capture filter | `scripts/capture.ts` — new story-id filter beside `filterTargets`; `--scope-file` arg |
| New decision engine | `scripts/scope.ts` (pure + injectable git/fs/fetch) → writes `.visual-guard/scope.json` |
| Import graph | TS compiler API (`typescript` ∈ `ENGINE_DEPS`) + `postcss` (already a dep) — no new dep |
| Code enumeration | `scripts/lib/studio/enumerate-code.ts` (component discovery) |
| Cache fingerprint | `scripts/lib/studio/fingerprint.ts` |
| Config | `scripts/lib/config.ts` — additive `scope` block (mirror `parseStudio`/`parseFigma`) |
| Command flow | `commands/visual-check.md` — scope step before capture; report scope line |
| Boundary | All artifacts under `.visual-guard/` (gitignored); nothing sent externally |
```
