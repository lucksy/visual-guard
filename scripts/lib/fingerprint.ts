import {
  contextOptions,
  FREEZE_INIT_SCRIPT,
  FREEZE_STYLE,
  SETTLE_SCRIPT,
} from "./browser";
import { sha1 } from "./graph/cache";
import type { ImportGraph } from "./graph/import-graph";
import type { RenderTarget } from "./targets";

/**
 * Capture fingerprint-skip (Phase 3) — the correctness CORE, pure + unit-testable (no fs, no
 * Playwright). See docs/capture-fingerprint-skip/SPEC.md.
 *
 * A render may be SKIPPED (copy the approved baseline forward instead of screenshotting) ONLY when
 * its rendered inputs are provably byte-identical to when its baseline was approved. The per-render
 * fingerprint {@link computeFingerprint} is a SUPERSET of every render-affecting input:
 *
 *   F(render) = sha1( FP_VERSION
 *                   ⊕ S  — the story's transitive import-closure file content-hashes
 *                   ⊕ G  — the global block: global/token file content-hashes ⊕ env ⊕ engine pin
 *                   ⊕ viewport ⊕ state ⊕ kind ⊕ origin-stripped url )   // the render-local axes
 *
 * G is folded into EVERY render, so any global/token/determinism/engine change busts ALL
 * fingerprints → nothing skips → full re-capture (mirrors scope.ts's "global change → full sweep").
 *
 * The cardinal invariant — never skip a render that could have changed — is enforced by
 * {@link neverSkip}: any input the fingerprint can't be PROVEN to cover (no graph, incomplete
 * closure, app route, unhashable file, …) forces a normal capture. {@link computeFingerprint}
 * returns null exactly when {@link neverSkip} is true, so a caller that skips only on a non-null,
 * baseline-matching fingerprint cannot under-capture.
 */

/** Format kill-switch: bump to invalidate EVERY stored fingerprint (forces a full re-capture). */
export const FP_VERSION = 1;

/**
 * Engine + determinism fingerprint. Pins the renderer binary AND the R1 determinism contract from
 * browser.ts. A change to either shifts pixels, so it is folded into {@link globalFingerprint} (and
 * thus every render's F).
 *
 * The renderer pin folds BOTH the `playwright` npm version AND the resolved **Chromium revision** — the
 * npm version string ALONE is insufficient (the adversarial audit's "plausible" hole): a base-image
 * rebuild / mirror / partial reinstall can swap the Chromium binary while package.json still reads the
 * same version, shifting anti-aliasing/font-hinting by a few pixels with an otherwise-identical F. The
 * caller resolves the revision (from playwright's `browsers.json`); pass `""` only when it genuinely
 * can't be resolved (version-only is the documented floor).
 *
 * The determinism block is read from `contextOptions` (not re-hardcoded) so any change to those pinned
 * values — or any NEW field added to the deterministic context options — automatically changes the
 * fingerprint. `viewport.width` is zeroed because width is a per-render axis carried separately.
 */
export function engineFingerprint(playwrightVersion: string, chromiumRevision = ""): string {
  const opts = contextOptions(1000);
  const env = { ...opts, viewport: { ...opts.viewport, width: 0 } };
  return sha1(
    JSON.stringify({
      v: FP_VERSION,
      pw: playwrightVersion,
      chromium: chromiumRevision,
      env,
      freezeStyle: FREEZE_STYLE,
      freezeInit: FREEZE_INIT_SCRIPT,
      settle: SETTLE_SCRIPT,
    }),
  );
}

/** A `[path, contentHash]` pair. The path is part of the hash so a rename busts the fingerprint. */
export type FileHash = [string, string];

function sortedHash(prefix: string, pairs: readonly FileHash[]): string {
  // Sort by path so input order can't change the fingerprint. Posix-lower the path for a stable,
  // case-insensitive key (matching the graph's keying), but keep the content hash verbatim.
  const sorted = [...pairs]
    .map(([p, h]): FileHash => [p.split("\\").join("/").toLowerCase(), h])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha1(JSON.stringify({ v: FP_VERSION, k: prefix, files: sorted }));
}

