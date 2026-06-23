import { copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DB } from "./db";
import { readPngDimensions } from "../../capture";
import { isSafeKey } from "../../compare";
import {
  appendSnapshot,
  getComponentById,
  getSnapshotById,
  getVariantById,
  latestSnapshot,
  recomputeStatus,
  recordComparison,
} from "./store";
import { resolveServableImage } from "./images";

/**
 * Component Studio "approve as baseline" (P6 review workflow). Promotes a captured `current` render to the
 * committed `code` baseline — the SAME durable action as `/visual-baseline`, reachable from the studio so a
 * reviewer can sign off a render without leaving the UI. This respects the cardinal invariant ("the DB is a
 * rebuildable cache; the committed PNGs are the source of truth"): it WRITES the baseline PNG to disk, then
 * mirrors that into the DB so the studio reflects the sign-off immediately (a later `reindex` reproduces the
 * same state from the now-committed file).
 *
 * It is the studio server's SECOND mutating capability (after `POST /api/sync`), so it is guarded the same
 * way at the route layer (Sec-Fetch-Site / Origin CSRF check) and every destination is hard-confined under
 * `baselineDir` (reusing the engine's `assertUnder` boundary) — a snapshot's reconstructed key can never
 * escape the baseline tree.
 */

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
const toPosix = (path: string): string => path.split(sep).join("/");

export type ApproveResult =
  | {
      ok: true;
      /** false = the snapshot was already an approved baseline (idempotent no-op). */
      promoted: boolean;
      componentId: number;
      /** The committed baseline key (`<instance>/<name>/<state>@<viewport>.png`). */
      key: string;
      /** Repo-relative committed baseline path. */
      baselinePath: string;
    }
  | { ok: false; code: string; message: string };

export interface ApproveOptions {
  db: DB;
  /** Project root the repo-relative `baselineDir` + image paths resolve against. */
  projectRoot: string;
  /** Committed baseline dir (config.baselineDir), repo-relative or absolute. */
  baselineDir: string;
  snapshotId: number;
}

/** Lexical confinement: `childAbs` must be `parentAbs` or strictly inside it. */
function isUnder(childAbs: string, parentAbs: string): boolean {
  const child = resolve(childAbs);
  const parent = resolve(parentAbs);
  return child === parent || child.startsWith(parent + sep);
}

/**
 * SYMLINK confinement for the write destination — symmetric with the read path's `images.ts` realpath
 * confinement. The lexical {@link isUnder} alone is bypassable by a committed directory **symlink** under
 * `.visual-baselines/` (which is committed + diffable, i.e. an untrusted input): `mkdirSync`/`copyFileSync`
 * would follow it and write OUTSIDE the repo. With `baselineAbs` already an existing real root, this walks
 * every path segment of `destAbs` below it and refuses if ANY existing component is a symlink (caught by
 * `lstat`, even a dangling one) — so a committed symlink can never redirect the baseline write off-tree.
 * Segments that don't exist yet are ours to create as real dirs, so they're safe.
 */
function isSymlinkSafeDest(destAbs: string, baselineAbs: string): boolean {
  const segs = relative(baselineAbs, destAbs)
    .split(sep)
    .filter((s) => s.length > 0);
  if (segs.length === 0 || segs.includes("..")) {
    return false; // dest is the root itself, or escapes it
  }
  let cur = baselineAbs;
  for (const seg of segs) {
    cur = join(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink()) {
        return false; // a symlink anywhere along the path could redirect the write off-tree
      }
    } catch {
      return true; // this segment (and everything below) doesn't exist — we create them as real dirs
    }
  }
  return true;
}

/**
 * Promote snapshot `snapshotId` to the committed code baseline for its (component, variant) lane.
 * Returns a discriminated result rather than throwing on user-actionable failures (no such snapshot, a
 * Figma snapshot, a snapshot with no reconstructable code key, a missing source blob) so the server can
 * map each to a clean 4xx. Only a genuine filesystem/copy failure throws.
 */
