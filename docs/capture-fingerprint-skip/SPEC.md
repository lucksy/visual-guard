# Capture Fingerprint-Skip — SPEC (v2, post-adversarial-audit)

> Status: in progress. v2 supersedes v1 after a 3-lens adversarial design audit found multiple
> **common** silent-under-capture holes in the v1 name-glob design. The audit's blueprint is now the
> design. Builds on the Phase-1 import graph + graph cache (per-file content hashes).

## 1. TL;DR

Even a full sweep re-screenshots every story. A story whose **rendered inputs are byte-identical to
baseline-approval time** cannot have changed pixels — so we can **copy the approved baseline forward**
(no browser) and trust it. This is the only way to make big-design-system full sweeps cheap.

A skip = copy the approved baseline PNG into the run's `current` (no browser) + `skipped:true`.
`compare.ts` diffs the copy against the baseline → ratio 0 → `pass`, so compare and the gate are
**untouched** and every render stays present, compared, and counted (honest).

**Cardinal invariant (absolute): never silently skip a render that could have changed.** The
fingerprint must be a provable **superset** of render-affecting inputs; **any uncertainty → capture.**

## 2. What the audit changed (v1 → v2)

The v1 design fingerprinted the global inputs by **name-glob** (`tokens.css`, `.storybook/**`, …).
The audit proved that is unsafe — these **common** inputs change pixels while a name-glob `G` stays
identical (→ a silent skip of a real regression):

- CSS `url()` fonts/images (`@font-face src`, `background:url()`) — the CSS extractor never walked decls.
- `public/`/`staticDirs` assets served by URL (no import edge anywhere).
- Global CSS imported by a **decorator/addon** under a project-specific name (`brand.css`, `base.css`).
- `<link rel=stylesheet>` in `preview-head.html`.
- Build/env config (`vite.config`, `.env`, `babel`, `components.json`) — **also an existing scope hole**:
  under a complete graph these mapped to "affects no story" → captured nothing.
- Monorepo workspace source via node_modules symlink (the graph boundary).
- Chromium **binary revision** drift under a fixed `playwright` npm version.

**Five decisions follow (the v2 design):**

1. **G is a REACHABILITY set, not a name-glob list** (§3).
2. **Never skip under plain `--all`** — it stays a true full sweep; skipping needs an explicit second
   opt-in (`--skip-unchanged`). **Default OFF.** (§5)
3. **Four mandatory hardenings**: Chromium *revision* in `engineFp`; baseline-PNG **tamper-evidence**;
   patch-state hashing; a non-silent **NOT-covered boundary** print. (§4)
4. **Documented irreducible caveats** (remote/CDN assets, host-font/OS drift, shell env). (§7)
5. **Rotating forced recapture** so no blind spot is permanent. (§4)

## 3. The fingerprint (correctness core)

Per-RENDER `F = sha1( FP_VERSION ⊕ S ⊕ G ⊕ viewport ⊕ state ⊕ kind ⊕ origin-stripped-url )`.

- **`S` (per story)** = sorted content hashes of the story's transitive import **closure**. The CSS
  extractor is extended to follow **`url()` asset edges** (woff2/png/svg/jpg → content-hashed closure
  nodes), closing the per-story font/logo hole.
- **`G` (shared, folded into every F)** = `engineFp` ⊕ env-determinism ⊕ content-sha1 of the **GLOBAL
  FILE SET**, where that set is the **union of three reachability-derived sources** (not a name list):
  1. **Name-glob matches** — the expanded `DEFAULT_GLOBAL_GLOBS` ∪ `config.scope.globalGlobs` ∪ token
     sources (built-ins now include vite/webpack/rollup/babel configs, `components.json`, `.npmrc`,
     `.env*`, `manager.*`, `preview-head.html`, `patches/**`, `public/**`, `static/**`,
     base/reset/tokens/typography/`*.theme`/designTokens names). **(landed in scope.ts.)**
  2. **Global import-closure** — the transitive closure rooted at the globbed **entry points**
     (`preview.*`, `.storybook/main.*`, `manager.*`, theme/token entries) via the existing resolver,
     content-hashing every reached file. Auto-covers arbitrarily-named global CSS/JS from
     decorators/addons (the name-glob arms race is unwinnable; reachability wins).
  3. **Static-serve + template assets** — staticDirs (read from `.storybook/main.*` / Ladle publicDir)
     + `<link>`/`<style>` targets parsed from `preview-head.html`/`manager-head.html`, hashed **on disk
     regardless of git status** (closes the gitignored-generated-token hole for reachable globals).

