import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { loadConfig } from "./lib/config";
import { isSafeKey, walkPngFiles } from "./compare";
import { openDb, type DB } from "./lib/studio/db";
import {
  appendSnapshot,
  computeDrift,
  countSnapshots,
  isMappingStale,
  latestSnapshotForSource,
  listComponents,
  listRenameEvents,
  populationDelta,
  recordComparison,
  recordFigmaCodeLink,
  recordPopulationSnapshot,
  recordUsage,
  recomputeParity,
  recomputeStatus,
  rollupLifecycle,
  upsertComponent,
  upsertVariant,
} from "./lib/studio/store";
import { conformance, levelToStatus, type ConformanceLevel } from "./lib/studio/conformance";
import { resolveServableImage } from "./lib/studio/images";
import {
  codeComponentKey,
  figmaBaselineDir,
  figmaComponentKey,
  figmaMetaPath,
  parseCodeBaselineKey,
  studioDbPath,
  DEFAULT_OUT_ROOT,
} from "./lib/studio/keys";
import { parseFigmaMeta } from "./lib/studio/figma-meta";
import { axesToJson, codeAxesFromState, parseVariantAxes } from "./lib/studio/variant-axes";
import { pruneStudio } from "./lib/studio/prune";

/**
 * Component Studio CLI. Four subcommands, all headless (no Figma/MCP, no network — code-only repos work
 * fully; they read committed PNGs + `figma_meta.json` from disk):
 *  - `reindex` rebuilds the gitignored SQLite index from the committed baselines (proving "the DB is a
 *    cache; PNGs + git are the source of truth").
 *  - `status` reports DB-vs-baseline integrity.
 *  - `prune` bounds history + blob-cache growth (never touches baselines).
 *  - `conformance` scores advisory Figma↔code parity (informational only — never gates CI; see ci.ts).
 * The pure store/keys/figma-meta logic lives in `scripts/lib/studio/**`; this is the I/O shell.
 */

const PREFIX = "Visual Guard studio";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

const toPosix = (path: string): string => path.split(sep).join("/");

/** sha256 + decoded dimensions for one image file (dims best-effort: null on an undecodable file). */
async function imageInfo(
  absPath: string,
): Promise<{ hash: string; width: number | null; height: number | null }> {
  const bytes = readFileSync(absPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  let width: number | null = null;
  let height: number | null = null;
  try {
    const meta = await sharp(bytes).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
  } catch {
    // Undecodable file — record the snapshot by hash anyway; dims stay null.
  }
  return { hash, width, height };
}

/**
 * True iff `childAbs` resolves to `parentAbs` or strictly inside it — confinement on the REAL path.
 * Uses `realpathSync` so a committed **symlink** under `.figma/` whose name is lexically inside the
 * tree but which points outside is refused (a lexical check would follow it and read an arbitrary host
 * file). A missing/dangling path makes `realpathSync` throw → `false` (so it is also the existence
 * guard). The figma side is meta-driven (it bypasses `walkPngFiles`, which already skips symlinks for
 * the code side), so this is the only thing standing between an attacker-authored `figma_meta.json`
 * and an out-of-tree read.
 */
function isUnder(childAbs: string, parentAbs: string): boolean {
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
    return false; // no .figma/ root → nothing can legitimately be under it
  }
  return child === parent || child.startsWith(parent + sep);
}

export interface ReindexOptions {
  db: DB;
  /** Baseline dir as given in config (e.g. ".visual-baselines"), resolved against `cwd`. */
  baselineDir: string;
  /** Project root for resolving repo-relative paths; defaults to process.cwd(). */
  cwd?: string;
}

export interface ReindexSummary {
  components: number;
  codeSnapshots: number;
  figmaSnapshots: number;
  /** Keys/paths skipped (not a code render, unsafe path, or a missing/escaping figma image). */
  skipped: string[];
}

/**
 * Rebuild `db` from the committed baselines under `baselineDir` (code) and `figma_meta.json` + the
 * `.figma/` tree (figma). Deterministic: code keys are walked sorted, figma is driven by the meta in
 * array order, so a delete-then-reindex reproduces identical logical rows. Content-hash dedupe means
 * re-running over unchanged baselines adds no history. Returns a populated-row summary.
 */
