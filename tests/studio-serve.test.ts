import { describe, it, expect } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "../scripts/studio/serve";

/**
 * P3 `serve.ts` coverage. `parseArgs` is unit-tested like every other CLI in the repo. The lifecycle
 * (pidfile single-instance reuse + SIGTERM cleanup + "returns control, no hung turn") is an explicit P3
 * exit criterion, so it is exercised by spawning the real entrypoint as a child process — no browser, no
 * capture (we never POST /api/sync), so it runs in the normal gate.
 */

describe("parseArgs", () => {
  it("defaults config/out/port/open", () => {
    expect(parseArgs([])).toEqual({
      config: "config/visual.config.json",
      outRoot: ".visual-guard",
      port: 0,
      open: true,
    });
  });

  it("parses --config, --out, --port, --no-open", () => {
    expect(parseArgs(["--config", "x.json", "--out", "o", "--port", "8080", "--no-open"])).toEqual({
      config: "x.json",
      outRoot: "o",
      port: 8080,
      open: false,
    });
  });

  it("rejects an out-of-range / non-numeric port", () => {
    expect(() => parseArgs(["--port", "-1"])).toThrow(/--port/);
    expect(() => parseArgs(["--port", "70000"])).toThrow(/--port/);
    expect(() => parseArgs(["--port", "abc"])).toThrow(/--port/);
  });

  it("rejects unknown args and missing values", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--config"])).toThrow(/missing value/);
  });
});

// --- Lifecycle (spawned child process) -------------------------------------

const REPO = process.cwd();
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const SERVE = join(REPO, "scripts", "studio", "serve.ts");
const CONFIG = join(REPO, "config", "visual.config.json");

interface ServeLine {
  reused: boolean;
  pid: number;
  port: number;
  url: string;
}

function spawnServe(outRoot: string): ChildProcessWithoutNullStreams {
  // "pipe" (not ["ignore",...]) so the return type is ChildProcessWithoutNullStreams (non-null
  // stdout/stderr); serve.ts never reads stdin, so leaving it as an unused pipe is harmless.
  return spawn(TSX, [SERVE, "--no-open", "--config", CONFIG, "--out", outRoot], {
    cwd: REPO,
    stdio: "pipe",
  });
}

/** Resolve with the first JSON object the child prints to stdout (its `{reused,pid,port,url}` line). */
function firstJsonLine(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<ServeLine> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`timeout; stdout so far: ${buf}`)), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      for (const line of buf.split("\n")) {
        const s = line.trim();
        if (s.startsWith("{")) {
          try {
            const parsed = JSON.parse(s) as ServeLine;
            clearTimeout(timer);
            resolve(parsed);
            return;
          } catch {
            // partial line — keep buffering
          }
        }
      }
    });
    child.stderr.on("data", () => {}); // drain so the pipe never blocks
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited (code ${code}) before printing a JSON line; stdout: ${buf}`));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not exit in time")), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("serve.ts lifecycle — single-instance + signal cleanup", () => {
  it("writes a pidfile, reuses a live instance, and removes the pidfile on SIGTERM", async () => {
    const out = mkdtempSync(join(tmpdir(), "vg-serve-"));
    const pidfile = join(out, "studio.pid");
    let a: ChildProcessWithoutNullStreams | undefined;
    let b: ChildProcessWithoutNullStreams | undefined;
    try {
      // First instance: starts fresh, binds a port, writes the pidfile.
      a = spawnServe(out);
      const first = await firstJsonLine(a, 20000);
      expect(first.reused).toBe(false);
      expect(first.url).toBe(`http://127.0.0.1:${first.port}/`);
      expect(existsSync(pidfile)).toBe(true);

      // Second instance against the same out-dir: detects the live pidfile and REUSES (no new listen),
      // then returns control (the process exits 0 — "no hung turn").
      b = spawnServe(out);
      const second = await firstJsonLine(b, 20000);
      expect(second.reused).toBe(true);
      expect(second.port).toBe(first.port); // reused the same server, did not bind a new port
      expect(await waitForExit(b, 10000)).toBe(0);
      b = undefined;

      // SIGTERM the first: it closes the server + DB and removes the pidfile, exiting 0.
      a.kill("SIGTERM");
      expect(await waitForExit(a, 10000)).toBe(0);
      a = undefined;
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      a?.kill("SIGKILL");
      b?.kill("SIGKILL");
      rmSync(out, { recursive: true, force: true });
    }
  }, 60000);
});