`engineFp` = `playwright` version **+ the resolved Chromium revision** + the R1 determinism constants
(read live from `contextOptions` + FREEZE/SETTLE). A global/engine/determinism change busts every `F`.

## 4. Mandatory hardenings (Phase B)

1. **Chromium revision in `engineFp`** — hash the resolved browser identity (executablePath revision /
   `browsers.json`), not just the npm version string. A same-version binary swap must bust every F.
2. **Baseline-PNG tamper-evidence** — the approved entry stores the baseline PNG's own sha1; a skip
   recomputes it from the live PNG and **fails closed** on mismatch (corrupt/edited/LFS-smudged PNG is
   never laundered as a pass). **(landed in capture.ts: `FingerprintEntry.png` + verify-before-skip.)**
3. **Patch-state hashing** — `patches/**`, `.yarn/patches/**` in the global set; a symlink-outside-root
   dep already fails closed (resolver → unresolved → incomplete → never skip).
4. **Non-silent boundary** — every skipping run prints `N captured, M skipped (inputs unchanged)` **and**
   a concrete NOT-COVERED statement (node_modules content, remote/CDN, host fonts, shell env).
5. **Rotating forced recapture** (preferred Phase B, acceptable Phase C) — re-shoot a rotating quota
   (oldest-skipped-first, e.g. `ceil(sqrt(N))`) each run so every baseline is physically re-verified
   within a bounded number of runs; converts permanent blind spots into bounded-latency detection.

## 5. Policy + command flow

- **`--skip-unchanged` is the gate**, default OFF; pairs with `--fingerprints`. Plain `--all` **never**
  auto-enables it — the CI source-of-truth invocation stays a true full capture. Skip's safest value is
  in **scoped** runs (the git diff independently corroborates the fingerprint). **(landed in capture.ts.)**
- `scope.ts` emits `.visual-guard/fingerprints-current.json` (best-effort, never narrows/throws; OMIT a
  render on any doubt → capture). `capture.ts` reads it + the committed `baselineDir/fingerprints.json`.
- `/visual-baseline` writes the committed approved fingerprints (fp + png) at approve time.
- Config `scope.fingerprintSkip` (default **false**); `/visual-config` surfaces the trust boundary.

## 6. Honest contract

A skip means **"the inputs are byte-identical to approval, so the baseline is trusted"** — never
"verified unchanged". Plain `--all` stays the source of truth. **Any uncertainty captures**; the skip
universe is, by construction, a subset of the graph-modeled universe. The report states the skipped
count *and* the uncovered boundary.

## 7. Irreducible caveats (documented; bounded by rotating recapture)

- **Remote/CDN** `<link>`/fonts — a network resource can't be content-hashed.
- **Host/OS font fallback drift** — the engine bundles no fonts; identical inputs can render differently
  across machines. Pre-existing baseline-portability caveat; a skip adds **no new** risk vs. keeping the
  baseline, but permanent skip would make it caught-NEVER → rotating recapture bounds it.
- **Shell-exported / process env** (values not in any `.env*` file) — no file to hash.
- **In-place registry-dep edits** with no patch file and no lock change.

