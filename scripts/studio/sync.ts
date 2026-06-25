import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "../lib/config";
import { ensureBrowsersPath } from "../lib/browsers-path";
import { captureAll, readPngDimensions } from "../capture";
import { classify, isSafeKey, walkPngFiles } from "../compare";
import { diffImages } from "../lib/diff";
import { openDb, type DB } from "../lib/studio/db";
import {
  appendSnapshot,
  applyCodeRename,
  getComponentByKey,
  latestLaneStatus,
  listComponents,
  markFigmaPending,
  markRemovedCode,
  pruneStoryUsages,
  recomputeStatus,
  recordComparison,
  recordPopulationSnapshot,
  recordRenameEvent,
  recordUsage,
  rollupLifecycle,
  setSyncState,
  upsertComponent,
  upsertVariant,
  type RegressionStatus,
} from "../lib/studio/store";
import { diffCodeMapping, type CodeKeyRef } from "../lib/studio/rename";
import { axesToJson, codeAxesFromState } from "../lib/studio/variant-axes";
import {
  blobPath,
  blobsDir,
  codeComponentKey,
  parseCodeBaselineKey,
  studioDbPath,
  DEFAULT_OUT_ROOT,
} from "../lib/studio/keys";
import { pruneStudio } from "../lib/studio/prune";
import {
  computeCodeFingerprint,
  matchesAnyGlob,
  planSync,
  type FingerprintFile,
} from "../lib/studio/fingerprint";
import { managedLadleTargets } from "../lib/harness/serve-plan";

/**
 * Component Studio code sync (P2, SPEC §9). **Code capture is the engine** (headless Playwright via
 * `captureAll`); there is no Figma/MCP here (the engine can't call MCP tools — that is the agent-driven
 * `/visual-sync` workflow). For every live render it appends a content-addressed `source='current'`
 * snapshot, ensures the committed `source='code'` baseline is indexed, records a `current_vs_baseline`
 * comparison, and rolls up status. Idempotent: identical bytes re-run → zero new history rows.
 *
 * The pure-ish `syncCodeFromRun` takes an already-captured run dir (no browser), so it is integration-
 * tested over seeded PNGs; the CLI wraps `captureAll` around it.
 */

const PREFIX = "Visual Guard studio sync";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

const toPosix = (path: string): string => path.split(sep).join("/");
const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/**
 * Best-effort read of the run's `renders.json` sidecar (one dir up from `current/`) into a
 * key → live-render-URL map. Capture writes the exact harness preview URL per render key; the sync
 * persists it on the code variant so the Studio can offer a live-preview iframe. Absent/garbage → {}.
 */
