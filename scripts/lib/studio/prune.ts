import { readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DB } from "./db";
import { blobsDir } from "./keys";

/**
 * Component Studio history/disk pruning (P5, SPEC §9.5 / PLAN P5). Bounds DB + blob-cache growth on an
 * active design system. **Invariants:**
 *  - **Approved snapshots are NEVER deleted** — they index committed baseline PNGs (the source of truth).
 *  - Per `(component, variant, source)` lane, keep the newest `retainPerSource` non-approved snapshots
 *    (`retainCurrent` for the live `current` lane); delete the older non-approved ones.
 *  - Deleting a snapshot cascades its `regressions` rows (schema FK `ON DELETE CASCADE`).
 *  - Orphaned `cache/blobs/<sha>.png` (no surviving snapshot references the hash) are swept by the CLI.
 *
 * Pure-ish: `planPrune` reads the injected DB (like `store.ts`) and decides; `applyPrune` deletes in one
 * transaction. The fs blob-sweep + VACUUM live in the `studio.ts` CLI.
 */

export interface PruneRetention {
  retainPerSource: number;
  retainCurrent: number;
}

export interface PruneOptions extends PruneRetention {
  /** Sweep unreferenced `cache/blobs/*.png`. */
  pruneOrphanBlobs: boolean;
  /** Freed-page count past which to VACUUM (default {@link VACUUM_FREELIST_THRESHOLD}; for tests). */
  vacuumThreshold?: number;
}

export interface PruneSummary {
  deletedSnapshots: number;
  removedBlobs: number;
  vacuumed: boolean;
}

/** Freed-page threshold past which we VACUUM (rewrites the whole file — not worth it for a few rows). */
export const VACUUM_FREELIST_THRESHOLD = 64;

export interface PrunePlan {
  /** Snapshot ids to delete (non-approved, out of the retention window). */
  deleteSnapshotIds: number[];
  /** image_hash values of SURVIVING snapshots stored in the blob cache — the orphan-sweep keep-set. */
  referencedBlobHashes: Set<string>;
}

interface PruneRow {
  id: number;
  component_id: number;
  variant_id: number | null;
  source: string;
  image_path: string;
  image_hash: string;
  approved: number;
}

const isBlobPath = (path: string): boolean => path.includes("cache/blobs/");

/**
 * Decide which snapshots to prune and which blob hashes survive. Reads only. Lanes are walked
 * newest-first (`version_seq DESC`); approved rows always survive and don't count against the window.
 */
export function planPrune(db: DB, retention: PruneRetention): PrunePlan {
  const rows = db
    .prepare(
      `SELECT id, component_id, variant_id, source, image_path, image_hash, approved
       FROM snapshots
       ORDER BY component_id, source, variant_id, version_seq DESC`,
    )
    .all() as PruneRow[];

  const keptPerLane = new Map<string, number>();
  const deleteSnapshotIds: number[] = [];
  const referencedBlobHashes = new Set<string>();

  for (const row of rows) {
    let survives: boolean;
    if (row.approved) {
      survives = true; // committed baselines are never pruned and don't consume the window
    } else {
      const laneKey = `${row.component_id}|${row.variant_id ?? "null"}|${row.source}`;
      const limit = row.source === "current" ? retention.retainCurrent : retention.retainPerSource;
      const kept = keptPerLane.get(laneKey) ?? 0;
      if (kept < limit) {
        keptPerLane.set(laneKey, kept + 1);
        survives = true;
      } else {
        survives = false;
        deleteSnapshotIds.push(row.id);
      }
    }
    if (survives && isBlobPath(row.image_path)) {
      referencedBlobHashes.add(row.image_hash);
    }
  }

  return { deleteSnapshotIds, referencedBlobHashes };
}

/**
 * Delete the planned snapshot rows in a single transaction (cascading their `regressions`). Returns the
 * number of snapshot rows removed. Idempotent: a second run with an empty plan deletes nothing.
 */
export function applyPrune(db: DB, deleteSnapshotIds: number[]): number {
  if (deleteSnapshotIds.length === 0) {
    return 0;
  }
  const del = db.prepare(`DELETE FROM snapshots WHERE id = ?`);
  const run = db.transaction((ids: number[]) => {
    let n = 0;
    for (const id of ids) {
      n += del.run(id).changes;
    }
    return n;
  });
  return run(deleteSnapshotIds) as number;
}

/**
 * Full prune orchestration (the `studio prune` op + the sync tail): plan → delete rows (cascading
 * regressions) → sweep orphaned `cache/blobs/*.png` (when enabled) → VACUUM only past the freed-page
 * threshold. Idempotent. Approved/committed baselines are never touched. Returns a summary.
 */
export function pruneStudio(
  db: DB,
  options: PruneOptions,
  paths: { outRoot: string; cwd?: string },
): PruneSummary {
  const cwd = paths.cwd ?? process.cwd();
  const plan = planPrune(db, options);
  const deletedSnapshots = applyPrune(db, plan.deleteSnapshotIds);

  let removedBlobs = 0;
  if (options.pruneOrphanBlobs) {
    const blobsAbs = resolve(cwd, blobsDir(paths.outRoot));
    let entries: string[] = [];
    try {
      entries = readdirSync(blobsAbs);
    } catch {
      entries = []; // no cache dir yet → nothing to sweep
    }
    for (const entry of entries) {
      const match = /^([0-9a-f]+)\.png$/i.exec(entry);
      if (match && match[1] && !plan.referencedBlobHashes.has(match[1])) {
        try {
          unlinkSync(join(blobsAbs, entry));
          removedBlobs += 1;
        } catch {
          // a concurrent reader/sweep removed it already — ignore
        }
      }
    }
  }

  const freePages = db.pragma("freelist_count", { simple: true }) as number;
  const vacuumed = freePages > (options.vacuumThreshold ?? VACUUM_FREELIST_THRESHOLD);
  if (vacuumed) {
    db.exec("VACUUM"); // outside any transaction (applyPrune's transaction has already committed)
  }
  return { deletedSnapshots, removedBlobs, vacuumed };
}
