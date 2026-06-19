import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeRunId } from "./capture";

/**
 * `/visual-ci` orchestrator — ONE statically-analyzable command for the interactive gate flow
 * (capture → compare → report → CI gate → PR-comment markdown), replacing the inline shell that used
 * `RUN_ID="$(date …)"`, `export`, `${TARGET:+…}`, and `echo "gate exit: $?"`.
 *
 * It records the gate's exit code (0 clean / 1 unapproved regressions / 2 could-not-run) in the result
 * but does NOT adopt it as ITS OWN exit — the authoritative CI gate is the DIRECT `ci.ts` call in the
 * command's "CI recipe" (§5), which is what fails the pipeline. Here the agent reads the verdict from
 * `.visual-guard/last-ci.json` and presents it.
 *
 * Pure-ish + testable: {@link runCi} takes an injectable step `run`, a fixed `runId`, and `env`.
 */

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(SCRIPTS_DIR);
const RUNNER = join(PLUGIN_ROOT, "node_modules", ".bin", "tsx");

export interface CiArgs {
  config: string;
  cwd: string;
  target?: string;
  /** Relax the gate: don't block on `new` (no-baseline) targets. */
  allowNew: boolean;
  /** Relax the gate: don't block on `error` (undecodable) targets. */
  allowError: boolean;
}

export type StepRunner = (
  label: string,
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => number;

const defaultRun: StepRunner = (label, command, args, opts) => {
  process.stderr.write(`[visual-guard] ${label}\n`);
  const result = spawnSync(command, args, { cwd: opts.cwd, env: opts.env, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
};

export function parseCiArgs(argv: string[]): CiArgs {
  const args: CiArgs = { config: "", cwd: process.cwd(), allowNew: false, allowError: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error(`visual-ci: missing value for ${flag}`);
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
      case "--allow-new":
        args.allowNew = true;
        break;
      case "--allow-error":
        args.allowError = true;
        break;
      default:
        throw new Error(`visual-ci: unknown argument ${flag}`);
    }
  }
  if (!args.config) {
    throw new Error("visual-ci: --config is required");
  }
  return args;
}

export interface CiResult {
  runId: string;
  /** True once capture/compare/report succeeded and the gate ran. */
  ranGate: boolean;
  /** ci.ts exit: 0 clean · 1 unapproved regressions · 2 could-not-run. */
  gateExit?: number;
  manifestPath?: string;
  prCommentPath?: string;
  /** A hard failure (capture/compare/report) that stopped the run before the gate. */
  error?: string;
}

export function runCi(
  args: CiArgs,
  deps: { run?: StepRunner; runId?: string; env?: NodeJS.ProcessEnv } = {},
): CiResult {
  const run = deps.run ?? defaultRun;
  const runId = deps.runId ?? makeRunId(new Date());
  const env = { ...(deps.env ?? process.env) };
  if (env.CLAUDE_PLUGIN_DATA) {
    env.PLAYWRIGHT_BROWSERS_PATH = join(env.CLAUDE_PLUGIN_DATA, "browsers");
  }
  const tsx = (label: string, scriptRel: string, scriptArgs: string[]): number =>
    run(label, RUNNER, [join(SCRIPTS_DIR, scriptRel), ...scriptArgs], { cwd: args.cwd, env });

  const captureArgs = ["--config", args.config, "--run", runId];
  if (args.target) {
    captureArgs.push("--target", args.target);
  }
  if (tsx("Capturing…", "capture.ts", captureArgs) !== 0) {
    return { runId, ranGate: false, error: "capture failed" };
  }
  if (tsx("Comparing against baseline…", "compare.ts", ["--config", args.config, "--run", runId]) !== 0) {
    return { runId, ranGate: false, error: "compare failed" };
  }
  if (tsx("Building report…", "report.ts", ["--config", args.config, "--run", runId]) !== 0) {
    return { runId, ranGate: false, error: "report failed" };
  }

  // The gate. Its exit (0/1/2) is the verdict the agent presents; ci-run.ts does not adopt it.
  const gateArgs = ["--run", runId, "--json"];
  if (args.allowNew) {
    gateArgs.push("--allow-new");
  }
  if (args.allowError) {
    gateArgs.push("--allow-error");
  }
  const gateExit = tsx("Gating (CI exit 0 clean / 1 regressions / 2 could-not-run)…", "ci.ts", gateArgs);

  // PR-comment markdown — best-effort; never let it mask the gate verdict.
  let prCommentPath: string | undefined;
  if (tsx("Generating PR-comment markdown…", "pr-report.ts", ["--run", runId]) === 0) {
    prCommentPath = join(".visual-guard", "runs", runId, "pr-comment.md");
  }

  return {
    runId,
    ranGate: true,
    gateExit,
    manifestPath: join(".visual-guard", "runs", runId, "manifest.json"),
    prCommentPath,
  };
}

async function main(argv: string[]): Promise<void> {
  const args = parseCiArgs(argv);
  const result = runCi(args);
  const outDir = join(args.cwd, ".visual-guard");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "last-ci.json"), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result) + "\n");
  // Only a hard failure (capture/compare/report) is a non-zero exit here; a gate "fail" (gateExit 1)
  // is a VERDICT the agent presents, not a failure of this orchestrator.
  process.exitCode = result.error ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[visual-guard] visual-ci failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