export async function reindexInto(options: ReindexOptions): Promise<ReindexSummary> {
  const { db } = options;
  const cwd = options.cwd ?? process.cwd();
  const baselineDir = options.baselineDir;
  const baseAbs = resolve(cwd, baselineDir);
  const skipped: string[] = [];
  let codeSnapshots = 0;
  let figmaSnapshots = 0;

  // --- Code side (the engine's committed baselines) ---
  for (const key of walkPngFiles(baseAbs)) {
    if (!isSafeKey(key) || key.startsWith(".figma/")) {
      continue; // the .figma/ subtree is rebuilt from the meta below, not walked as code
    }
    const parsed = parseCodeBaselineKey(key);
    if (parsed === null) {
      skipped.push(key);
      continue;
    }
    const info = await imageInfo(join(baseAbs, key));
    const componentId = upsertComponent(db, {
      key: codeComponentKey(parsed.instance, parsed.name),
      name: parsed.name,
      codeInstance: parsed.instance,
      codeTarget: parsed.name,
    });
    const variantId = upsertVariant(db, {
      componentId,
      source: "code",
      name: `${parsed.state}@${parsed.viewport}`,
      // F4: code axes are live-sync-only (a PNG can't reveal story args), so reindex repopulates the
      // synthetic {Variant: state} from the committed baseline key — honest, never claims real prop axes.
      propsJson: axesToJson(codeAxesFromState(parsed.state)),
    });
    // Reconstruct the "Used in" usage from the same parsed key sync records (kind=story, used_in=state),
    // so a delete-then-reindex reproduces the usages dimension too — the DB stays a faithful rebuildable
    // cache. reindex starts from a fresh DB, so INSERT OR IGNORE needs no stale-state reconciliation here.
    recordUsage(db, {
      componentId,
      kind: "story",
      usedIn: parsed.state,
      detail: parsed.instance,
    });
    const result = appendSnapshot(db, {
      componentId,
      variantId,
      source: "code",
      imagePath: `${toPosix(baselineDir)}/${key}`,
      imageHash: info.hash,
      width: info.width,
      height: info.height,
      viewport: parsed.viewport,
      approved: true,
    });
    if (result.inserted) {
      codeSnapshots += 1;
    }
  }

  // --- Figma side (driven by the committed meta, not a blind walk) ---
  const metaAbs = resolve(cwd, figmaMetaPath(baselineDir));
  const figmaRootAbs = resolve(cwd, figmaBaselineDir(baselineDir));
  if (existsSync(metaAbs)) {
    const meta = parseFigmaMeta(JSON.parse(readFileSync(metaAbs, "utf8")));
    for (const file of meta.files) {
      for (const component of file.components) {
        // Upsert the component lazily — only once one of its images actually resolves — so a
        // phantom-only entry (every image missing/escaping) never becomes an empty catalogued card.
        let componentId: number | null = null;
        for (const image of component.images) {
          const imgAbs = resolve(cwd, image.path);
          // Confine to the REAL path under <baselineDir>/.figma/: refuses `..`, absolutes, AND a
          // symlink that points out of the tree; also rejects a missing PNG (realpathSync throws).
          if (!isUnder(imgAbs, figmaRootAbs)) {
            skipped.push(image.path);
            continue;
          }
          if (componentId === null) {
            // F1: re-link onto the code component if the committed meta carries a `codeKey` (so the
            // node↔code mapping survives this destroy-and-rebuild). The COALESCE upsert merges the
            // figma linkage onto the existing code row → ONE matched row; absent a codeKey it falls back
            // to the figma-only key → a separate figma-only row (the historical behavior).
            const linkedKey =
              component.codeKey ?? figmaComponentKey(file.fileKey, component.nodeId);
            componentId = upsertComponent(db, {
              key: linkedKey,
              name: component.name,
              description: component.description ?? null,
              figmaFileKey: file.fileKey,
              figmaNodeId: component.nodeId,
              figmaLastModified: component.lastModified ?? null,
            });
            if (component.codeKey !== undefined) {
              recordFigmaCodeLink(db, {
                figmaFileKey: file.fileKey,
                figmaNodeId: component.nodeId,
                componentKey: component.codeKey,
              });
            }
          }
          const info = await imageInfo(imgAbs);
          // Fold viewport into the variant lane (mirroring the code side's `<state>@<viewport>`), so
          // two committed baselines of the same node+variant at different viewports stay in distinct
          // lanes — never wrongly deduped or recorded as a "new version" of each other.
          const variantId = upsertVariant(db, {
            componentId,
            source: "figma",
            name: `${image.variant ?? "default"}@${image.viewport ?? 0}`,
            // F4: rehydrate the Figma variant-axis labels from the committed meta (durable across reindex):
            // the explicit `image.axes` if present, else re-parsed from the variant label.
            propsJson: axesToJson(image.axes ?? parseVariantAxes(image.variant ?? "default")),
          });
          const result = appendSnapshot(db, {
            componentId,
            variantId,
            source: "figma",
            imagePath: toPosix(image.path),
            imageHash: info.hash,
            width: info.width,
            height: info.height,
            viewport: image.viewport ?? null,
            figmaVersionId: image.figmaVersionId ?? null,
            figmaLastModified: image.figmaLastModified ?? component.lastModified ?? null,
            approved: true,
          });
          if (result.inserted) {
            figmaSnapshots += 1;
          }
        }
      }
    }
  }

  // --- Roll up status + lifecycle for every component now that snapshots exist ---
  // lifecycle is derived ONCE here (the single rollup point), from presence — matched/figma-only/
  // code-only. A reindex starts from an empty DB so nothing is ever 'removed' here.
  const components = listComponents(db);
  for (const component of components) {
    recomputeStatus(db, component.id);
    rollupLifecycle(db, component.id);
  }
  // F5: record one population baseline point so a later sync can diff "N new since last sync" against it.
  recordPopulationSnapshot(db);

  return { components: components.length, codeSnapshots, figmaSnapshots, skipped };
}