function readRenderUrls(runDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, "renders.json"), "utf8")) as {
      renders?: Record<string, { url?: unknown }>;
    };
    const out: Record<string, string> = {};
    for (const [key, record] of Object.entries(parsed.renders ?? {})) {
      if (record && typeof record.url === "string") {
        out[key] = record.url;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export interface SyncCodeOptions {
  db: DB;
  config: Config;
  /** The run's `current/` directory (absolute, or relative to `cwd`). */
  currentDir: string;
  /** Committed baseline dir (config.baselineDir). */
  baselineDir: string;
  /** Output root for the blob cache; defaults to ".visual-guard". */
  outRoot?: string;
  cwd?: string;
  /**
   * True when this run captured the WHOLE project (no `--target` subset). Only a full run sees the
   * complete fresh population, so the rename pre-pass (F2) and the removal pass (F3) run only then — a
   * partial run would mistake every untouched component for a rename/removal. Defaults to false (safe).
   */
  fullSync?: boolean;
}

export interface SyncCodeSummary {
  components: number;
  currentSnapshots: number;
  baselineSnapshots: number;
  comparisons: number;
  byStatus: { same: number; changed: number; regression: number; new: number; error: number };
  /** v5 (F2): code-side renames auto-applied this run (advisory; full sync only). */
  renames: number;
  /** v5 (F3): code components soft-marked `removed` this run (advisory; full sync only). */
  removed: number;
}

/**
 * Persist a captured code run into the DB: per render, a content-addressed `current` snapshot (copied
 * into the blob cache), the committed `code` baseline (when present), and a `current_vs_baseline`
 * comparison; then roll up status and mark the component `synced`. Reads only; never writes baselines.
 */
export async function syncCodeFromRun(options: SyncCodeOptions): Promise<SyncCodeSummary> {
  const { db, config } = options;
  const cwd = options.cwd ?? process.cwd();
  const outRoot = options.outRoot ?? DEFAULT_OUT_ROOT;
  const currentAbs = resolve(cwd, options.currentDir);
  const baselineAbs = resolve(cwd, options.baselineDir);
  const blobsAbs = resolve(cwd, blobsDir(outRoot));
  mkdirSync(blobsAbs, { recursive: true });
  // The live harness preview URL per render key (from capture's renders.json sidecar), persisted on the
  // code variant so the Studio detail view can embed a live preview. Absent on seeded/pre-v2 runs → {}.
  const renderUrls = readRenderUrls(dirname(currentAbs));

  const touched = new Set<number>();
  // The keys touched this run (post-rename) — the keep set for the F3 removal pass.
  const touchedKeys = new Set<string>();
  // The variant lanes each component (re)rendered this cycle — scopes the status rollup to live lanes.
  const renderedLanes = new Map<number, Set<number | null>>();
  // The story states each component rendered this cycle — scopes the "Used in" usages the same way, so a
  // removed/renamed story doesn't leave a stale usage row (mirrors renderedLanes for the status rollup).
  const renderedStates = new Map<number, Set<string>>();
  const summary: SyncCodeSummary = {
    components: 0,
    currentSnapshots: 0,
    baselineSnapshots: 0,
    comparisons: 0,
    byStatus: { same: 0, changed: 0, regression: 0, new: 0, error: 0 },
    renames: 0,
    removed: 0,
  };

  // F2: code-rename pre-pass (FULL sync only). Detect renames BEFORE the per-render upserts create the new
  // keys, so an unambiguous rename re-points the OLD row onto the new key (keeping its id → snapshots,
  // variants, and the figma link survive) instead of orphaning it and re-creating a fresh row.
  if (options.fullSync) {
    const freshRefs: CodeKeyRef[] = [];
    const seenFresh = new Set<string>();
    for (const key of walkPngFiles(currentAbs)) {
      if (!isSafeKey(key)) continue;
      const parsed = parseCodeBaselineKey(key);
      if (parsed === null) continue;
      const ck = codeComponentKey(parsed.instance, parsed.name);
      if (!seenFresh.has(ck)) {
        seenFresh.add(ck);
        freshRefs.push({ key: ck, instance: parsed.instance, name: parsed.name });
      }
    }
    const priorRefs: CodeKeyRef[] = listComponents(db)
      .filter((c) => c.code_target !== null && c.code_instance !== null)
      .map((c) => ({ key: c.key, instance: c.code_instance ?? "", name: c.code_target ?? "" }));
    const diff = diffCodeMapping(priorRefs, freshRefs);
    for (const r of diff.renames) {
      const moved = applyCodeRename(db, r.fromKey, r.toKey);
      recordRenameEvent(db, {
        side: "code",
        componentId: getComponentByKey(db, moved ? r.toKey : r.fromKey)?.id ?? null,
        fromKey: r.fromKey,
        toKey: r.toKey,
        fromName: r.fromName,
        toName: r.toName,
        anchor: "code-instance",
        confidence: r.confidence,
        // `applied` when the re-point succeeded; if the new key somehow already existed (a real
        // collision), record it as merely `surfaced` — never silently merge two components.
        resolution: moved ? "applied" : "surfaced",
      });
      if (moved) summary.renames += 1;
    }
    for (const r of diff.fuzzyCandidates) {
      // Advisory cross-instance "moved" candidate — surfaced for review, NEVER auto-applied.
      recordRenameEvent(db, {
        side: "code",
        componentId: getComponentByKey(db, r.fromKey)?.id ?? null,
        fromKey: r.fromKey,
        toKey: r.toKey,
        fromName: r.fromName,
        toName: r.toName,
        anchor: "fuzzy",
        confidence: r.confidence,
        resolution: "surfaced",
      });
    }
  }

  for (const key of walkPngFiles(currentAbs)) {
    if (!isSafeKey(key)) {
      continue;
    }
    const parsed = parseCodeBaselineKey(key);
    if (parsed === null) {
      continue;
    }

    const componentKey = codeComponentKey(parsed.instance, parsed.name);
    const componentId = upsertComponent(db, {
      key: componentKey,
      name: parsed.name,
      codeInstance: parsed.instance,
      codeTarget: parsed.name,
    });
    touched.add(componentId);
    touchedKeys.add(componentKey);
    const variantId = upsertVariant(db, {
      componentId,
      source: "code",
      name: `${parsed.state}@${parsed.viewport}`,
      renderUrl: renderUrls[key] ?? null,
      // F4: the code side's axes for this story state (synthetic {Variant: state} without a config map),
      // for the advisory Figma↔code axis set-diff.
      propsJson: axesToJson(codeAxesFromState(parsed.state)),
    });
    let lanes = renderedLanes.get(componentId);
    if (lanes === undefined) {
      lanes = new Set();
      renderedLanes.set(componentId, lanes);
    }
    lanes.add(variantId);
    // Record where the component is used: each distinct rendered state is a story/example exercising it
    // (the detail "Used in" panel). Idempotent on (component, kind, used_in), so re-syncs don't duplicate.
    recordUsage(db, {
      componentId,
      kind: "story",
      usedIn: parsed.state,
      detail: parsed.instance,
    });
    let states = renderedStates.get(componentId);
    if (states === undefined) {
      states = new Set();
      renderedStates.set(componentId, states);
    }
    states.add(parsed.state);

    const currentBytes = readFileSync(join(currentAbs, key));
    const currentHash = sha256(currentBytes);
    const currentDims = readPngDimensions(currentBytes);
    // Content-address the transient live render into the blob cache (SPEC §7).
    const blobAbs = resolve(cwd, blobPath(currentHash, outRoot));
    if (!existsSync(blobAbs)) {
      copyFileSync(join(currentAbs, key), blobAbs);
    }
    const currentSnap = appendSnapshot(db, {
      componentId,
      variantId,
      source: "current",
      imagePath: toPosix(blobPath(currentHash, outRoot)),
      imageHash: currentHash,
      width: currentDims?.width ?? null,
      height: currentDims?.height ?? null,
      viewport: parsed.viewport,
      approved: false,
    });
    if (currentSnap.inserted) {
      summary.currentSnapshots += 1;
    }

    const baselineKeyAbs = join(baselineAbs, key);
    let status: RegressionStatus;
    let fromSnapshot = currentSnap.id; // self-ref for `new` (no baseline to point at)
    let diffRatio: number | null = null;
    let baselineInserted = false;
    if (existsSync(baselineKeyAbs)) {
      const baseBytes = readFileSync(baselineKeyAbs);
      const baseDims = readPngDimensions(baseBytes);
      const baseSnap = appendSnapshot(db, {
        componentId,
        variantId,
        source: "code",
        imagePath: `${toPosix(options.baselineDir)}/${key}`,
        imageHash: sha256(baseBytes),
        width: baseDims?.width ?? null,
        height: baseDims?.height ?? null,
        viewport: parsed.viewport,
        approved: true,
      });
      baselineInserted = baseSnap.inserted;
      if (baseSnap.inserted) {
        summary.baselineSnapshots += 1;
      }
      fromSnapshot = baseSnap.id;
      try {
        const diff = await diffImages(baseBytes, currentBytes, config.threshold);
        diffRatio = diff.ratio;
        status =
          classify(diff.ratio, diff.dimensionDelta, config.maxDiffRatio) === "fail"
            ? "regression"
            : diff.ratio > 0
              ? "changed" // below the gate but not byte-identical (SPEC §7 status map)
              : "same";
      } catch {
        status = "error"; // an undecodable render is reported, never aborts the sync
      }
    } else {
      status = "new";
    }
    // Record a comparison when a snapshot changed OR the verdict differs from the latest recorded one
    // (e.g. unchanged bytes but a tightened maxDiffRatio now reads regression). A fully-unchanged
    // re-run with an unchanged verdict adds NO new row — the prior verdict stands (true idempotency).
    const verdictChanged = latestLaneStatus(db, componentId, variantId) !== status;
    if (currentSnap.inserted || baselineInserted || verdictChanged) {
      recordComparison(db, {
        componentId,
        axis: "current_vs_baseline",
        fromSnapshot,
        toSnapshot: currentSnap.id,
        diffRatio,
        status,
      });
      summary.comparisons += 1;
      summary.byStatus[status] += 1;
    }
  }

  for (const id of touched) {
    recomputeStatus(db, id, renderedLanes.get(id));
    // Drop story usages for states no longer rendered (e.g. a renamed/removed story), keeping the panel
    // consistent with the live render — the usages analogue of recomputeStatus's renderedLanes scoping.
    pruneStoryUsages(db, id, [...(renderedStates.get(id) ?? [])]);
    // F3: a touched component is present this run — re-derive its lifecycle from presence, which also
    // resurrects one that had been soft-marked `removed` (it came back).
    rollupLifecycle(db, id);
    setSyncState(db, id, "synced");
  }
  // F3: orphan/removal pass — FULL sync only, AND only when at least one render landed. A code component
  // that exists in the DB but was NOT rendered this run has disappeared; soft-mark it `removed`
  // (reversible; the rollup above resurrects it if it returns). figma-only rows are never touched. A
  // partial `--target` run skips this (its fresh set is incomplete). The `touchedKeys.size > 0` guard is
  // load-bearing: a full sync that captured ZERO renders (e.g. a transient dev-server outage, or every
  // auto-generated story erroring under the tolerant managed-Ladle path → empty current/) is
  // indistinguishable from "the whole library vanished" — without this guard markRemovedCode([]) would
  // soft-mark EVERY component `removed` in one tick. Runs AFTER the per-component rollup (so a rename's
  // rebound row is in touchedKeys) and BEFORE markFigmaPending.
  if (options.fullSync && touchedKeys.size > 0) {
    summary.removed = markRemovedCode(db, [...touchedKeys]);
  }
  // A figma-linked component with no captured design is figma-pending (resumable) — SPEC §9.5. This
  // runs after the code sync so a code-only project (no figma links) stays fully `synced`.
  markFigmaPending(db);
  // F5: record one population point at the tail so the NEXT sync can diff "N new since last sync".
  if (options.fullSync) {
    recordPopulationSnapshot(db);
  }
  summary.components = touched.size;
  return summary;
}

// --- Incremental skip (P5) -------------------------------------------------

const WALK_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".visual-guard",
  ".visual-baselines",
  "dist",
  "build",
  "coverage",
  ".next",
]);

