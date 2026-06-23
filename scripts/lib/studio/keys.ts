import { join } from "node:path";
import { sanitizePathSegment } from "../targets";

/**
 * Component Studio key + image-layout helpers (SPEC §7). Pure — no I/O. Two jobs:
 *  1. Derive the stable `components.key` slug and parse a committed code-baseline key back into its
 *     parts, reusing the engine's `<instance>/<name>/<state>@<viewport>.png` scheme + path-sanitizer.
 *  2. Centralize the on-disk layout: committed baselines under `.visual-baselines/` (code) and
 *     `.visual-baselines/.figma/` (figma) + `figma_meta.json`; the gitignored, rebuildable DB and
 *     content-addressed blob cache under `.visual-guard/`.
 */

/** Default output root for derived/transient Studio artifacts (mirrors the engine's `.visual-guard`). */
export const DEFAULT_OUT_ROOT = ".visual-guard";

// --- DB key derivation ------------------------------------------------------

export interface CodeBaselineKey {
  instance: string;
  name: string;
  state: string;
  viewport: number;
}

/**
 * Parse a committed code-baseline key `<instance>/<name>/<state>@<viewport>.png` (the engine's
 * `renderRelPath` scheme) into its parts, or `null` if it doesn't match — so `reindex` can walk a
 * baseline tree and skip anything that isn't a code render (e.g. the `.figma/` subtree). `instance`
 * and `name` never contain `/` or `@` (they were sanitized at capture time), so the split is exact.
 */
export function parseCodeBaselineKey(key: string): CodeBaselineKey | null {
  const parts = key.split("/");
  if (parts.length !== 3) {
    return null;
  }
  const [instance, name, file] = parts;
  if (!instance || !name || !file) {
    return null;
  }
  const match = /^(.+)@(\d+)\.png$/.exec(file);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const viewport = Number(match[2]);
  if (!Number.isInteger(viewport) || viewport <= 0) {
    return null;
  }
  return { instance, name, state: match[1], viewport };
}

/** The stable `components.key` slug for a code component: `<instance>/<name>` (both path-sanitized). */
export function codeComponentKey(instance: string, name: string): string {
  return `${sanitizePathSegment(instance)}/${sanitizePathSegment(name)}`;
}

/**
 * The stable `components.key` slug for a Figma component, namespaced per file (D11) so the same node
 * id in two libraries never collides: `figma/<fileKey>/<nodeId>`. This is a DB string key, not a
 * filesystem path, so the node id's `:` is kept verbatim (the API form).
 */
export function figmaComponentKey(fileKey: string, nodeId: string): string {
  return `figma/${fileKey}/${nodeId}`;
}

// --- On-disk layout (SPEC §7) ----------------------------------------------

/** The gitignored, rebuildable SQLite index. */
export function studioDbPath(outRoot: string = DEFAULT_OUT_ROOT): string {
  return join(outRoot, "studio.db");
}

/** Content-addressed cache dir for transient blobs (current renders / unapproved Figma pulls). */
export function blobsDir(outRoot: string = DEFAULT_OUT_ROOT): string {
  return join(outRoot, "cache", "blobs");
}

/** Path of one content-addressed blob (`<sha256>.png`). */
export function blobPath(sha256: string, outRoot: string = DEFAULT_OUT_ROOT): string {
  return join(blobsDir(outRoot), `${sha256}.png`);
}

/** Content-addressed cache dir for on-demand pixel-diff overlay images (server `GET /api/diff`). */
export function diffsDir(outRoot: string = DEFAULT_OUT_ROOT): string {
  return join(outRoot, "cache", "diffs");
}

/** Committed Figma baselines live under `<baselineDir>/.figma/`. */
export function figmaBaselineDir(baselineDir: string): string {
  return join(baselineDir, ".figma");
}

/** The committed, diffable Figma metadata index (ids/versions/variant defs). */
export function figmaMetaPath(baselineDir: string): string {
  return join(baselineDir, "figma_meta.json");
}

/** Make a Figma node id safe as a single path segment (`1:23` → `1-23`) for cross-platform commits. */
export function sanitizeNodeId(nodeId: string): string {
  return sanitizePathSegment(nodeId.replace(/:/g, "-"));
}

/**
 * The committed path of one Figma baseline image:
 * `<baselineDir>/.figma/<fileKey>/<nodeId>/<variant>@<viewport>.png`. `variant` defaults to
 * `"default"`, `viewport` to `0` (Figma renders at intrinsic size). All segments are path-sanitized
 * so an untrusted node/variant name can never escape the `.figma/` subtree (Windows-safe: no `:`).
 */
export function figmaImagePath(
  baselineDir: string,
  fileKey: string,
  nodeId: string,
  variant?: string,
  viewport?: number,
): string {
  const variantSeg = sanitizePathSegment(variant && variant.length > 0 ? variant : "default");
  return join(
    figmaBaselineDir(baselineDir),
    sanitizePathSegment(fileKey),
    sanitizeNodeId(nodeId),
    `${variantSeg}@${viewport ?? 0}.png`,
  );
}