export interface StatusReport {
  components: number;
  codeBaselineFiles: number;
  codeSnapshots: number;
  figmaBaselineFiles: number;
  figmaSnapshots: number;
  /** True when DB snapshot counts match the committed PNG counts (a healthy, current index). */
  inSync: boolean;
  /** v5 (F3): components soft-marked `removed` (advisory drift signal; does NOT affect `inSync`). */
  removedComponents: number;
  /** v5 (F5): matched components whose mapping is stale — design ahead of code (advisory). */
  staleComponents: number;
}

/** Integrity check: DB row counts vs the committed baselines (code on disk, figma per the meta). */
export function statusReport(options: { db: DB; baselineDir: string; cwd?: string }): StatusReport {
  const cwd = options.cwd ?? process.cwd();
  const baseAbs = resolve(cwd, options.baselineDir);

  const codeBaselineFiles = walkPngFiles(baseAbs).filter(
    (key) => isSafeKey(key) && !key.startsWith(".figma/") && parseCodeBaselineKey(key) !== null,
  ).length;

  // Figma's source of truth is the committed `figma_meta.json`, not a raw `.figma/` walk — count the
  // images it DECLARES so a meta-vs-DB mismatch (a phantom/missing PNG, an escaping path, or a
  // collapsed lane) flips inSync to false, while an undeclared orphan PNG on disk does not.
  let figmaBaselineFiles = 0;
  const metaAbs = resolve(cwd, figmaMetaPath(options.baselineDir));
  if (existsSync(metaAbs)) {
    const meta = parseFigmaMeta(JSON.parse(readFileSync(metaAbs, "utf8")));
    for (const file of meta.files) {
      for (const component of file.components) {
        figmaBaselineFiles += component.images.length;
      }
    }
  }

  const codeSnapshots = countSnapshots(options.db, "code");
  const figmaSnapshots = countSnapshots(options.db, "figma");

  return {
    components: listComponents(options.db).length,
    codeBaselineFiles,
    codeSnapshots,
    figmaBaselineFiles,
    figmaSnapshots,
    inSync: codeBaselineFiles === codeSnapshots && figmaBaselineFiles === figmaSnapshots,
    // Advisory only — a soft-marked removal / stale mapping is informational and must never flip `inSync`
    // (which is the DB-vs-committed-PNG integrity check, not a drift verdict).
    removedComponents: listComponents(options.db, { lifecycle: "removed" }).length,
    staleComponents: listComponents(options.db).filter((c) => isMappingStale(options.db, c.id)).length,
  };
}