export function approveSnapshotAsBaseline(options: ApproveOptions): ApproveResult {
  const { db, projectRoot, baselineDir, snapshotId } = options;
  const snap = getSnapshotById(db, snapshotId);
  if (snap === undefined) {
    return { ok: false, code: "not_found", message: `no snapshot with id ${snapshotId}.` };
  }
  if (snap.source === "figma") {
    return {
      ok: false,
      code: "not_approvable",
      message: "a Figma snapshot is a design reference, not a code baseline.",
    };
  }
  const component = getComponentById(db, snap.component_id);
  if (component === undefined) {
    return { ok: false, code: "not_found", message: `snapshot ${snapshotId} has no component.` };
  }
  if (!component.code_instance || !component.code_target) {
    return {
      ok: false,
      code: "not_approvable",
      message: "this component has no code linkage to write a baseline for.",
    };
  }
  if (snap.variant_id === null) {
    return {
      ok: false,
      code: "not_approvable",
      message: "snapshot has no variant lane — cannot map it to a baseline key.",
    };
  }
  const variant = getVariantById(db, snap.variant_id);
  if (variant === undefined) {
    return { ok: false, code: "not_found", message: `snapshot ${snapshotId} has no variant.` };
  }

  // Reconstruct the engine's committed-baseline key: `<instance>/<name>/<state>@<viewport>.png`. The
  // variant name IS `<state>@<viewport>` (set at sync), and instance/name were path-sanitized at capture,
  // so this rebuilds the exact key the baseline was (or will be) stored under.
  const key = `${component.code_instance}/${component.code_target}/${variant.name}.png`;
  if (!isSafeKey(key)) {
    return { ok: false, code: "bad_request", message: `unsafe baseline key ${JSON.stringify(key)}.` };
  }

  // Already an approved committed baseline → nothing to copy (idempotent).
  if (snap.source === "code" && snap.approved === 1) {
    return {
      ok: true,
      promoted: false,
      componentId: component.id,
      key,
      baselinePath: snap.image_path,
    };
  }
  // Idempotent for a `current` render too: if the lane's latest committed baseline already has these exact
  // bytes (this render was approved before), there is nothing to promote — return a true no-op instead of
  // re-copying + appending another redundant `same` comparison row on every repeated call.
  const laneBaseline = latestSnapshot(db, component.id, "code", snap.variant_id);
  if (laneBaseline !== undefined && laneBaseline.image_hash === snap.image_hash) {
    return {
      ok: true,
      promoted: false,
      componentId: component.id,
      key,
      baselinePath: laneBaseline.image_path,
    };
  }

  const srcAbs = resolveServableImage(projectRoot, snap.image_path);
  if (srcAbs === null) {
    return {
      ok: false,
      code: "image_unavailable",
      message: `the render for snapshot ${snapshotId} is missing or out of bounds.`,
    };
  }

  const baselineAbs = resolve(projectRoot, baselineDir);
  const destAbs = join(baselineAbs, key);
  // Ensure the baseline root exists so the symlink walk has a real anchor (first-ever approve on a project
  // with no committed baselines yet). Creating the configured root dir itself is safe.
  mkdirSync(baselineAbs, { recursive: true });
  // Hard security boundary — a reconstructed key must never escape the baseline tree, lexically OR via a
  // committed symlink along the path (symmetric with the image-read path's realpath confinement).
  if (!isUnder(destAbs, baselineAbs) || !isSymlinkSafeDest(destAbs, baselineAbs)) {
    return {
      ok: false,
      code: "forbidden",
      message: "refusing to write a baseline outside the baseline dir.",
    };
  }

  // Write the committed baseline PNG (the durable source of truth), then mirror into the DB.
  mkdirSync(dirname(destAbs), { recursive: true });
  copyFileSync(srcAbs, destAbs);

  const bytes = readFileSync(destAbs);
  const hash = sha256(bytes);
  const dims = readPngDimensions(bytes);
  // Store the baseline path RELATIVE to the project root (the form the image server can confine + serve),
  // computed from the absolute destination so it's correct whether `baselineDir` was given relative or
  // absolute — an absolute image_path would fail the servable-path guard and 404 in the UI.
  const baselineRel = toPosix(relative(projectRoot, destAbs));
  const baseSnap = appendSnapshot(db, {
    componentId: component.id,
    variantId: snap.variant_id,
    source: "code",
    imagePath: baselineRel,
    imageHash: hash,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    viewport: snap.viewport ?? null,
    approved: true,
  });
  // The promoted render now EQUALS the baseline, so the lane's latest verdict is `same` (0 diff) — this
  // is what clears the regression flag for the lane the moment the reviewer approves.
  recordComparison(db, {
    componentId: component.id,
    axis: "current_vs_baseline",
    fromSnapshot: baseSnap.id,
    toSnapshot: snap.id,
    diffRatio: 0,
    status: "same",
  });
  recomputeStatus(db, component.id);

  return {
    ok: true,
    promoted: true,
    componentId: component.id,
    key,
    baselinePath: baselineRel,
  };
}