/**
 * Walk `cwd` collecting UI source files (posix-relative path + mtime) that match `uiGlobs` — the inputs
 * to the code-render fingerprint. Skips heavy/derived dirs. Dependency-free + Node-20 safe (no fs.glob).
 */
export function collectUiFiles(cwd: string, uiGlobs: string[]): FingerprintFile[] {
  const out: FingerprintFile[] = [];
  const walk = (dirAbs: string, prefix: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name)) {
          walk(join(dirAbs, entry.name), rel);
        }
      } else if (entry.isFile() && matchesAnyGlob(rel, uiGlobs)) {
        try {
          out.push({ path: rel, mtimeMs: statSync(join(dirAbs, entry.name)).mtimeMs });
        } catch {
          // a file vanished mid-walk — skip it
        }
      }
    }
  };
  walk(cwd, "");
  return out;
}

/** A stable signature of WHAT a code sync renders, so a config change busts the fingerprint. */
export function targetSignature(config: Config): string {
  return JSON.stringify({
    targets: config.targets,
    viewports: config.viewports,
    states: config.states,
  });
}

/** Read the stored fingerprint hash for the project, or null if none / unreadable. */
function readStoredFingerprint(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { fingerprint?: unknown };
    return typeof parsed.fingerprint === "string" ? parsed.fingerprint : null;
  } catch {
    return null;
  }
}

