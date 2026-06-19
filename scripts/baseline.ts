import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "./lib/config";
import {
  FINGERPRINTS_VERSION,
  type FingerprintEntry,
  type FingerprintsFile,
} from "./lib/fingerprint-file";
import { isSafeKey, walkPngFiles } from "./compare";

/**
 * Baseline sign-off (T-11): copy a run's captured renders under
 * `.visual-guard/runs/<id>/current/` into the committed `baselineDir`, keyed by the shared
 * instance-nested path. This is the deliberate human/agent approval of "this is how it should
 * look", so it is invoked only by the `/visual-baseline` command (never automatically), it
 * skips existing baselines unless `--overwrite`, and it HARD-refuses to write anywhere outside
 * `baselineDir`.
 *
 * Pure-ish helpers (latestRunId, planBaseline, applyBaseline) are unit-tested.
 */

const PREFIX = "Visual Guard baseline";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const toPosix = (path: string): string => path.split(sep).join("/");

export interface BaselineCopy {
  /** Shared relative key: <instance>/<target>/<state>@<viewport>.png. */
  key: string;
  fromAbs: string;
  toAbs: string;
  /** baselineDir/<key>, POSIX — for portable display. */
  toRel: string;
  /** A baseline already exists at this key (would be overwritten). */
  existed: boolean;
}

/**
 * The most recent run id under `runsDir` that actually has a `current/` directory (timestamps
 * sort lexically), or null if none — so a half-written / aborted run is never auto-selected.
 */
export function latestRunId(runsDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return null;
  }
  const runs = entries.filter((entry) => {
    try {
      return (
        statSync(join(runsDir, entry)).isDirectory() &&
        existsSync(join(runsDir, entry, "current"))
      );
    } catch {
      return false;
    }
  });
  if (runs.length === 0) {
    return null;
  }
  runs.sort();
  return runs[runs.length - 1] ?? null;
}

function keyMatchesTarget(key: string, filter: string): boolean {
  const parts = key.split("/");
  const instance = parts[0] ?? "";
  const target = parts[1] ?? "";
  const wanted = filter.toLowerCase();
  return (
    target.toLowerCase() === wanted ||
    instance.toLowerCase() === wanted ||
    `${instance}/${target}`.toLowerCase() === wanted
  );
}

/**
 * Plan which current renders would become baselines (reads only — writes nothing). Keys come
 * from `walkPngFiles` (`<instance>/<target>/<state>@<viewport>.png`) and are re-checked with
 * `isSafeKey` as defense in depth before they are ever path-joined.
 */
export function planBaseline(
  currentDir: string,
  baselineDir: string,
  targetFilter?: string,
): BaselineCopy[] {
  const keys = walkPngFiles(currentDir).filter(
    (key) =>
      isSafeKey(key) && (targetFilter === undefined || keyMatchesTarget(key, targetFilter)),
  );
  return keys.map((key) => {
    const toAbs = join(baselineDir, key);
    return {
      key,
      fromAbs: join(currentDir, key),
      toAbs,
      toRel: toPosix(join(baselineDir, key)),
      existed: existsSync(toAbs),
    };
  });
}

/** Hard guard: a destination must resolve inside the baseline dir, never outside it. */
function assertUnder(childAbs: string, parentAbs: string): void {
  const child = resolve(childAbs);
  const parent = resolve(parentAbs);
  if (child !== parent && !child.startsWith(parent + sep)) {
    fail(`refusing to write ${childAbs} outside the baseline dir ${parentAbs}.`);
  }
}

export interface ApplyResult {
  written: string[];
  skipped: string[];
  /** Renders whose copy failed (e.g. the source vanished) — the rest still succeed. */
  failed: { key: string; reason: string }[];
}

/**
 * Copy planned renders into the baseline dir. The skip/overwrite decision is made against the
 * **live** filesystem (not the possibly-stale plan), every destination is hard-guarded to stay
 * inside `baselineDir`, and a single failed copy is recorded without aborting the others.
 */