NOT caveats (closed by the Phase C audit's must-fixes): a **scope failure** can no longer leave a stale
`fingerprints-current.json` (scope clears it up front + the command clears `$FP_FILE`); a **mid-run
source edit** between scope's byte-hash and capture's screenshot can no longer poison an approved
fp↔PNG pair (scope emits the input content map and capture re-verifies it after the pool, **dropping the
run's fps on any change**). Note also that **rotating forced recapture is a LATENCY bound, not a
per-run guarantee**: a baseline subject to invisible-input drift is re-verified within ~`ceil(sqrt(N))`
runs, not every run — the plain `--all` (no `--skip-unchanged`) is always the immediate full backstop.
- **Gitignored, glob-named global reached by nothing** — `scope.ts` enumerates the name-glob global
  roots from `git ls-files` (+ untracked-not-ignored), so a *gitignored* file that is "global" only by
  name-glob AND is imported by no entry point is not enumerated. The common case (a global *imported*
  by preview/a decorator/a story) is byte-hashed on disk regardless of git status via the closure; the
  residual is a gitignored, un-imported, glob-named global — narrow, and the same blind spot scope's
  git-diff model already has. A future hardening is a filesystem glob-walk for the global roots.

## 8. Phased delivery (re-sequenced after the audit)

- **Phase A — foundation (DONE):** `ImportGraph.storyClosure`; pure `scripts/lib/fingerprint.ts`
  (`S`/`G`/`F` + `neverSkip`/`computeFingerprint`) + tests.
- **Phase B1 — safe mechanic + scope hardening (DONE this slice):** capture `--skip-unchanged` +
  tamper-evidence schema (`FingerprintEntry{fp,png}`) + copy-forward skip + conditional browser launch +
  `renders.json` `skipped`; expanded `DEFAULT_GLOBAL_GLOBS` (fixes the existing build-config under-capture).
  Inert until fingerprints exist. + tests.
- **Phase B2 — reachability G + engine pin (DONE + audited):** CSS `url()` asset edges (B2a); the
  global import-closure from entry points + `preview-head`/`manager-head` `<link>` **and inline
  `<style>`** `@import`/`url()` targets (folded as extra graph roots) + Chromium revision in `engineFp`;
  `scope.ts` emits `fingerprints-current.json` (`scripts/lib/fingerprint-emit.ts`). A 3-lens adversarial
  audit (→ verify → synth) confirmed 3 fail-closeable holes, all now fixed: **(1)** empty `globalFiles`
  → `return {}` (an engine-only `G` can't witness a global change); **(2)** inline `<style>` assets now
  hashed + fail-closed; **(3)** unresolved engine pin (`chromiumRevision`/`playwrightVersion` `""`)
  → `return {}`. Plus the stale `fingerprints-current.json` is cleared on every fail-closed early-return.
  The skip path is **inert until Phase C** wires the approved-fp write — so these landed before skip goes live.
- **Phase C — lifecycle + honesty (DONE + audited):** C1 — `config.scope.fingerprintSkip` (default
  false); `capture.ts` persists the run's fps run-scoped (`runs/<id>/fingerprints.json`) so the approved
  fp pairs with the exact PNG; `baseline.ts recordApprovedFingerprints` writes the committed
  `baselineDir/fingerprints.json` (`{fp, png}`) at approve (merge / drop-no-fp / prune / preserve-on-no-run-fps).
  C2 — `visual-check.md` passes `--fingerprints` always (approve-record) + `--skip-unchanged` only when
  (config on AND scoped) or the user typed it (plain `--all` never auto-skips); `report.ts` "N captured,
  M skipped" + NOT-covered boundary. C3 — **rotating forced recapture**: `selectRotatingRecapture` re-shoots
  `ceil(sqrt(N))` of the skip-eligible set, rotating by `hash(runId)` (stateless; bounded-latency coverage;
  `~0.7%` overhead at 20k); `/visual-config` surfaces the toggle + trust boundary; `/visual-baseline` notes
  the committed `fingerprints.json`. **Phase C adversarial audit fixed 2 silent-wrong-skip holes:** a HIGH
  stale-fingerprints-on-scope-failure leak (scope clears the file up front + the command clears `$FP_FILE`)
  and a MEDIUM approve-time TOCTOU (scope emits the input content map; capture re-verifies it after the
  pool and drops the run's fps on any mid-run source change).

## 9. Ties to existing code

| Concern | Reuse / touch |
|---|---|
| story closure + url() assets | `import-graph.ts storyClosure` (done); `css-imports.ts` walkDecls `url()` (B2) |
| global reachability set | reuse `buildImportGraph` rooted at globbed entry points (B2) |
| file content hashes | `graph/cache.ts CacheEntry.hash` (+ read+sha1 on cache miss) |
| determinism + engine pin | `lib/browser.ts` R1 constants (done) + resolved Chromium revision (B2) |
| skip mechanic + tamper-evidence | `capture.ts captureAll` copy-forward + `FingerprintEntry.png` (done) |
| approve record | `baseline.ts applyBaseline` → committed `baselineDir/fingerprints.json` (C) |
| boundary | current fps under `.visual-guard/` (gitignored); approved under `baselineDir/` (committed) |
