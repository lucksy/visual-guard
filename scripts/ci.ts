import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { latestRunId } from "./baseline";
import type { ComparisonStatus } from "./compare";
import type { Manifest, ManifestTarget } from "./report";

/**
 * Non-interactive CI gate (T-21): turn a run's `manifest.json` into a pass/fail decision and a
 * process exit code, so a CI pipeline can fail on an **unapproved** regression.
 *
 * Why the engine owns the exit code (Decision D2): `claude -p` (headless) does NOT auto-exit
 * non-zero when a skill "fails" — the caller must inspect output, or the invoked process must set
 * its own exit. So the authoritative CI gate is this deterministic script: it exits `0` when the
 * run is clean and `1` when there are blocking targets. The `claude -p` path is an optional
 * wrapper; this is the source of truth.
 *
 * Gate policy (Decision D4): a `fail` (pixel/dimension regression) ALWAYS blocks. `new` (no
 * baseline = unapproved) and `error` (undecodable render) block by default — CI must be clean —
 * but are relaxable with `--allow-new` / `--allow-error` for a first-baseline bootstrap.
 *
 * Read-only under `.visual-guard/`: it captures nothing, approves no baseline, and sends nothing
 * to any external service. `evaluateGate` is pure and unit-tested.
 */

const PREFIX = "Visual Guard CI";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

/** Which non-`pass` target statuses cause a non-zero exit. */
export interface GatePolicy {
  /** Don't block on `new` (no-baseline / unapproved) targets. Default false (they block). */
  allowNew: boolean;
  /** Don't block on `error` (undecodable render) targets. Default false (they block). */
  allowError: boolean;
}

/** Target-level status counts (a target rolls up to its worst image status — see report.ts). */
export type StatusCounts = Record<ComparisonStatus, number>;

export interface GateResult {
  /** True when no target's status is a blocking status under the policy. */
  ok: boolean;
  /** Process exit code: 0 when `ok`, 1 otherwise. */
  exitCode: number;
  /** Target counts for the statuses that actually block under the policy. */
  blocking: { fail: number; new: number; error: number };
  /** All target counts by status (pass + every flagged status), for context. */
  counts: StatusCounts;
  /** The flagged targets that block, in manifest order. */
  blockingTargets: { instance: string; target: string; status: ComparisonStatus }[];
  /** A one-line human summary (printed by the CLI). */
  summaryLine: string;
}

/** Count manifest targets by their rolled-up status. */
export function countTargetsByStatus(targets: ManifestTarget[]): StatusCounts {
  const counts: StatusCounts = { pass: 0, new: 0, fail: 0, error: 0 };
  for (const target of targets) {
    counts[target.status]++;
  }
  return counts;
}

/**
 * Decide the CI gate from a manifest (pure). `fail` always blocks; `new`/`error` block unless the
 * policy allows them. Returns the decision + exit code + the blocking targets — never throws.
 */
export function evaluateGate(manifest: Manifest, policy: GatePolicy): GateResult {
  const counts = countTargetsByStatus(manifest.targets);

  // A manifest with zero targets means capture produced nothing (a truncated/corrupt manifest, or a
  // config that resolved no renders). The gate must NOT pass green on a run that verified nothing —
  // exit 2 ("could not run"), matching the missing-artifact path, rather than 0.
  if (manifest.targets.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      blocking: { fail: 0, new: 0, error: 0 },
      counts,
      blockingTargets: [],
      summaryLine: `${PREFIX}: manifest contains 0 targets — capture produced nothing; check config / target resolution.`,
    };
  }

  const blockingStatuses = new Set<ComparisonStatus>(["fail"]);
  if (!policy.allowNew) {
    blockingStatuses.add("new");
  }
  if (!policy.allowError) {
    blockingStatuses.add("error");
  }

  const blockingTargets = manifest.targets
    .filter((target) => blockingStatuses.has(target.status))
    .map((target) => ({
      instance: target.instance,
      target: target.target,
      status: target.status,
    }));

  const blocking = {
    fail: counts.fail,
    new: blockingStatuses.has("new") ? counts.new : 0,
    error: blockingStatuses.has("error") ? counts.error : 0,
  };

  const ok = blockingTargets.length === 0;
  // Note when new/error are present but allowed, so a passing gate still explains what it ignored.
  const allowedNotes: string[] = [];
  if (policy.allowNew && counts.new > 0) {
    allowedNotes.push(`${counts.new} new allowed`);
  }
  if (policy.allowError && counts.error > 0) {
    allowedNotes.push(`${counts.error} error allowed`);
  }
  const suffix = allowedNotes.length > 0 ? ` (${allowedNotes.join(", ")})` : "";
  const summaryLine =
    `${PREFIX}: ${manifest.targets.length} target(s) — ${counts.fail} fail, ${counts.new} new, ` +
    `${counts.error} error, ${counts.pass} pass → ${ok ? "clean" : "BLOCKED"}${suffix}`;

  return { ok, exitCode: ok ? 0 : 1, blocking, counts, blockingTargets, summaryLine };
}

export interface GateOptions {
  /** Run id; defaults to the latest run that has a `current/` dir. */
  runId?: string;
  /** Output root; defaults to ".visual-guard". */
  outRoot?: string;
  policy: GatePolicy;
}

export interface RunGateResult extends GateResult {
  runId: string;
  /** Project-root-relative path to the manifest the gate read. */
  manifestPath: string;
}

/**
 * Resolve a run's `manifest.json` and evaluate the gate. Reads only — no capture, no baseline
 * write. Throws an actionable error if there is no run or no manifest yet (so CI fails loudly
 * rather than silently passing on a missing artifact).
 */
export function runGate(options: GateOptions): RunGateResult {
  const outRoot = options.outRoot ?? ".visual-guard";
  const runsDir = join(outRoot, "runs");
  const runId =
    options.runId ??
    latestRunId(runsDir) ??
    fail(`no runs under ${runsDir} — run /visual-check (or capture→compare→report) first.`);

  const manifestPath = join(runsDir, runId, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`no manifest.json at ${manifestPath} — run report.ts for run ${JSON.stringify(runId)} first.`);
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch (err) {
    return fail(
      `manifest.json at ${manifestPath} is not valid JSON ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  return { ...evaluateGate(manifest, options.policy), runId, manifestPath };
}

// --- CLI ------------------------------------------------------------------

export interface CiCliArgs {
  runId?: string;
  outRoot?: string;
  allowNew: boolean;
  allowError: boolean;
  json: boolean;
}

export function parseArgs(argv: string[]): CiCliArgs {
  let runId: string | undefined;
  let outRoot: string | undefined;
  let allowNew = false;
  let allowError = false;
  let json = false;

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
      case "--run":
        runId = value(++i, "--run");
        break;
      case "--out":
        outRoot = value(++i, "--out");
        break;
      case "--allow-new":
        allowNew = true;
        break;
      case "--allow-error":
        allowError = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  return { runId, outRoot, allowNew, allowError, json };
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const result = runGate({
    runId: args.runId,
    outRoot: args.outRoot,
    policy: { allowNew: args.allowNew, allowError: args.allowError },
  });

  if (args.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.summaryLine);
    for (const target of result.blockingTargets) {
      console.log(`  - ${target.instance}/${target.target} — ${target.status}`);
    }
  }
  // The whole point of the gate: a non-zero exit so CI fails on an unapproved regression.
  process.exit(result.exitCode);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2); // 2 = the gate could not run (missing/invalid artifact), distinct from 1 = blocked.
  }
}
