import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeRunId } from "./capture";

/**
 * `/visual-check` step-2 orchestrator — ONE statically-analyzable command in place of the inline
 * shell that the command body used to carry (a `trap … EXIT`, `$(date)`/`node -e` command
 * substitutions, and `set --`/`if` branching — all of which Claude Code's permission engine cannot
 * statically analyze, so every run prompted repeatedly). The orchestration now lives here in TS:
 *
 *   - managed harness lifecycle via `try/finally` (replaces `trap … EXIT` — the harness is ALWAYS
 *     stopped, even when capture throws),
 *   - run-id generation via {@link makeRunId} (replaces `RUN_ID="$(date …)"`),
 *   - scope-mode + config parsing via `fs` + `JSON.parse` (replaces the two `node -e` substitutions),
 *   - capture-arg assembly in TS (replaces the `set --`/`if` positional-param dance).
 *
 * It spawns the SAME engine scripts the shell did, with explicit argv arrays (no shell, no injection),
 * preserving their tested behavior exactly. The machine result is written to
 * `.visual-guard/last-check.json` (a fixed path) for the command to `Read` — run id, scope mode, and
 * the manifest path it then walks in steps 3–4.
 *
 * Pure-ish + testable: {@link runCheck} takes an injectable step `run`, a fixed `runId`, and `env`, so
 * the orchestration (sequence, branching, finally-stop) is unit-tested without spawning anything.
 */

// Self-locate: this file is <pluginRoot>/scripts/check.ts, so the engine scripts sit beside it and the
// bundled `tsx` runner is at <pluginRoot>/node_modules/.bin/tsx (a real dir in dev, the bridge symlink
// in an installed plugin). Derived from the module URL, not an env var, so it is correct everywhere.
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(SCRIPTS_DIR);
const RUNNER = join(PLUGIN_ROOT, "node_modules", ".bin", "tsx");

export interface CheckArgs {
  config: string;
  cwd: string;
  /** Explicit component target — captured directly, never change-scoped. */
  target?: string;
  /** Full sweep (the CI source of truth). */
  all: boolean;
  /** Scope the change against this git base instead of HEAD. */
  since?: string;
  /** Opt in to capture fingerprint-skip (copy baseline forward when inputs are byte-identical). */
  skipUnchanged: boolean;
}

export type CheckMode = "explicit" | "scoped" | "all" | "none";

export interface CheckResult {
  runId: string;
  mode: CheckMode;
  /** Set once capture/compare/report ran — false for an early `none` exit. */
  ranCapture: boolean;
  /** Project-relative manifest path (steps 3–4 read it); absent when nothing was captured. */
  manifestPath?: string;
  /** A non-fatal failure that stopped the run after the harness was cleaned up. */
  error?: string;
}

/** One engine step: returns the child's exit code. Injectable so tests never spawn. */
export type StepRunner = (
  label: string,
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => number;

/** Default runner: stream the child's output (so progress/errors reach the user) and return its code. */
const defaultRun: StepRunner = (label, command, args, opts) => {
  process.stderr.write(`[visual-guard] ${label}\n`);
  const result = spawnSync(command, args, { cwd: opts.cwd, env: opts.env, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1; // null status (signal/abnormal) is a failure
};

export function parseCheckArgs(argv: string[]): CheckArgs {
  const args: CheckArgs = { config: "", cwd: process.cwd(), all: false, skipUnchanged: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error(`visual-check: missing value for ${flag}`);
      }
      return next;
    };
    switch (flag) {
      case "--config":
        args.config = value();
        break;
      case "--cwd":
        args.cwd = value();
        break;
      case "--target":
        args.target = value();
        break;
      case "--all":
        args.all = true;
        break;
      case "--since":
        args.since = value();
        break;
      case "--skip-unchanged":
        args.skipUnchanged = true;
        break;
      default:
        throw new Error(`visual-check: unknown argument ${flag}`);
    }
  }
  if (!args.config) {
    throw new Error("visual-check: --config is required");
  }
  return args;
}

/** Read `scope.json`'s `mode`, defaulting to `"all"` on any error — scope.ts NEVER fails the run. */
function readScopeMode(scopeFile: string): Exclude<CheckMode, "explicit"> {
  try {
    const mode = JSON.parse(readFileSync(scopeFile, "utf8")).mode;
    if (mode === "scoped" || mode === "none" || mode === "all") {
      return mode;
    }
  } catch {
    /* missing / unparseable → full sweep */
  }
  return "all";
}

/** Read `scope.fingerprintSkip === true` from the config, defaulting to false on any error. */
function readConfigFingerprintSkip(configPath: string): boolean {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")).scope?.fingerprintSkip === true;
  } catch {
    return false;
  }
}

/**
 * Run the capture → compare → report pipeline for one `/visual-check`, managing the (optional) managed
 * harness around it. Returns the machine result; never throws for an expected engine failure (it
 * records `error` and returns) so the caller can always write the result file and stop the harness.
 */
