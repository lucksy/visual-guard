import { realpathSync } from "node:fs";
import { posix, resolve, sep } from "node:path";

/**
 * Component Studio image-serving path guard (P3, SPEC §10). A snapshot's `image_path` comes from the DB
 * (written by the engine sync / `record-figma` / `reindex`) and is **repo-relative**. Before the server
 * streams it, the path must be proven to live under the two committed/derived image roots —
 * `.visual-baselines/` (committed baselines, incl. `.figma/`) or `.visual-guard/` (the gitignored blob
 * cache + DB dir). This mirrors `baseline.ts`'s `assertUnder` and `studio.ts`'s `isUnder`, and is the
 * thing standing between an attacker-authored `figma_meta.json` (committed, diffable) and an
 * out-of-tree read.
 *
 * Defense is layered: {@link isServableImagePath} is a **pure lexical** gate (no I/O — unit-tested,
 * carries the mandatory `..`-escape coverage); {@link resolveServableImage} adds **realpath**
 * confinement so a committed symlink whose name is lexically inside the tree but which points outside
 * is still refused.
 */

/** The two repo-relative roots a servable image may live under (POSIX, trailing slash). */
const IMAGE_ROOTS = [".visual-baselines/", ".visual-guard/"] as const;

/**
 * Pure lexical guard: does `repoRelPath` *look* like a path safely under one of the image roots? Refuses
 * NUL bytes, backslashes, absolute paths (POSIX `/…` or Windows `C:\…`), and any `..` that escapes after
 * normalization. Does **not** touch the filesystem — {@link resolveServableImage} adds the realpath check.
 */
export function isServableImagePath(repoRelPath: string): boolean {
  if (typeof repoRelPath !== "string" || repoRelPath.length === 0) {
    return false;
  }
  if (repoRelPath.includes("\0") || repoRelPath.includes("\\")) {
    return false; // NUL or a Windows separator — never a legitimate stored POSIX path
  }
  if (repoRelPath.startsWith("/") || /^[A-Za-z]:/.test(repoRelPath)) {
    return false; // absolute (POSIX or Windows drive) — must be repo-relative
  }
  const normalized = posix.normalize(repoRelPath);
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    return false; // escapes the project root
  }
  return IMAGE_ROOTS.some((root) => normalized.startsWith(root));
}

/**
 * True iff `childAbs` resolves to `parentAbs` or strictly inside it, comparing **real** (symlink-resolved)
 * paths. A missing/dangling target makes `realpathSync` throw → `false` (so this doubles as the existence
 * check). Identical in spirit to `studio.ts`'s `isUnder`.
 */
function isUnderReal(childAbs: string, parentAbs: string): boolean {
  let child: string;
  let parent: string;
  try {
    child = realpathSync(childAbs);
  } catch {
    return false; // missing file or dangling symlink
  }
  try {
    parent = realpathSync(parentAbs);
  } catch {
    return false; // the root itself doesn't exist → nothing can legitimately be under it
  }
  return child === parent || child.startsWith(parent + sep);
}

/**
 * Resolve a DB `image_path` to an **absolute, realpath-confined** file under `projectRoot`, or `null` if
 * it fails the lexical guard, escapes both image roots on the real filesystem, or does not exist. The
 * server 404s on `null` — a crafted `..` or out-of-tree symlink never streams a host file.
 */
export function resolveServableImage(projectRoot: string, repoRelPath: string): string | null {
  if (!isServableImagePath(repoRelPath)) {
    return null;
  }
  const childAbs = resolve(projectRoot, repoRelPath);
  for (const root of IMAGE_ROOTS) {
    const rootAbs = resolve(projectRoot, root);
    if (isUnderReal(childAbs, rootAbs)) {
      // Return the symlink-resolved real path so the stream reads exactly what we confined.
      return realpathSync(childAbs);
    }
  }
  return null;
}