// --- CLI ------------------------------------------------------------------

export interface SyncCliArgs {
  config: string;
  target?: string;
  baselineDir?: string;
  outRoot: string;
  /** Re-render even when the fingerprint is unchanged (override the incremental skip). */
  force: boolean;
  /** Keep running, re-syncing whenever UI source changes (the incremental skip makes idle ticks cheap). */
  watch: boolean;
  /** Poll cadence for `--watch`, in milliseconds. */
  intervalMs: number;
}

/** Clamp a watch poll interval (seconds) to a sane range and return milliseconds (default 2s). */
export function clampWatchIntervalMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 2000;
  }
  return Math.min(3600, Math.max(1, Math.floor(seconds))) * 1000;
}

export function parseArgs(argv: string[]): SyncCliArgs {
  let config = "config/visual.config.json";
  let target: string | undefined;
  let baselineDir: string | undefined;
  let outRoot = DEFAULT_OUT_ROOT;
  let force = false;
  let watch = false;
  let intervalMs = 2000;

  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined) {
      fail(`missing value for ${flag}.`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--config":
        config = value(++i, "--config");
        break;
      case "--target":
        target = value(++i, "--target");
        break;
      case "--baseline":
        baselineDir = value(++i, "--baseline");
        break;
      case "--out":
        outRoot = value(++i, "--out");
        break;
      case "--force":
        force = true;
        break;
      case "--watch":
        watch = true;
        break;
      case "--interval": {
        const raw = value(++i, "--interval");
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          fail(`--interval must be a positive number of seconds (got ${JSON.stringify(raw)}).`);
        }
        intervalMs = clampWatchIntervalMs(n);
        break;
      }
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  return { config, target, baselineDir, outRoot, force, watch, intervalMs };
}