export function runCheck(
  args: CheckArgs,
  deps: { run?: StepRunner; runId?: string; env?: NodeJS.ProcessEnv } = {},
): CheckResult {
  const run = deps.run ?? defaultRun;
  const runId = deps.runId ?? makeRunId(new Date());
  const env = { ...(deps.env ?? process.env) };
  // Chromium must resolve to the same path at install and capture time (the installer's contract).
  if (env.CLAUDE_PLUGIN_DATA) {
    env.PLAYWRIGHT_BROWSERS_PATH = join(env.CLAUDE_PLUGIN_DATA, "browsers");
  }

  const tsx = (label: string, scriptRel: string, scriptArgs: string[]): number =>
    run(label, RUNNER, [join(SCRIPTS_DIR, scriptRel), ...scriptArgs], { cwd: args.cwd, env });

  const scopeFile = join(args.cwd, ".visual-guard", "scope.json");
  const fpFile = join(args.cwd, ".visual-guard", "fingerprints-current.json");

  let managedStarted = false;
  try {
    // Boot a VG-scaffolded harness if the config has one; a no-op (exit 0) for a server you run
    // yourself. ALWAYS stopped in `finally` — the try/finally is what replaces the shell `trap`.
    if (tsx("Starting managed harness (no-op if none)…", "managed-serve.ts", [
      "start",
      "--config",
      args.config,
      "--cwd",
      args.cwd,
    ]) !== 0) {
      return { runId, mode: "all", ranCapture: false, error: "managed harness failed to start" };
    }
    managedStarted = true;

    let mode: CheckMode;
    const captureArgs: string[] = [];

    if (args.target) {
      // Explicit component → captured directly, never change-scoped.
      mode = "explicit";
      captureArgs.push("--target", args.target);
    } else {
      // Never read a stale scope decision OR stale fingerprints from a prior run.
      rmSync(scopeFile, { force: true });
      rmSync(fpFile, { force: true });
      const scopeArgs = ["--config", args.config, "--cwd", args.cwd];
      if (args.all) {
        scopeArgs.push("--all");
      }
      if (args.since) {
        scopeArgs.push("--since", args.since);
      }
      // scope.ts writes scope.json + prints its summary (streamed to the user). It NEVER fails the
      // run; on ANY uncertainty it writes mode "all", so its exit code is intentionally ignored.
      tsx("Resolving scope (read-only — inspects git + config)…", "scope.ts", scopeArgs);
      mode = readScopeMode(scopeFile);
      if (mode === "none") {
        return { runId, mode, ranCapture: false };
      }
      if (mode === "scoped") {
        captureArgs.push("--scope-file", scopeFile);
      }
      // ALWAYS hand capture the scope-emitted fingerprints (so /visual-baseline can record the
      // approved fp↔PNG pairing for FUTURE skips), but only ENABLE skipping when opted in.
      if (existsSync(fpFile)) {
        captureArgs.push("--fingerprints", fpFile);
      }
      if (args.skipUnchanged || (mode === "scoped" && readConfigFingerprintSkip(args.config))) {
        captureArgs.push("--skip-unchanged");
      }
    }

    if (tsx("Capturing…", "capture.ts", ["--config", args.config, "--run", runId, ...captureArgs]) !== 0) {
      return { runId, mode, ranCapture: false, error: "capture failed" };
    }
    if (tsx("Comparing against baseline…", "compare.ts", ["--config", args.config, "--run", runId]) !== 0) {
      return { runId, mode, ranCapture: false, error: "compare failed" };
    }
    if (tsx("Building report…", "report.ts", ["--config", args.config, "--run", runId]) !== 0) {
      return { runId, mode, ranCapture: false, error: "report failed" };
    }

    // Checkpoint complete — clear the pending-review markers (a .mjs run under node, never fails the run).
    run("Clearing pending-review markers…", process.execPath, [join(SCRIPTS_DIR, "detect-ui-change.mjs"), "--clear"], {
      cwd: args.cwd,
      env,
    });

    return { runId, mode, ranCapture: true, manifestPath: join(".visual-guard", "runs", runId, "manifest.json") };
  } finally {
    if (managedStarted) {
      // No-op for a non-managed target; never let a stop failure mask the real result.
      try {
        run("Stopping managed harness…", RUNNER, [join(SCRIPTS_DIR, "managed-serve.ts"), "stop", "--config", args.config, "--cwd", args.cwd], {
          cwd: args.cwd,
          env,
        });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

async function main(argv: string[]): Promise<void> {
  const args = parseCheckArgs(argv);
  const result = runCheck(args);
  // Persist the machine result at a FIXED path so the command can Read it without knowing the run id.
  const outDir = join(args.cwd, ".visual-guard");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "last-check.json"), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result) + "\n");
  // A recorded engine failure is a non-zero exit so the agent stops and relays the streamed error.
  process.exitCode = result.error ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[visual-guard] visual-check failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