export function applyBaseline(
  copies: BaselineCopy[],
  baselineDir: string,
  options: { overwrite: boolean },
): ApplyResult {
  const written: string[] = [];
  const skipped: string[] = [];
  const failed: { key: string; reason: string }[] = [];
  for (const copy of copies) {
    // Re-check existence now, so a baseline created since the plan isn't silently clobbered.
    if (existsSync(copy.toAbs) && !options.overwrite) {
      skipped.push(copy.key);
      continue;
    }
    // Security boundary — must hard-fail, never be swallowed into `failed`.
    assertUnder(copy.toAbs, baselineDir);
    try {
      mkdirSync(dirname(copy.toAbs), { recursive: true });
      copyFileSync(copy.fromAbs, copy.toAbs);
      written.push(copy.key);
    } catch (err) {
      failed.push({ key: copy.key, reason: detailOf(err) });
    }
  }
  return { written, skipped, failed };
}

export interface BaselineOptions {
  runId?: string;
  target?: string;
  outRoot?: string;
  baselineDir?: string;
  overwrite?: boolean;
  /** Required alongside `overwrite` to actually replace existing baselines (the safety gate). */
  confirmed?: boolean;
  dryRun?: boolean;
}

export interface BaselineResult {
  runId: string;
  baselineDir: string;
  planned: BaselineCopy[];
  written: string[];
  skipped: string[];
  failed: { key: string; reason: string }[];
  dryRun: boolean;
}

/** sha1 hex of a file's bytes (the baseline PNG tamper-evidence stored alongside the approved fp). */
function sha1Bytes(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex");
}

