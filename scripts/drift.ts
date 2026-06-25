import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "./lib/studio/db";
import { computeDrift, type DriftReport } from "./lib/studio/store";
import { studioDbPath, DEFAULT_OUT_ROOT } from "./lib/studio/keys";

/**
 * `/visual-drift` orchestrator — ONE statically-analyzable command body (the permission engine can vet a
 * single static-arg `tsx scripts/drift.ts` invocation). Prints the aggregate ADVISORY drift report
 * (new-since-last-sync, removed, stale, renamed, presence) from the gitignored studio DB and writes
 * `.visual-guard/last-drift.json` for the command to Read.
 *
 * ADVISORY ONLY: drift is informational maintenance signal — `computeDrift` reads no `components.status`,
 * makes zero external calls, and this orchestrator ALWAYS exits 0 (it never gates CI, mirroring the
 * figma_vs_code-never-gates invariant). Output is plain ASCII (no emoji).
 *
 * Pure + testable: {@link formatDriftReport} (the rendering) and {@link parseDriftArgs} are unit-tested;
 * only `main` touches the DB/filesystem.
 */

export interface DriftArgs {
  cwd: string;
  outRoot: string;
}

export function parseDriftArgs(argv: string[]): DriftArgs {
  const args: DriftArgs = { cwd: process.cwd(), outRoot: DEFAULT_OUT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error(`visual-drift: missing value for ${flag}`);
      }
      return next;
    };
    switch (flag) {
      case "--cwd":
        args.cwd = value();
        break;
      case "--out":
        args.outRoot = value();
        break;
      // --config is accepted (commands pass it uniformly) but unused: the studio DB path is fixed.
      case "--config":
        value();
        break;
      default:
        throw new Error(`visual-drift: unknown argument ${flag}`);
    }
  }
  return args;
}

/** Render an emoji-free, plain-ASCII drift summary from a {@link DriftReport}. Pure + unit-tested. */
export function formatDriftReport(drift: DriftReport): string {
  const lines: string[] = [];
  lines.push("Visual Guard drift report (advisory - never gates CI)");
  lines.push(
    `  presence: ${drift.matched} matched, ${drift.figmaOnly} figma-only, ${drift.codeOnly} code-only`,
  );
  lines.push(
    `  new since last sync: figma +${drift.delta.newFigma.length}, code +${drift.delta.newCode.length}`,
  );
  lines.push(
    `  removed: ${drift.removed.length}, stale mappings: ${drift.stale.length}, renames on record: ${drift.renamed}`,
  );
  if (drift.delta.newFigma.length > 0) lines.push(`  new figma: ${drift.delta.newFigma.join(", ")}`);
  if (drift.delta.newCode.length > 0) lines.push(`  new code: ${drift.delta.newCode.join(", ")}`);
  if (drift.removed.length > 0) lines.push(`  removed: ${drift.removed.join(", ")}`);
  if (drift.stale.length > 0) lines.push(`  stale: ${drift.stale.join(", ")}`);
  const nothing =
    drift.removed.length === 0 &&
    drift.stale.length === 0 &&
    drift.delta.newFigma.length === 0 &&
    drift.delta.newCode.length === 0;
  if (nothing) {
    lines.push("  no rename/removal/staleness/new-component drift detected.");
  }
  return lines.join("\n");
}

export interface DriftRunResult {
  /** False when there is no studio index yet (advisory, not an error). */
  available: boolean;
  /** The plain-text report printed to stdout. */
  text: string;
  /** The structured report, when an index exists. */
  report?: DriftReport;
}

/**
 * Open the studio index (read-only), compute the drift report, write `.visual-guard/last-drift.json`,
 * and return the rendered text + structured report. NEVER throws for a missing index (returns
 * `available:false`). Exported so the orchestration is unit-tested in-process without spawning.
 */
export function runDrift(args: DriftArgs): DriftRunResult {
  const dbAbs = join(args.cwd, studioDbPath(args.outRoot));
  const outDir = join(args.cwd, ".visual-guard");
  mkdirSync(outDir, { recursive: true });

  if (!existsSync(dbAbs)) {
    const text = `Visual Guard drift: no studio index at ${studioDbPath(args.outRoot)} - run /visual-sync or studio.ts reindex first.`;
    writeFileSync(
      join(outDir, "last-drift.json"),
      JSON.stringify({ command: "drift", available: false, message: text }, null, 2) + "\n",
    );
    return { available: false, text };
  }

  const db = openDb(dbAbs);
  try {
    const report = computeDrift(db);
    const text = formatDriftReport(report);
    writeFileSync(
      join(outDir, "last-drift.json"),
      JSON.stringify({ command: "drift", available: true, ...report }, null, 2) + "\n",
    );
    return { available: true, text, report };
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const result = runDrift(parseDriftArgs(argv));
  process.stdout.write(result.text + "\n");
  // Advisory: ALWAYS succeed. Drift is a maintenance signal, never a gate.
  process.exitCode = 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    // Even an unexpected failure must not gate — report to stderr and still exit 0.
    process.stderr.write(
      `[visual-guard] visual-drift: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 0;
  });
}
