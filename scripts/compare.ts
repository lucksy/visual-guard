import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "./lib/config";
import { diffImages, type BoundingBox } from "./lib/diff";

/**
 * Diff orchestration (T-08): compare a run's captured renders under
 * `.visual-guard/runs/<id>/current/` against the committed baselines in `baselineDir`,
 * keyed by the shared instance-nested relative path. For each render it writes a
 * `diff/<key>.png` and a per-image result; a render with no baseline is reported as `new`
 * (not an error); a dimension change or a ratio over `maxDiffRatio` is flagged `fail`.
 *
 * Pure helpers (walkPngFiles, classify, parseArgs) are unit-tested; `compareRun` is covered
 * by an integration test over real PNG fixtures in a temp dir.
 */

const PREFIX = "Visual Guard compare";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const toPosix = (path: string): string => path.split(sep).join("/");

export type ComparisonStatus = "new" | "pass" | "fail" | "error";

export interface ImageComparison {
  /** Shared relative key: <instance>/<target>/<state>@<viewport>.png. */
  key: string;
  status: ComparisonStatus;
  /** null when `new` (no baseline to diff against) or `error`. */
  ratio: number | null;
  changedPixels: number | null;
  totalPixels: number | null;
  dimensionDelta: { width: number; height: number } | null;
  regions: BoundingBox[];
  /** Paths are relative (current/diff to the run dir, baseline to the configured baselineDir) so compare.json is portable. */
  baselinePath: string | null;
  currentPath: string;
  diffPath: string | null;
  /** Decode/IO failure message when status is `error`, else null. */
  error: string | null;
}

export interface CompareSummary {
  total: number;
  /** count of `new` (no-baseline) renders. */
  added: number;
  passed: number;
  failed: number;
  /** count of renders that could not be decoded/compared. */
  errored: number;
}

export interface CompareResult {
  runId: string;
  results: ImageComparison[];
  summary: CompareSummary;
}

/**
 * Recursively list `.png` files under `dir`, as sorted POSIX-style relative keys. Uses
 * `lstat` and skips symlinks, so a broken link can't crash the walk, a symlink cycle can't
 * cause infinite recursion, and a link can't make a key escape `dir` (every key is a real
 * descendant → `relative` never yields "..").
 */
export function walkPngFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue; // unreadable entry / race — skip rather than abort the run
      }
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && entry.endsWith(".png")) {
        found.push(toPosix(relative(dir, full)));
      }
    }
  };
  walk(dir);
  return found.sort();
}

/** Reject a key that could escape its directory when path-joined (defense in depth). */
export function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.startsWith("/") || key.includes("\0")) {
    return false;
  }
  return !key.split("/").includes("..");
}

/** A dimension change OR a ratio over the gate is a regression worth flagging. */
export function classify(
  ratio: number,
  dimensionDelta: { width: number; height: number } | null,
  maxDiffRatio: number,
): "pass" | "fail" {
  return dimensionDelta !== null || ratio > maxDiffRatio ? "fail" : "pass";
}

export interface CompareOptions {
  runId: string;
  /** Output root; defaults to ".visual-guard". */
  outRoot?: string;
  /** Baseline directory; defaults to `config.baselineDir`. */
  baselineDir?: string;
}

/** Compare a captured run against its baselines, writing diff PNGs + a `compare.json`. */
export async function compareRun(config: Config, options: CompareOptions): Promise<CompareResult> {
  const runDir = join(options.outRoot ?? ".visual-guard", "runs", options.runId);
  const currentDir = join(runDir, "current");
  const diffDir = join(runDir, "diff");
  const baselineDir = options.baselineDir ?? config.baselineDir;

  if (!existsSync(currentDir)) {
    fail(
      `no captured renders at ${currentDir} — run capture.ts for run ` +
        `${JSON.stringify(options.runId)} first.`,
    );
  }
  if (!statSync(currentDir).isDirectory()) {
    fail(`${currentDir} exists but is not a directory.`);
  }

  const results: ImageComparison[] = [];
  for (const key of walkPngFiles(currentDir)) {
    if (!isSafeKey(key)) {
      continue; // belt-and-suspenders: never path-join an escaping key
    }
    // Absolute paths for I/O; relative (portable) paths recorded in the result.
    const currentAbs = join(currentDir, key);
    const baselineAbs = join(baselineDir, key);
    const currentPath = `current/${key}`;
    const baselinePathRel = `${toPosix(baselineDir)}/${key}`;

    if (!existsSync(baselineAbs)) {
      results.push({
        key,
        status: "new",
        ratio: null,
        changedPixels: null,
        totalPixels: null,
        dimensionDelta: null,
        regions: [],
        baselinePath: null,
        currentPath,
        diffPath: null,
        error: null,
      });
      continue;
    }

    // A single undecodable render is reported (with context) and does not abort the run.
    let diff;
    try {
      diff = await diffImages(readFileSync(baselineAbs), readFileSync(currentAbs), config.threshold);
    } catch (err) {
      results.push({
        key,
        status: "error",
        ratio: null,
        changedPixels: null,
        totalPixels: null,
        dimensionDelta: null,
        regions: [],
        baselinePath: baselinePathRel,
        currentPath,
        diffPath: null,
        error: detailOf(err),
      });
      continue;
    }

    const diffAbs = join(diffDir, key);
    mkdirSync(dirname(diffAbs), { recursive: true });
    writeFileSync(diffAbs, diff.diffImage);

    results.push({
      key,
      status: classify(diff.ratio, diff.dimensionDelta, config.maxDiffRatio),
      ratio: diff.ratio,
      changedPixels: diff.changedPixels,
      totalPixels: diff.totalPixels,
      dimensionDelta: diff.dimensionDelta,
      regions: diff.regions,
      baselinePath: baselinePathRel,
      currentPath,
      diffPath: `diff/${key}`,
      error: null,
    });
  }

  const result: CompareResult = {
    runId: options.runId,
    results,
    summary: {
      total: results.length,
      added: results.filter((entry) => entry.status === "new").length,
      passed: results.filter((entry) => entry.status === "pass").length,
      failed: results.filter((entry) => entry.status === "fail").length,
      errored: results.filter((entry) => entry.status === "error").length,
    },
  };

  writeFileSync(join(runDir, "compare.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

// --- CLI ------------------------------------------------------------------

export interface CompareCliArgs {
  config: string;
  runId: string;
  baselineDir?: string;
}

export function parseArgs(argv: string[]): CompareCliArgs {
  let config = "config/visual.config.json";
  let runId: string | undefined;
  let baselineDir: string | undefined;

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
      case "--baseline":
        baselineDir = value(++i, "--baseline");
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  if (runId === undefined) {
    fail(`--run <id> is required.`);
  }
  return { config, runId, baselineDir };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig(args.config);
  const { summary } = await compareRun(config, {
    runId: args.runId,
    baselineDir: args.baselineDir,
  });
  console.log(
    `${PREFIX}: ${summary.total} image(s) — ${summary.passed} pass, ` +
      `${summary.failed} fail, ${summary.added} new, ${summary.errored} error`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
