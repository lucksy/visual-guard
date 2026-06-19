import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * `/visual-studio` launcher — ONE statically-analyzable command in place of the inline shell that the
 * command body used to carry (`nohup … & disown`, a `for` poll loop, and `cat`). It starts the
 * localhost studio server DETACHED (so it outlives this turn, like `nohup … & disown`), waits for the
 * server to write its pidfile, and prints the pidfile JSON (`{ pid, port, url, startedAt }`) for the
 * command to `Read`.
 *
 * Pure-ish + testable: {@link parseLaunchArgs} and {@link waitForPidfile} are unit-tested; only the
 * thin detached spawn touches the real process table.
 */

// Self-locate (see check.ts): <pluginRoot>/scripts/studio-launch.ts → serve.ts beside it under studio/.
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(SCRIPTS_DIR);
const RUNNER = join(PLUGIN_ROOT, "node_modules", ".bin", "tsx");
const SERVE = join(SCRIPTS_DIR, "studio", "serve.ts");

export interface LaunchArgs {
  config: string;
  cwd: string;
}

export function parseLaunchArgs(argv: string[]): LaunchArgs {
  const args: LaunchArgs = { config: "", cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error(`visual-studio: missing value for ${flag}`);
      }
      return next;
    };
    if (flag === "--config") {
      args.config = value();
    } else if (flag === "--cwd") {
      args.cwd = value();
    } else {
      throw new Error(`visual-studio: unknown argument ${flag}`);
    }
  }
  if (!args.config) {
    throw new Error("visual-studio: --config is required");
  }
  return args;
}

/**
 * Poll for `pidfile` (written by serve.ts once it is listening) up to `attempts` times, `delayMs`
 * apart. Returns true as soon as it appears. `exists`/`sleep` are injectable so the loop is unit-tested
 * without real timers or filesystem.
 */
export async function waitForPidfile(
  pidfile: string,
  opts: {
    attempts?: number;
    delayMs?: number;
    exists?: (p: string) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 20; // 20 × 250ms ≈ 5s, matching the old shell loop
  const delayMs = opts.delayMs ?? 250;
  const exists = opts.exists ?? existsSync;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    if (exists(pidfile)) {
      return true;
    }
    await sleep(delayMs);
  }
  return exists(pidfile);
}

async function main(argv: string[]): Promise<void> {
  const args = parseLaunchArgs(argv);
  mkdirSync(join(args.cwd, ".visual-guard"), { recursive: true });

  // Detached + unref + stdio ignore = the long-lived server is NOT tied to this turn (replaces
  // `nohup … & disown`). serve.ts binds 127.0.0.1, writes the pidfile, and opens the browser itself.
  const child = spawn(RUNNER, [SERVE, "--config", args.config], {
    cwd: args.cwd,
    env: { ...process.env },
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const pidfile = join(args.cwd, ".visual-guard", "studio.pid");
  if (await waitForPidfile(pidfile)) {
    process.stdout.write(readFileSync(pidfile, "utf8"));
    return;
  }
  process.stderr.write(
    "[visual-guard] The studio server did not start within ~5s. Run it in the foreground to see the error:\n" +
      `  "${RUNNER}" "${SERVE}" --config "${args.config}" --no-open\n`,
  );
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[visual-guard] visual-studio launch failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