/**
 * Per-STORY fingerprint `S` — the content hashes of every file in the story's transitive import
 * closure. Shared across all of a story's renders (the closure is identical across states/viewports),
 * so it is computed once per story and reused.
 */
export function storyFingerprint(closureHashes: readonly FileHash[]): string {
  return sortedHash("story", closureHashes);
}

/**
 * GLOBAL fingerprint `G` — the global/token file content hashes (inputs applied OUTSIDE any story
 * closure) folded with the engine+determinism fingerprint. Identical for every render in a run; a
 * change to any global file, the engine, or a determinism setting changes G → busts every F.
 */
export function globalFingerprint(globalHashes: readonly FileHash[], engineHash: string): string {
  return sha1(
    JSON.stringify({
      v: FP_VERSION,
      engine: engineHash,
      globals: [...globalHashes]
        .map(([p, h]): FileHash => [p.split("\\").join("/").toLowerCase(), h])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    }),
  );
}

/** Strip the origin (host:port) from a render URL — the story id / iframe params affect pixels, the host doesn't. */
function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url; // unparseable → keep verbatim (conservative: a different raw url won't falsely match)
  }
}

/**
 * Per-RENDER fingerprint `F` = S ⊕ G ⊕ the render-local pixel axes (viewport, state, kind, url).
 * This is what is stored per baseline key and compared to decide a skip.
 */
export function renderFingerprint(render: RenderTarget, story: string, global: string): string {
  return sha1(
    JSON.stringify({
      v: FP_VERSION,
      story,
      global,
      viewport: render.viewport,
      state: render.state,
      kind: render.kind,
      url: urlKey(render.url),
    }),
  );
}

/**
 * Inputs the skip decision needs, all already computed by scope.ts's graph build. `global` is the
 * single {@link globalFingerprint} for the run; `closureHashesByStory` maps a lowercased story file
 * to its closure's `[path, hash]` pairs, or `null` when ANY closure file was unreadable/unhashable
 * (→ never skip).
 */
export interface SkipContext {
  graph: ImportGraph | undefined;
  closureHashesByStory: Map<string, readonly FileHash[] | null>;
  global: string;
}

/**
 * TRUE ⇒ this render MUST be captured normally (the conservative default). Returns true on ANY input
 * the fingerprint can't be proven to cover. The skip universe is, by construction, a subset of the
 * graph-modeled universe (the same gate `buildProjectGraph` applies before the graph is trusted).
 */
export function neverSkip(render: RenderTarget, ctx: SkipContext): boolean {
  const graph = ctx.graph;
  if (graph === undefined || !graph.built) return true; // no trustworthy graph (Phase-0 fallback / build fail)
  if (render.storyId === undefined) return true; // app route — no closure to fingerprint
  const sf = render.storyFile?.toLowerCase();
  if (sf === undefined || sf.length === 0) return true; // Ladle / explicit story list — no closure
  if (graph.storyIncomplete.get(sf) !== false) return true; // incomplete OR not in graph → untrustworthy closure
  const hashes = ctx.closureHashesByStory.get(sf);
  if (hashes === undefined || hashes === null) return true; // closure not fully hashable → never skip
  return false; // fingerprintable
}

/**
 * The per-render fingerprint `F` if the render is fingerprintable, else `null` (≡ {@link neverSkip}).
 * Pure: the I/O comparison (does a baseline PNG exist? does the stored approved fingerprint match?)
 * is the caller's, so this stays fs-free and fully unit-testable. A caller skips ONLY when this is
 * non-null AND a baseline exists AND the stored approved fingerprint byte-equals it.
 */
export function computeFingerprint(render: RenderTarget, ctx: SkipContext): string | null {
  if (neverSkip(render, ctx)) return null;
  const sf = render.storyFile!.toLowerCase();
  const hashes = ctx.closureHashesByStory.get(sf)!; // non-null: neverSkip already rejected undefined/null
  return renderFingerprint(render, storyFingerprint(hashes), ctx.global);
}
