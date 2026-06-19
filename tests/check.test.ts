import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseCheckArgs, runCheck, type StepRunner } from "../scripts/check";

/**
 * Unit tests for the `/visual-check` orchestrator. The step runner is INJECTED, so no engine script is
 * ever spawned — we assert the exact SEQUENCE of steps, their argv, and the always-stop semantics that
 * replace the old shell `trap`. scope.ts's real side effect (writing scope.json) is simulated by the
 * recorder, because runCheck deletes any stale scope file before invoking scope.ts.
 */

interface Call {
  label: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * A recording runner. `fail` makes the named engine script (by basename) exit non-zero. When scope.ts
 * "runs", it SIMULATES scope.ts's side effect — writing `.visual-guard/scope.json` with the configured
 * `scopeMode` (and, when `fingerprints` is set, `fingerprints-current.json`) into `cwd` — which is how
 * the real flow works (runCheck rm's the stale files, then scope.ts writes fresh ones).
 */
function recorder(
  opts: { fail?: string; scopeMode?: "scoped" | "all" | "none"; fingerprints?: boolean; cwd?: string } = {},
): { run: StepRunner; calls: Call[]; ids: () => string[]; capture: () => Call } {
  const calls: Call[] = [];
  const run: StepRunner = (label, command, args, runOpts) => {
    calls.push({ label, command, args, env: runOpts.env });
    const script = basename(args[0] ?? "");
    if (script === "scope.ts" && opts.cwd) {
      writeFileSync(join(opts.cwd, ".visual-guard", "scope.json"), JSON.stringify({ mode: opts.scopeMode ?? "all" }));
      if (opts.fingerprints) {
        writeFileSync(join(opts.cwd, ".visual-guard", "fingerprints-current.json"), "{}");
      }
    }
    return opts.fail && script === opts.fail ? 1 : 0;
  };
  const ids = () =>
    calls.map((c) => {
      const script = basename(c.args[0] ?? "");
      return script === "managed-serve.ts" ? `managed:${c.args[1]}` : script;
    });
  const capture = () => calls.find((c) => basename(c.args[0] ?? "") === "capture.ts")!;
  return { run, calls, ids, capture };
}

describe("parseCheckArgs", () => {
  it("parses every flag", () => {
    const a = parseCheckArgs([
      "--config", "/c.json", "--cwd", "/p", "--target", "Button", "--since", "main", "--skip-unchanged",
    ]);
    expect(a).toEqual({ config: "/c.json", cwd: "/p", target: "Button", all: false, since: "main", skipUnchanged: true });
  });

  it("parses --all", () => {
    expect(parseCheckArgs(["--config", "/c.json", "--all"]).all).toBe(true);
  });

  it("requires --config", () => {
    expect(() => parseCheckArgs(["--cwd", "/p"])).toThrow(/--config is required/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCheckArgs(["--config", "/c.json", "--bogus"])).toThrow(/unknown argument --bogus/);
  });
});

describe("runCheck — orchestration sequence", () => {
  let cwd = "";
  const config = () => join(cwd, "visual.config.json");
  const writeConfig = (obj: object) => writeFileSync(config(), JSON.stringify(obj));

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "vg-check-"));
    mkdirSync(join(cwd, ".visual-guard"), { recursive: true });
    writeConfig({ targets: [] });
  });
  afterEach(() => {
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("explicit target: skips scope.ts, captures --target, and always stops the harness", () => {
    const r = recorder({ cwd });
    const result = runCheck(
      { config: config(), cwd, target: "Button", all: false, skipUnchanged: false },
      { run: r.run, runId: "RID" },
    );
    expect(result).toEqual({
      runId: "RID",
      mode: "explicit",
      ranCapture: true,
      manifestPath: join(".visual-guard", "runs", "RID", "manifest.json"),
    });
    expect(r.ids()).toEqual([
      "managed:start",
      "capture.ts",
      "compare.ts",
      "report.ts",
      "detect-ui-change.mjs",
      "managed:stop",
    ]);
    expect(r.capture().args).toContain("--target");
    expect(r.capture().args).toContain("Button");
    expect(r.capture().args).toContain("RID");
    expect(r.capture().args).not.toContain("--scope-file");
  });

  it("scoped: runs scope.ts then captures with --scope-file (+ fingerprints when present)", () => {
    const r = recorder({ cwd, scopeMode: "scoped", fingerprints: true });
    const result = runCheck({ config: config(), cwd, all: false, skipUnchanged: false }, { run: r.run, runId: "RID" });
    expect(result.mode).toBe("scoped");
    expect(r.ids()).toEqual([
      "managed:start",
      "scope.ts",
      "capture.ts",
      "compare.ts",
      "report.ts",
      "detect-ui-change.mjs",
      "managed:stop",
    ]);
    expect(r.capture().args).toContain("--scope-file");
    expect(r.capture().args).toContain("--fingerprints");
    expect(r.capture().args).not.toContain("--skip-unchanged"); // not opted in
  });

  it("all: passes --all to scope.ts and captures WITHOUT --scope-file (full sweep)", () => {
    const r = recorder({ cwd, scopeMode: "all" });
    runCheck({ config: config(), cwd, all: true, skipUnchanged: false }, { run: r.run, runId: "RID" });
    const scope = r.calls.find((c) => basename(c.args[0] ?? "") === "scope.ts")!;
    expect(scope.args).toContain("--all");
    expect(r.capture().args).not.toContain("--scope-file");
  });

  it("none: returns early, runs no capture/compare/report, but STILL stops the harness", () => {
    const r = recorder({ cwd, scopeMode: "none" });
    const result = runCheck({ config: config(), cwd, all: false, skipUnchanged: false }, { run: r.run, runId: "RID" });
    expect(result).toEqual({ runId: "RID", mode: "none", ranCapture: false });
    expect(r.ids()).toEqual(["managed:start", "scope.ts", "managed:stop"]);
  });

  it("--since is forwarded to scope.ts", () => {
    const r = recorder({ cwd, scopeMode: "all" });
    runCheck({ config: config(), cwd, all: false, since: "origin/main", skipUnchanged: false }, { run: r.run, runId: "RID" });
    const scope = r.calls.find((c) => basename(c.args[0] ?? "") === "scope.ts")!;
    expect(scope.args).toEqual(expect.arrayContaining(["--since", "origin/main"]));
  });

  it("--skip-unchanged is forwarded to capture", () => {
    const r = recorder({ cwd, scopeMode: "scoped" });
    runCheck({ config: config(), cwd, all: false, skipUnchanged: true }, { run: r.run, runId: "RID" });
    expect(r.capture().args).toContain("--skip-unchanged");
  });

  it("config scope.fingerprintSkip enables skip on a SCOPED run (no flag needed)", () => {
    writeConfig({ targets: [], scope: { fingerprintSkip: true } });
    const r = recorder({ cwd, scopeMode: "scoped" });
    runCheck({ config: config(), cwd, all: false, skipUnchanged: false }, { run: r.run, runId: "RID" });
    expect(r.capture().args).toContain("--skip-unchanged");
  });

  it("config scope.fingerprintSkip does NOT enable skip on a full --all sweep (backstop intact)", () => {
    writeConfig({ targets: [], scope: { fingerprintSkip: true } });
    const r = recorder({ cwd, scopeMode: "all" });
    runCheck({ config: config(), cwd, all: true, skipUnchanged: false }, { run: r.run, runId: "RID" });
    expect(r.capture().args).not.toContain("--skip-unchanged");
  });

  it("capture failure: stops at capture, records the error, and STILL stops the harness", () => {
    const r = recorder({ cwd, scopeMode: "all", fail: "capture.ts" });
    const result = runCheck({ config: config(), cwd, all: true, skipUnchanged: false }, { run: r.run, runId: "RID" });
    expect(result).toEqual({ runId: "RID", mode: "all", ranCapture: false, error: "capture failed" });
    expect(r.ids()).toEqual(["managed:start", "scope.ts", "capture.ts", "managed:stop"]);
  });

  it("managed-start failure: records the error and does NOT stop a harness that never started", () => {
    const r = recorder({ cwd, fail: "managed-serve.ts" });
    const result = runCheck(
      { config: config(), cwd, target: "Button", all: false, skipUnchanged: false },
      { run: r.run, runId: "RID" },
    );
    expect(result.error).toBe("managed harness failed to start");
    expect(r.ids()).toEqual(["managed:start"]); // no stop — it never started
  });

  it("sets PLAYWRIGHT_BROWSERS_PATH for children when CLAUDE_PLUGIN_DATA is present", () => {
    const r = recorder({ cwd, scopeMode: "all" });
    runCheck(
      { config: config(), cwd, all: true, skipUnchanged: false },
      { run: r.run, runId: "RID", env: { CLAUDE_PLUGIN_DATA: "/data" } },
    );
    expect(r.capture().env.PLAYWRIGHT_BROWSERS_PATH).toBe(join("/data", "browsers"));
  });
});
