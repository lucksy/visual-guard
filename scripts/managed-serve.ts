import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./lib/config";
import { isReachable } from "./lib/reachable";
import { formatPidfile, isPidAlive, parsePidfile, type PidfileInfo } from "./lib/studio/pidfile";
import { detectPackageManager } from "./harness";
import {
  isLoopbackHttpUrl,
  ladleServeCommand,
  managedLadleTargets,
  portOf,
} from "./lib/harness/serve-plan";

/**
 * Managed-harness serve lifecycle. A Visual-Guard-scaffolded Ladle target (`managed: true`) isn't
 * expected to be already running, so `/visual-check` brackets capture with:
 *   managed-serve start  →  capture  →  compare  →  report  →  managed-serve stop   (stop runs always)
 *
 * `start` spawns `ladle serve` detached (its own process group), waits until the target URL answers, and
 * records `<outRoot>/harness.pid` (reusing the Studio pidfile format). `stop` kills that process group and
 * removes the pidfile — idempotent, and it reaps an orphaned server left by a crashed previous run. This
 * lives OUTSIDE `captureAll` on purpose: capture is also reused by the Studio "Sync" path, which must not
 * spawn dev servers as a side effect.
 */

const PREFIX = "Visual Guard managed-serve";
const DEFAULT_OUT_ROOT = ".visual-guard";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function harnessPidfile(rootAbs: string, outRoot: string): string {
  return join(rootAbs, outRoot, "harness.pid");
}

function readPidfile(path: string): PidfileInfo | null {
  try {
    return parsePidfile(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Kill a detached child's whole process group (negative pid), falling back to the bare pid. */
function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

export interface CliArgs {
  command: "start" | "stop";
  config: string;
  cwd: string;
  outRoot: string;
}

export function parseArgs(argv: string[]): CliArgs {
  let command: "start" | "stop" | undefined;
  let config = "config/visual.config.json";
  let cwd = process.cwd();
  let outRoot = DEFAULT_OUT_ROOT;

  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined) fail(`missing value for ${flag}.`);
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "start":
      case "stop":
        if (command !== undefined) fail(`only one command may be given (got "${command}" and "${arg}").`);
        command = arg;
        break;
      case "--config":
        config = value(++i, "--config");
        break;
      case "--cwd":
        cwd = value(++i, "--cwd");
        break;
      case "--out":
        outRoot = value(++i, "--out");
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  if (command === undefined) {
    fail(`a command is required: "start" or "stop".`);
  }
  return { command, config, cwd, outRoot };
}

async function start(args: CliArgs): Promise<void> {
  const config = loadConfig(args.config);
  const managed = managedLadleTargets(config);
  if (managed.length === 0) {
    // No managed harness — a no-op, so /visual-check can always call start unconditionally.
    console.log(JSON.stringify({ command: "start", started: false, reason: "no managed harness target" }));
    return;
  }
  if (managed.length > 1) {
    fail(`multiple managed harness targets are not supported yet (found ${managed.length}).`);
  }
  const target = managed[0]!;
  const rootAbs = resolve(args.cwd);
  // The pidfile round-trips through the loopback-only parsePidfile (so `stop` can read it back); a
  // non-loopback / https managed url would write a pidfile `stop` rejects → a silently-leaked server.
  // A managed harness is always served locally, so require loopback http and fail loudly otherwise.
  if (!isLoopbackHttpUrl(target.url)) {
    fail(`a managed harness url must be loopback http (e.g. http://localhost:61000); got ${target.url}.`);
  }
  const port = portOf(target.url);
  const pfPath = harnessPidfile(rootAbs, args.outRoot);

  // Reap an orphaned harness from a crashed previous run, then always start fresh.
  const existing = readPidfile(pfPath);
  const reaped = existing !== null && isPidAlive(existing.pid);
  if (reaped) {
    killProcessGroup(existing!.pid);
  }
  if (existsSync(pfPath)) {
    try {
      rmSync(pfPath);
    } catch {
      /* ignore */
    }
  }
  // If we did NOT just reap our own server but something is already answering on this port, it's a
  // FOREIGN occupant — don't adopt it (we'd capture against the wrong server). When we did reap, the
  // port may still be releasing, so let the spawn handle it (a failed bind → child exit → fail below).
  if (!reaped && (await isReachable(target.url, { timeoutMs: 2000 }))) {
    fail(`something is already serving at ${target.url}; stop it or change the managed target's port.`);
  }

  const pm = detectPackageManager(rootAbs);
  const { command, args: serveArgs } = ladleServeCommand(pm, port);
  const child = spawn(command, serveArgs, { cwd: rootAbs, detached: true, stdio: "ignore" });

  let spawnError: Error | null = null;
  let exitedCode: number | null = null;
  let exited = false;
  child.on("error", (err) => {
    spawnError = err;
  });
  child.on("exit", (code) => {
    exited = true;
    exitedCode = code;
  });

  // Don't leak the child if start itself is interrupted while waiting for readiness.
  const onSignal = (): void => {
    if (child.pid !== undefined) killProcessGroup(child.pid);
    process.exit(1);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Poll until the target URL answers, failing fast if the dev server errored or exited early.
  const deadline = Date.now() + 60_000;
  let ready = false;
  for (;;) {
    if (spawnError !== null) {
      fail(`failed to start the harness dev server (${command}): ${(spawnError as Error).message}`);
    }
    if (exited) {
      fail(`the harness dev server exited before becoming ready (exit code ${exitedCode ?? "?"}).`);
    }
    if (await isReachable(target.url, { timeoutMs: 2000 })) {
      ready = true;
      break;
    }
    if (Date.now() >= deadline) break;
    await sleep(500);
  }

  if (!ready) {
    if (child.pid !== undefined) killProcessGroup(child.pid);
    fail(`the harness dev server did not become reachable at ${target.url} within 60s.`);
  }
  if (child.pid === undefined) {
    fail(`the harness dev server did not report a pid.`);
  }

  const info: PidfileInfo = {
    pid: child.pid,
    port,
    url: target.url,
    startedAt: new Date().toISOString(),
  };
  mkdirSync(join(rootAbs, args.outRoot), { recursive: true });
  writeFileSync(pfPath, formatPidfile(info));
  child.unref(); // let `start` exit while Ladle keeps serving for the separate capture step
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  console.log(JSON.stringify({ command: "start", started: true, url: target.url, pid: child.pid }));
}

export function stop(args: CliArgs): void {
  const rootAbs = resolve(args.cwd);
  const pfPath = harnessPidfile(rootAbs, args.outRoot);
  const info = readPidfile(pfPath);
  if (info === null) {
    console.log(JSON.stringify({ command: "stop", stopped: false, reason: "no harness pidfile" }));
    return;
  }
  if (isPidAlive(info.pid)) {
    killProcessGroup(info.pid);
  }
  try {
    rmSync(pfPath);
  } catch {
    /* already gone */
  }
  console.log(JSON.stringify({ command: "stop", stopped: true, pid: info.pid }));
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "start") {
    await start(args);
  } else {
    stop(args);
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
