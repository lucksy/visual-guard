import { describe, it, expect } from "vitest";
import { basename, join } from "node:path";
import { parseCiArgs, runCi, type StepRunner } from "../scripts/ci-run";

interface Call {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Recording runner; `exit` maps a script basename to its exit code (default 0). */
function recorder(exit: Record<string, number> = {}): {
  run: StepRunner;
  calls: Call[];
  ids: () => string[];
  find: (script: string) => Call | undefined;
} {
  const calls: Call[] = [];
  const run: StepRunner = (_label, _command, args, opts) => {
    calls.push({ args, env: opts.env });
    return exit[basename(args[0] ?? "")] ?? 0;
  };
  const ids = () => calls.map((c) => basename(c.args[0] ?? ""));
  const find = (script: string) => calls.find((c) => basename(c.args[0] ?? "") === script);
  return { run, calls, ids, find };
}

describe("parseCiArgs", () => {
  it("parses every flag", () => {
    expect(parseCiArgs(["--config", "/c.json", "--cwd", "/p", "--target", "Button", "--allow-new", "--allow-error"])).toEqual({
      config: "/c.json",
      cwd: "/p",
      target: "Button",
      allowNew: true,
      allowError: true,
    });
  });

  it("requires --config", () => {
    expect(() => parseCiArgs(["--cwd", "/p"])).toThrow(/--config is required/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCiArgs(["--config", "/c.json", "--xyz"])).toThrow(/unknown argument --xyz/);
  });
});

describe("runCi — capture → compare → report → gate → pr-report", () => {
  const base = { config: "/c.json", cwd: "/p", allowNew: false, allowError: false };

  it("runs the full pipeline and records the gate exit + artifact paths", () => {
    const r = recorder({ "ci.ts": 1 }); // gate reports unapproved regressions
    const result = runCi(base, { run: r.run, runId: "RID" });
    expect(r.ids()).toEqual(["capture.ts", "compare.ts", "report.ts", "ci.ts", "pr-report.ts"]);
    expect(result).toEqual({
      runId: "RID",
      ranGate: true,
      gateExit: 1,
      manifestPath: join(".visual-guard", "runs", "RID", "manifest.json"),
      prCommentPath: join(".visual-guard", "runs", "RID", "pr-comment.md"),
    });
  });

  it("a clean gate is recorded as gateExit 0", () => {
    const r = recorder();
    expect(runCi(base, { run: r.run, runId: "RID" }).gateExit).toBe(0);
  });

  it("--target is forwarded to capture only", () => {
    const r = recorder();
    runCi({ ...base, target: "Button" }, { run: r.run, runId: "RID" });
    expect(r.find("capture.ts")!.args).toEqual(expect.arrayContaining(["--target", "Button"]));
    expect(r.find("compare.ts")!.args).not.toContain("--target");
  });

  it("--allow-new / --allow-error are forwarded to the gate", () => {
    const r = recorder();
    runCi({ ...base, allowNew: true, allowError: true }, { run: r.run, runId: "RID" });
    const gate = r.find("ci.ts")!;
    expect(gate.args).toEqual(expect.arrayContaining(["--allow-new", "--allow-error"]));
  });

  it("capture failure stops before the gate and records the error", () => {
    const r = recorder({ "capture.ts": 1 });
    const result = runCi(base, { run: r.run, runId: "RID" });
    expect(result).toEqual({ runId: "RID", ranGate: false, error: "capture failed" });
    expect(r.ids()).toEqual(["capture.ts"]);
  });

  it("a failed pr-report does not fail the run (gate verdict still stands)", () => {
    const r = recorder({ "pr-report.ts": 1 });
    const result = runCi(base, { run: r.run, runId: "RID" });
    expect(result.ranGate).toBe(true);
    expect(result.prCommentPath).toBeUndefined();
  });

  it("sets PLAYWRIGHT_BROWSERS_PATH for children when CLAUDE_PLUGIN_DATA is present", () => {
    const r = recorder();
    runCi(base, { run: r.run, runId: "RID", env: { CLAUDE_PLUGIN_DATA: "/data" } });
    expect(r.find("capture.ts")!.env.PLAYWRIGHT_BROWSERS_PATH).toBe(join("/data", "browsers"));
  });
});
