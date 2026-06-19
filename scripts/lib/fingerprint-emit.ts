import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { extractCssSpecifiers } from "./graph/css-imports";
import { buildImportGraph, graphComplete, type ImportGraph } from "./graph/import-graph";
import { createResolver } from "./graph/resolver";
import {
  computeFingerprint,
  engineFingerprint,
  globalFingerprint,
  type FileHash,
  type SkipContext,
} from "./fingerprint";
import { renderRelPath, type RenderTarget } from "./targets";

/**
 * Compute the CURRENT per-render fingerprints for a run — the scope-side of capture fingerprint-skip
 * (Phase B2c). See docs/capture-fingerprint-skip/SPEC.md.
 *
 * This is where `F` becomes real. The hard part is `G` (the GLOBAL fingerprint): an adversarial audit
 * proved a name-glob global set silently misses common inputs (decorator-imported CSS of any name,
 * `url()` fonts, build config), so `G`'s file set is a REACHABILITY set — the transitive import closure
 * of every globbed global root (caller-supplied, already glob-matched), PLUS local files linked from
 * `preview-head.html`/`manager-head.html`. Every file is **byte-hashed** (not the graph cache's UTF-8
 * hash, which would collide on binary fonts/images).
 *
 * Cardinal invariant: any doubt about `G`'s completeness → emit NOTHING (the whole run captures). A
 * render gets a fingerprint ONLY when {@link computeFingerprint} returns non-null (a graph-rooted,
 * complete, fully-byte-hashable Storybook story). Capture then skips a render only when this current
 * `F` matches the committed approved `F` and the baseline PNG is intact (capture.ts owns that check).
 */

export interface EmitDeps {
  /** Read a file's raw bytes (for byte-exact content hashing). Throws on unreadable. */
  readBytes: (abs: string) => Buffer;
  /** Read a file's text (for the import resolver). Throws on unreadable. */
  readText: (abs: string) => string;
}

export interface EmitInput {
  cwd: string;
  targets: RenderTarget[];
  /** The STORY import graph (from buildProjectGraph) — undefined/incomplete handled by the caller's gate. */
  storyGraph: ImportGraph;
  /** Absolute paths of the global-glob-matched working-tree files (the caller does the glob match). */
  globalRoots: string[];
  playwrightVersion: string;
  chromiumRevision: string;
}

const defaultEmitDeps: EmitDeps = {
  readBytes: (abs) => readFileSync(abs),
  readText: (abs) => readFileSync(abs, "utf8"),
};

/** sha1 hex of a file's raw bytes (binary-safe — fonts/images must not collide). */
function sha1Bytes(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex");
}

const relPosix = (cwd: string, abs: string): string => relative(cwd, abs).split(sep).join("/");

/**
 * Resolve the installed Chromium revision from playwright's `browsers.json` (a same-version binary swap
 * must bust every fingerprint — see {@link engineFingerprint}). Best-effort: `""` when it can't be read
 * (version-only is the documented floor). Never throws.
 */
export function resolveChromiumRevision(
  cwd: string,
  read: (abs: string) => string = (abs) => readFileSync(abs, "utf8"),
): string {
  for (const rel of [
    "node_modules/playwright-core/browsers.json",
    "node_modules/playwright/browsers.json",
  ]) {
    try {
      const data = JSON.parse(read(join(cwd, rel))) as {
        browsers?: Array<{ name?: string; revision?: string | number }>;
      };
      const chromium = data.browsers?.find((b) => b.name === "chromium");
      if (chromium?.revision !== undefined) return String(chromium.revision);
    } catch {
      /* try the next location */
    }
  }
  return "";
}

/**
 * Resolve the installed `playwright` package version (pairs with the Chromium revision in the engine
 * pin). Best-effort: `""` when it can't be read. Never throws.
 */
export function resolvePlaywrightVersion(
  cwd: string,
  read: (abs: string) => string = (abs) => readFileSync(abs, "utf8"),
): string {
  for (const rel of [
    "node_modules/playwright-core/package.json",
    "node_modules/playwright/package.json",
  ]) {
    try {
      const pkg = JSON.parse(read(join(cwd, rel))) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* try the next location */
    }
  }
  return "";
}

