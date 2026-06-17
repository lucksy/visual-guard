import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "../scripts/lib/config";
import {
  installCommand,
  isLoopbackHttpUrl,
  ladleServeCommand,
  managedLadleTargets,
  portOf,
} from "../scripts/lib/harness/serve-plan";
import { parseArgs, stop } from "../scripts/managed-serve";
import { formatPidfile } from "../scripts/lib/studio/pidfile";

// --- serve-plan (pure) ----------------------------------------------------

describe("managedLadleTargets", () => {
  it("returns only ladle targets flagged managed", () => {
    const config = parseConfig({
      targets: [
        { type: "storybook", url: "http://localhost:6006" },
        { type: "ladle", url: "http://localhost:61000", managed: true },
        { type: "ladle", url: "http://localhost:61001" }, // not managed
      ],
    });
    expect(managedLadleTargets(config).map((t) => t.url)).toEqual(["http://localhost:61000"]);
  });
});

describe("portOf", () => {
  it("reads the explicit port, defaulting by scheme", () => {
    expect(portOf("http://localhost:61000")).toBe(61000);
    expect(portOf("http://localhost")).toBe(80);
    expect(portOf("https://example.com")).toBe(443);
  });
});

describe("isLoopbackHttpUrl", () => {
  it("accepts loopback http urls only", () => {
    expect(isLoopbackHttpUrl("http://localhost:61000")).toBe(true);
    expect(isLoopbackHttpUrl("http://127.0.0.1:61000")).toBe(true);
    expect(isLoopbackHttpUrl("http://[::1]:61000")).toBe(true);
  });
  it("rejects https, non-loopback hosts, and garbage (would silently leak the server at stop)", () => {
    expect(isLoopbackHttpUrl("https://localhost:61000")).toBe(false);
    expect(isLoopbackHttpUrl("http://0.0.0.0:61000")).toBe(false);
    expect(isLoopbackHttpUrl("http://192.168.1.5:61000")).toBe(false);
    expect(isLoopbackHttpUrl("not a url")).toBe(false);
  });
});

describe("ladleServeCommand / installCommand", () => {
  it("maps each package manager to its runner + install command", () => {
    expect(ladleServeCommand("npm", 61000)).toEqual({
      command: "npx",
      args: ["--no-install", "ladle", "serve", "--port", "61000"],
    });
    expect(ladleServeCommand("pnpm", 6).command).toBe("pnpm");
    expect(ladleServeCommand("yarn", 6).args[0]).toBe("ladle");
    expect(ladleServeCommand("bun", 6).command).toBe("bunx");
    expect(installCommand("yarn")).toBe("yarn");
    expect(installCommand("pnpm")).toBe("pnpm install");
  });
});

// --- managed-serve shell (parseArgs + stop) -------------------------------

describe("managed-serve parseArgs", () => {
  it("parses the start/stop command + flags", () => {
    expect(parseArgs(["start", "--config", "c.json", "--cwd", "/p", "--out", ".vg"])).toEqual({
      command: "start",
      config: "c.json",
      cwd: "/p",
      outRoot: ".vg",
    });
  });
  it("requires a command and rejects unknown flags", () => {
    expect(() => parseArgs([])).toThrow(/command is required/);
    expect(() => parseArgs(["start", "--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["start", "stop"])).toThrow(/only one command/);
  });
});

describe("managed-serve stop", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-serve-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("is a no-op when there is no harness pidfile", () => {
    expect(() => stop({ command: "stop", config: "x", cwd: tmp, outRoot: ".visual-guard" })).not.toThrow();
  });

  it("removes a stale pidfile (dead pid) idempotently", () => {
    const pfDir = join(tmp, ".visual-guard");
    mkdirSync(pfDir, { recursive: true });
    const pfPath = join(pfDir, "harness.pid");
    // A pid that is essentially never alive → stop won't signal anything, just cleans up.
    writeFileSync(
      pfPath,
      formatPidfile({ pid: 2147483646, port: 61000, url: "http://localhost:61000/", startedAt: "x" }),
    );
    stop({ command: "stop", config: "x", cwd: tmp, outRoot: ".visual-guard" });
    expect(existsSync(pfPath)).toBe(false);
  });
});