export interface ConformanceSummary {
  /** Components scored (had both a Figma and a code image). */
  scored: number;
  byLevel: Record<ConformanceLevel, number>;
  /** Components skipped (missing one side, or an unreadable/out-of-bounds image). */
  skipped: number;
}

/**
 * Score Figma↔code conformance (advisory) for every linked component and record a `figma_vs_code` row +
 * recompute `parity_status`. Headless: it reads the committed Figma + code baseline PNGs from disk (no
 * MCP). The `figma_vs_code` axis is informational ONLY — it never feeds the CI gate (see ci.ts).
 */
export async function runConformance(options: { db: DB; cwd?: string }): Promise<ConformanceSummary> {
  const { db } = options;
  const cwd = options.cwd ?? process.cwd();
  const summary: ConformanceSummary = {
    scored: 0,
    byLevel: { aligned: 0, minor: 0, divergent: 0 },
    skipped: 0,
  };

  for (const component of listComponents(db)) {
    const figma = latestSnapshotForSource(db, component.id, "figma");
    // Prefer the approved code baseline; fall back to the latest live render.
    const code =
      latestSnapshotForSource(db, component.id, "code") ??
      latestSnapshotForSource(db, component.id, "current");
    if (figma === undefined || code === undefined) {
      summary.skipped += 1;
      continue;
    }
    const figmaAbs = resolveServableImage(cwd, figma.image_path);
    const codeAbs = resolveServableImage(cwd, code.image_path);
    if (figmaAbs === null || codeAbs === null) {
      summary.skipped += 1;
      continue;
    }
    let status: "same" | "changed" | "regression" | "error";
    let diffRatio: number | null = null;
    let dimensionDelta: number | null = null;
    let paletteDelta: number | null = null;
    try {
      const result = await conformance(readFileSync(figmaAbs), readFileSync(codeAbs));
      status = levelToStatus(result.level);
      // Persist the level-DRIVING delta, not palette alone — else a component judged `divergent` purely
      // on a dimension mismatch would store a ~0 `diff_ratio` and read as "in sync" in the UI/timeline.
      diffRatio = Math.max(result.dimensionDelta, result.paletteDelta);
      // Also keep the breakdown (v4) so the UI can explain WHICH axis drifted (size vs color).
      dimensionDelta = result.dimensionDelta;
      paletteDelta = result.paletteDelta;
      summary.byLevel[result.level] += 1;
      summary.scored += 1;
    } catch {
      status = "error"; // an undecodable baseline is recorded, never aborts the whole pass
      summary.skipped += 1;
    }
    // Idempotent: skip appending when the latest figma_vs_code row already compares this EXACT pair
    // (same Figma `from` + code `to` snapshot) with this verdict. Both endpoints are part of the
    // comparison identity — keying on `to` alone would drop a real Figma change (e.g. minor→divergent,
    // which both map to status 'changed') against an unchanged code snapshot.
    const latest = db
      .prepare(
        `SELECT from_snapshot AS fromSnap, to_snapshot AS toSnap, status FROM regressions
         WHERE component_id = @id AND axis = 'figma_vs_code' ORDER BY id DESC LIMIT 1`,
      )
      .get({ id: component.id }) as { fromSnap: number; toSnap: number; status: string } | undefined;
    if (
      latest !== undefined &&
      latest.fromSnap === figma.id &&
      latest.toSnap === code.id &&
      latest.status === status
    ) {
      continue;
    }
    recordComparison(db, {
      componentId: component.id,
      axis: "figma_vs_code",
      fromSnapshot: figma.id,
      toSnapshot: code.id,
      diffRatio,
      dimensionDelta,
      paletteDelta,
      status,
    });
    // Update ONLY parity_status — scoring conformance must never move the code axis (SPEC §14).
    recomputeParity(db, component.id);
  }
  return summary;
}

// --- CLI ------------------------------------------------------------------