/**
 * Parse the global stylesheet/asset targets a Storybook head HTML template injects: `<link rel=
 * stylesheet href>` AND inline `<style>` blocks (their `@import` targets + `url()` font/image assets).
 * Each RELATIVE local target (resolved against the template's dir) becomes an extra GRAPH ROOT, so the
 * caller follows its transitive closure (a head-`<style>` `@import './g.css'` whose `g.css` has further
 * `@import`/`url()` is hashed too — the hole can't move one hop down). A remote/`//`/`data:`/fragment
 * or ABSOLUTE `/x.css` target is skipped (remote can't be hashed; absolute is a static-serve asset
 * covered by the `public/**`/`static/**` globs). `dynamic=true` when a relative local target can't be
 * resolved to a file on disk, or an inline `<style>` is itself dynamic (interpolated `url()`/`@import`)
 * — the caller then fails closed (an unknown global input can't be trusted as unchanged).
 */
export function parseHeadTemplate(
  text: string,
  templateAbs: string,
  isFile: (abs: string) => boolean,
): { roots: string[]; dynamic: boolean } {
  const dir = join(templateAbs, "..");
  const roots: string[] = [];
  let dynamic = false;
  const addRelative = (raw: string): void => {
    const value = raw.trim();
    if (value.length === 0) return;
    // remote / protocol-relative / data / fragment / absolute (static-serve) → not a local closure root.
    if (/^(?:https?:)?\/\//i.test(value) || /^data:/i.test(value) || value.startsWith("#") || value.startsWith("/")) {
      return;
    }
    const abs = resolve(dir, (value.split(/[?#]/)[0] ?? value));
    if (isFile(abs)) roots.push(abs);
    else dynamic = true; // a relative local target we can't find on disk → unknown global → fail closed
  };
  // <link rel=stylesheet href="...">
  for (const match of text.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    addRelative(match[1] ?? "");
  }
  // inline <style>…</style> blocks: their @import targets + url() assets (parsed by the CSS extractor).
  for (const block of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const { specifiers, assets, dynamic: cssDynamic } = extractCssSpecifiers(block[1] ?? "", ".css");
    if (cssDynamic) dynamic = true; // interpolated/unparseable inline CSS → fail closed
    for (const spec of specifiers) addRelative(spec); // a non-relative (npm/aliased) @import → unresolved → fail closed
    for (const asset of assets) addRelative(asset);
  }
  return { roots, dynamic };
}

const HEAD_TEMPLATE_RE = /(?:^|\/)(?:preview-head|manager-head)\.html$/i;

export interface EmitResult {
  /** renderRelPath → per-render fingerprint F, for every fingerprintable render (empty → skip nothing). */
  fps: Record<string, string>;
  /**
   * The CONTENT INPUTS behind those fps: relPosix path → byte-hash, the union of the global set and the
   * closures of the emitted renders. Capture re-hashes these AFTER screenshotting and drops the run's
   * fps if any changed (the approve-time TOCTOU guard — the scope-time byte-hash must equal the inputs
   * the PNG actually rendered from).
   */
  inputs: Record<string, string>;
}

/**
 * Compute the per-render fingerprints `F` (+ their content `inputs`) for every fingerprintable render,
 * or empty maps when `G` can't be trusted (the whole run then captures). Pure given its injected reads;
 * the caller (scope.ts) supplies the story graph + glob-matched global roots and writes the result to
 * `fingerprints-current.json`.
 */
export function computeFingerprintsCurrent(
  input: EmitInput,
  deps: EmitDeps = defaultEmitDeps,
): EmitResult {
  const { cwd, targets, storyGraph, globalRoots, playwrightVersion, chromiumRevision } = input;
  const cwdResolved = resolve(cwd);
  const none = (): EmitResult => ({ fps: {}, inputs: {} });

  // A byte-hash memo across the whole run (a util shared by many stories is hashed once). null = the
  // file was unreadable/unhashable.
  const hashes = new Map<string, string | null>();
  const byteHash = (abs: string): string | null => {
    const cached = hashes.get(abs);
    if (cached !== undefined) return cached;
    let result: string | null;
    try {
      result = sha1Bytes(deps.readBytes(abs));
    } catch {
      result = null;
    }
    hashes.set(abs, result);
    return result;
  };
  const isFileOnDisk = (abs: string): boolean => byteHash(abs) !== null;

  // Engine identity must be PROVABLE before any skip: if the playwright version or the Chromium
  // revision can't be resolved (a vendored/relocated/partial install), we can't prove the renderer
  // binary is unchanged across approve→check, so emit nothing (a both-unresolved pair would otherwise
  // produce an identical, machine-independent engine hash and skip a real binary-drift pixel shift).
  if (playwrightVersion === "" || chromiumRevision === "") return none();

  // ---- Build G's REACHABILITY file set ---------------------------------------------------------
  const resolver = createResolver(cwd, deps.readText);
  if (!resolver.tsconfigFound) return none(); // can't trust alias resolution → never skip

  // Head templates (preview-head.html / manager-head.html) inject globals OUTSIDE the import system —
  // their <link>/<style> @import/url() targets become EXTRA graph roots so the closure below follows
  // (and byte-hashes) the head-injected stylesheets/assets and their transitive deps.
  const extraRoots: string[] = [];
  for (const root of globalRoots) {
    if (!HEAD_TEMPLATE_RE.test(root.split(sep).join("/"))) continue;
    let text: string;
    try {
      text = deps.readText(root);
    } catch {
      return none(); // a head template we can't read → can't enumerate its globals → never skip
    }
    const { roots, dynamic } = parseHeadTemplate(text, resolve(root), isFileOnDisk);
    if (dynamic) return none(); // an unresolved/dynamic head <link>/<style> target → unknown global → never skip
    extraRoots.push(...roots);
  }

  // The transitive import closure of every global ROOT (globbed globals + head-template targets) —
  // auto-covers decorator/addon-imported global CSS of any name, theme→token chains, url() assets. Any
  // dynamic/unresolved import in that closure makes the global set untrustworthy → emit nothing.
  const allRoots = [...new Set([...globalRoots.map((r) => resolve(r)), ...extraRoots])];
  const globalGraph: ImportGraph = buildImportGraph(cwd, allRoots, resolver);
  if (!globalGraph.built || !graphComplete(globalGraph)) return none(); // global closure untrustworthy → never skip

  const globalFiles = new Set<string>();
  for (const closure of globalGraph.storyClosure?.values() ?? []) {
    for (const abs of closure) globalFiles.add(abs);
  }
  for (const root of allRoots) globalFiles.add(root);

  // Fail closed if NO global inputs were provable (an empty set would make G an engine-only hash that
  // can't witness a global-file change). For a real Storybook project the `.storybook/**` globs always
  // populate this; an empty set means we can't enumerate the globals → never skip.
  if (globalFiles.size === 0) return none();

  // ---- Byte-hash the global set → G ------------------------------------------------------------
  const globalHashes: FileHash[] = [];
  for (const abs of globalFiles) {
    // Defensive: a global file resolved OUTSIDE cwd (a `../../` head-target escape) can't be expressed
    // portably in git's path space — distrust the whole G rather than emit a non-portable fingerprint.
    if (abs !== cwdResolved && !abs.startsWith(cwdResolved + sep)) return none();
    const hash = byteHash(abs);
    if (hash === null) return none(); // a global file we can't hash → G untrustworthy → never skip
    globalHashes.push([relPosix(cwd, abs), hash]);
  }
  const engineHash = engineFingerprint(playwrightVersion, chromiumRevision);
  const global = globalFingerprint(globalHashes, engineHash);

  // ---- Per-story closure hashes → S, then per-render F -----------------------------------------
  const closureHashesByStory = new Map<string, readonly FileHash[] | null>();
  for (const [sf, closure] of storyGraph.storyClosure ?? new Map<string, Set<string>>()) {
    const pairs: FileHash[] = [];
    let ok = true;
    for (const abs of closure) {
      const hash = byteHash(abs);
      if (hash === null) {
        ok = false; // a closure file we can't byte-hash → this story isn't fingerprintable
        break;
      }
      pairs.push([relPosix(cwd, abs), hash]);
    }
    closureHashesByStory.set(sf, ok ? pairs : null);
  }

  const ctx: SkipContext = { graph: storyGraph, closureHashesByStory, global };
  const fps: Record<string, string> = {};
  const emittedStoryFiles = new Set<string>();
  for (const target of targets) {
    const fp = computeFingerprint(target, ctx);
    if (fp !== null) {
      fps[renderRelPath(target)] = fp;
      emittedStoryFiles.add((target.storyFile as string).toLowerCase());
    }
  }

  // The content inputs behind the emitted fps: the globals (in every F) + the closures of the emitted
  // renders. Capture re-hashes these after screenshotting to catch a mid-run source edit (the TOCTOU
  // between scope's byte-hash and capture's screenshot) and drops the run's fps on any change.
  const inputs: Record<string, string> = {};
  for (const [path, hash] of globalHashes) inputs[path] = hash;
  for (const sf of emittedStoryFiles) {
    const pairs = closureHashesByStory.get(sf);
    if (pairs) {
      for (const [path, hash] of pairs) inputs[path] = hash;
    }
  }
  return { fps, inputs };
}