/**
 * Run ONE code sync (the body shared by the single-shot CLI and the `--watch` loop). Honors the
 * incremental skip — when nothing changed it returns `{ skipped: true }` BEFORE spinning a browser, which
 * is what makes a tight watch cadence cheap. `force` is OR-ed with the CLI flag so a watch loop can force
 * the first pass while letting subsequent ticks skip-when-unchanged.
 */
async function runSyncOnce(
  args: SyncCliArgs,
  config: Config,
  baselineDir: string,
  force: boolean,
): Promise<{ skipped: boolean }> {
  // Incremental skip (P5): when no UI source file changed and the target config is unchanged, the code
  // re-render is skipped entirely. Content-hash dedupe is the backstop, so this only saves cost, never
  // correctness. A `--target` subset or `--force` bypasses the skip (it fingerprints the whole project).
  const fingerprintPath = join(args.outRoot, "studio.fingerprint.json");
  const fingerprint = computeCodeFingerprint({
    targetSignature: targetSignature(config),
    files: collectUiFiles(process.cwd(), config.uiGlobs),
  });
  const plan = planSync(args.target, readStoredFingerprint(fingerprintPath), fingerprint, force);
  if (plan.skip) {
    console.log(JSON.stringify({ command: "sync", skipped: true, reason: "unchanged", fingerprint }));
    return { skipped: true };
  }

  // Code capture is the engine (headless). Figma capture is the agent-driven /visual-sync workflow.
  // A managed (VG-scaffolded) harness renders auto-generated stories that can error individually — be
  // tolerant so one bad story doesn't abort the sync (the origin is still probed up front by captureAll).
  const failFast = managedLadleTargets(config).length === 0;
  const capture = await captureAll(config, { target: args.target, outRoot: args.outRoot, failFast });

  mkdirSync(args.outRoot, { recursive: true });
  const db = openDb(studioDbPath(args.outRoot));
  try {
    const summary = await syncCodeFromRun({
      db,
      config,
      currentDir: capture.currentDir,
      baselineDir,
      outRoot: args.outRoot,
      // Rename (F2) + removal (F3) passes need the WHOLE fresh population; a `--target` subset must not run
      // them (it would falsely flag every untouched component). `plan.stamp` is exactly "this was a full
      // run" (false for a subset), so reuse it as the full-sync gate.
      fullSync: plan.stamp,
    });
    // Prune at the sync tail (idempotent; bounds history + blob-cache growth; never touches baselines).
    const pruned = pruneStudio(db, config.studio, { outRoot: args.outRoot });
    // Record the fingerprint so the next unchanged sync can skip — but ONLY for a FULL sync (plan.stamp
    // is false for a `--target` subset, which must not claim whole-project freshness).
    if (plan.stamp) {
      writeFileSync(fingerprintPath, JSON.stringify({ fingerprint, at: capture.runId }));
    }
    console.log(JSON.stringify({ command: "sync", runId: capture.runId, ...summary, pruned }));
    return { skipped: false };
  } finally {
    db.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  // Code capture renders via Playwright, which needs the pinned Chromium at
  // `${CLAUDE_PLUGIN_DATA}/browsers`. sync.ts is run STANDALONE (the /visual-sync workflow subagent, a
  // direct CLI call) where no caller sets PLAYWRIGHT_BROWSERS_PATH — resolve it so the sync finds the
  // pinned browser instead of Playwright's default cache ("browser not found").
  ensureBrowsersPath();
  const config = loadConfig(args.config);
  const baselineDir = args.baselineDir ?? config.baselineDir;

  if (!args.watch) {
    await runSyncOnce(args, config, baselineDir, args.force);
    return;
  }

  // Watch: re-sync whenever UI source changes. The fingerprint skip means an unchanged tick does almost
  // nothing (a cheap file walk, no browser), so a tight cadence is fine. The first pass honors --force;
  // every later tick relies on the skip to no-op until something actually changes. Runs until SIGINT.
  console.log(JSON.stringify({ command: "sync", watch: true, intervalMs: args.intervalMs }));
  let first = true;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runSyncOnce(args, config, baselineDir, first ? args.force : false);
    } catch (err) {
      // A transient capture failure (dev server momentarily down) must not kill the watcher.
      console.error(`[visual-sync] watch tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    first = false;
    await sleep(args.intervalMs);
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