export interface StudioCliArgs {
  command: "reindex" | "status" | "prune" | "conformance" | "renames" | "drift";
  config: string;
  baselineDir?: string;
  outRoot: string;
}

export function parseArgs(argv: string[]): StudioCliArgs {
  const command = argv[0];
  if (
    command !== "reindex" &&
    command !== "status" &&
    command !== "prune" &&
    command !== "conformance" &&
    command !== "renames" &&
    command !== "drift"
  ) {
    fail(
      `expected a command: "reindex", "status", "prune", "conformance", "renames", or "drift" (got ${JSON.stringify(command ?? "")}).`,
    );
  }
  let config = "config/visual.config.json";
  let baselineDir: string | undefined;
  let outRoot = DEFAULT_OUT_ROOT;

  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined) {
      fail(`missing value for ${flag}.`);
    }
    return next;
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--config":
        config = value(++i, "--config");
        break;
      case "--baseline":
        baselineDir = value(++i, "--baseline");
        break;
      case "--out":
        outRoot = value(++i, "--out");
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  return { command, config, baselineDir, outRoot };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig(args.config);
  const baselineDir = args.baselineDir ?? config.baselineDir;
  const dbPath = studioDbPath(args.outRoot);

  if (args.command === "reindex") {
    // Rebuild from scratch so a stale row can never survive: drop the DB (and its WAL sidecars) first.
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(dbPath + suffix, { force: true });
    }
    mkdirSync(args.outRoot, { recursive: true });
    const db = openDb(dbPath);
    try {
      const summary = await reindexInto({ db, baselineDir });
      console.log(JSON.stringify({ command: "reindex", dbPath, baselineDir, ...summary }));
    } finally {
      db.close();
    }
    return;
  }

  if (args.command === "prune") {
    if (!existsSync(dbPath)) {
      fail(`no studio index at ${dbPath} — run "studio.ts reindex" or "/visual-sync" first.`);
    }
    const db = openDb(dbPath);
    try {
      const summary = pruneStudio(db, config.studio, { outRoot: args.outRoot });
      console.log(JSON.stringify({ command: "prune", dbPath, ...summary }));
    } finally {
      db.close();
    }
    return;
  }

  if (args.command === "conformance") {
    if (!existsSync(dbPath)) {
      fail(`no studio index at ${dbPath} — run "studio.ts reindex" or "/visual-sync" first.`);
    }
    const db = openDb(dbPath);
    try {
      const summary = await runConformance({ db });
      console.log(JSON.stringify({ command: "conformance", dbPath, ...summary }));
    } finally {
      db.close();
    }
    return;
  }

  if (args.command === "renames") {
    if (!existsSync(dbPath)) {
      fail(`no studio index at ${dbPath} — run "studio.ts reindex" or "/visual-sync" first.`);
    }
    const db = openDb(dbPath);
    try {
      // Advisory rename/move audit trail (figma-node-id / code-instance anchored, plus surfaced fuzzy
      // candidates). Newest-first; never gates anything.
      const renames = listRenameEvents(db);
      console.log(JSON.stringify({ command: "renames", dbPath, count: renames.length, renames }));
    } finally {
      db.close();
    }
    return;
  }

  if (args.command === "drift") {
    if (!existsSync(dbPath)) {
      fail(`no studio index at ${dbPath} — run "studio.ts reindex" or "/visual-sync" first.`);
    }
    const db = openDb(dbPath);
    try {
      // The aggregate advisory drift report: new/removed since last sync, removed + stale + renamed
      // components, presence rollups. Reads no `components.status`; never gates CI.
      const drift = computeDrift(db);
      console.log(JSON.stringify({ command: "drift", dbPath, ...drift }));
    } finally {
      db.close();
    }
    return;
  }

  // status
  if (!existsSync(dbPath)) {
    fail(`no studio index at ${dbPath} — run "studio.ts reindex" first.`);
  }
  const db = openDb(dbPath);
  try {
    const report = statusReport({ db, baselineDir });
    // F5: also surface the "new since last sync" delta (empty until two population snapshots exist).
    const delta = populationDelta(db);
    console.log(JSON.stringify({ command: "status", dbPath, baselineDir, ...report, delta }));
  } finally {
    db.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