/** Read a `fingerprints.json` into a `{ key: FingerprintEntry }` map; `{}` on any error/version mismatch. */
function readFingerprintsFile(path: string): Record<string, FingerprintEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FingerprintsFile>;
    if (
      parsed.version !== FINGERPRINTS_VERSION ||
      typeof parsed.renders !== "object" ||
      parsed.renders === null
    ) {
      return {};
    }
    const out: Record<string, FingerprintEntry> = {};
    for (const [key, entry] of Object.entries(parsed.renders)) {
      if (entry !== null && typeof entry === "object" && typeof entry.fp === "string") {
        out[key] = { fp: entry.fp, ...(typeof entry.png === "string" ? { png: entry.png } : {}) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Record the APPROVED fingerprints for the just-approved renders into the committed
 * `baselineDir/fingerprints.json` (capture fingerprint-skip). For each WRITTEN key we pair the run's
 * CURRENT input fingerprint (capture persisted it run-scoped, so it provably matches the PNG we just
 * copied) with that baseline PNG's own sha1 (tamper-evidence). The merge is partial-approval-safe and:
 *   - a written key with NO run fingerprint (it wasn't fingerprintable at capture) DROPS any stale
 *     approved entry → it can never be skip-eligible;
 *   - entries whose baseline PNG no longer exists are pruned.
 * Best-effort: a failure here never fails the (already-completed) baseline copy — it just means those
 * renders aren't skip-eligible (the safe direction).
 */
export function recordApprovedFingerprints(
  runDir: string,
  baselineDir: string,
  writtenKeys: string[],
): void {
  try {
    // No run fingerprints at all (an explicit `--target` run, or a legacy run captured before
    // fingerprints existed) → leave the committed approved file UNTOUCHED. Those renders just aren't
    // re-fingerprinted here; dropping existing approved fps would needlessly lose skip-eligibility.
    const runFpsPath = join(runDir, "fingerprints.json");
    if (!existsSync(runFpsPath)) return;
    const runFps = readFingerprintsFile(runFpsPath);
    const approvedPath = join(baselineDir, "fingerprints.json");
    const approved = readFingerprintsFile(approvedPath);

    for (const key of writtenKeys) {
      if (!isSafeKey(key)) continue;
      const current = runFps[key];
      if (current === undefined) {
        delete approved[key]; // not fingerprintable at capture → never skip-eligible
        continue;
      }
      let png: string;
      try {
        png = sha1Bytes(readFileSync(join(baselineDir, key)));
      } catch {
        delete approved[key]; // can't hash the just-copied baseline → not skip-eligible
        continue;
      }
      approved[key] = { fp: current.fp, png };
    }

    // Prune entries whose baseline PNG is gone (a deleted/renamed baseline must never be skipped to).
    for (const key of Object.keys(approved)) {
      if (!isSafeKey(key) || !existsSync(join(baselineDir, key))) {
        delete approved[key];
      }
    }

    const file: FingerprintsFile = { version: FINGERPRINTS_VERSION, renders: approved };
    mkdirSync(dirname(approvedPath), { recursive: true });
    writeFileSync(approvedPath, `${JSON.stringify(file, null, 2)}\n`);
  } catch {
    /* best-effort: never fail an approval over fingerprint bookkeeping */
  }
}

/** Resolve the run, plan the copies, and (unless dryRun) approve them into the baseline dir. */
export function runBaseline(config: Config, options: BaselineOptions = {}): BaselineResult {
  const outRoot = options.outRoot ?? ".visual-guard";
  const runsDir = join(outRoot, "runs");
  const runId =
    options.runId ??
    latestRunId(runsDir) ??
    fail(`no runs under ${runsDir} — run /visual-check first to capture renders to approve.`);

  const currentDir = join(runsDir, runId, "current");
  if (!existsSync(currentDir)) {
    fail(`no captured renders at ${currentDir} for run ${JSON.stringify(runId)}.`);
  }

  const baselineDir = options.baselineDir ?? config.baselineDir;
  const planned = planBaseline(currentDir, baselineDir, options.target);
  if (planned.length === 0) {
    fail(
      options.target === undefined
        ? `no renders in ${currentDir} to approve.`
        : `no renders matched ${JSON.stringify(options.target)} in run ${runId}.`,
    );
  }

  if (options.dryRun) {
    return { runId, baselineDir, planned, written: [], skipped: [], failed: [], dryRun: true };
  }

  // Overwriting committed baselines is the only destructive path — it requires explicit
  // confirmation (the /visual-baseline command obtains it, then passes --confirmed). Creating
  // new baselines for never-seen renders is the normal sign-off and needs no gate here.
  const overwrite = options.overwrite ?? false;
  const existingCount = planned.filter((copy) => copy.existed).length;
  if (overwrite && existingCount > 0 && options.confirmed !== true) {
    fail(
      `this would overwrite ${existingCount} existing baseline(s) — confirmation required. ` +
        `The /visual-baseline command confirms with you, then passes --confirmed.`,
    );
  }

  const { written, skipped, failed } = applyBaseline(planned, baselineDir, { overwrite });
  // Record the approved input fingerprints for the renders just written (capture fingerprint-skip).
  // Run-scoped source so each approved fp provably pairs with the PNG it approved.
  recordApprovedFingerprints(join(runsDir, runId), baselineDir, written);
  return { runId, baselineDir, planned, written, skipped, failed, dryRun: false };
}

// --- CLI ------------------------------------------------------------------

export interface BaselineCliArgs {
  config: string;
  runId?: string;
  target?: string;
  overwrite: boolean;
  confirmed: boolean;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): BaselineCliArgs {
  let config = "config/visual.config.json";
  let runId: string | undefined;
  let target: string | undefined;
  let overwrite = false;
  let confirmed = false;
  let dryRun = false;

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
      case "--run":
        runId = value(++i, "--run");
        break;
      case "--target":
        target = value(++i, "--target");
        break;
      case "--overwrite":
        overwrite = true;
        break;
      case "--confirmed":
        confirmed = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  return { config, runId, target, overwrite, confirmed, dryRun };
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const config = loadConfig(args.config);
  const result = runBaseline(config, {
    runId: args.runId,
    target: args.target,
    overwrite: args.overwrite,
    confirmed: args.confirmed,
    dryRun: args.dryRun,
  });
  // Machine-readable so the /visual-baseline command can preview the plan and confirm overwrites.
  console.log(JSON.stringify(result));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
