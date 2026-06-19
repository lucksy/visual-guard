import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countTargetsByStatus, evaluateGate, parseArgs, runGate } from "../scripts/ci";
import type { ComparisonStatus } from "../scripts/compare";
import type { Manifest, ManifestTarget } from "../scripts/report";

function mkTarget(
  target: string,
  status: ComparisonStatus,
  instance = "sample",
): ManifestTarget {
  return { instance, target, status, changedFiles: [], images: [] };
}

function mkManifest(targets: ManifestTarget[]): Manifest {
  const by = (status: ComparisonStatus): number =>
    targets.filter((target) => target.status === status).length;
  return {
    version: 2,
    runId: "RUN1",
    runDir: ".visual-guard/runs/RUN1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    gates: { threshold: 0.1, maxDiffRatio: 0.01 },
    changedFiles: [],
    summary: {
      targets: targets.length,
      images: targets.length,
      pass: by("pass"),
      fail: by("fail"),
      new: by("new"),
      error: by("error"),
      skipped: 0,
    },
    targets,
  };
}

const strict = { allowNew: false, allowError: false };

describe("countTargetsByStatus", () => {
  it("counts every status with zero defaults", () => {
    expect(
      countTargetsByStatus([mkTarget("a", "pass"), mkTarget("b", "fail"), mkTarget("c", "pass")]),
    ).toEqual({ pass: 2, fail: 1, new: 0, error: 0 });
  });
});

describe("evaluateGate", () => {
  it("passes a clean run (exit 0)", () => {
    const result = evaluateGate(mkManifest([mkTarget("a", "pass"), mkTarget("b", "pass")]), strict);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.blockingTargets).toEqual([]);
    expect(result.summaryLine).toContain("clean");
  });

  it("blocks on a fail (exit 1) and lists the target", () => {
    const result = evaluateGate(
      mkManifest([mkTarget("Button", "fail"), mkTarget("Badge", "pass")]),
      strict,
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.blocking).toEqual({ fail: 1, new: 0, error: 0 });
    expect(result.blockingTargets).toEqual([{ instance: "sample", target: "Button", status: "fail" }]);
    expect(result.summaryLine).toContain("BLOCKED");
  });

  it("blocks a `new` (unapproved) target by default, but not with allowNew", () => {
    const manifest = mkManifest([mkTarget("Fresh", "new")]);
    expect(evaluateGate(manifest, strict).exitCode).toBe(1);
    expect(evaluateGate(manifest, strict).blocking.new).toBe(1);

    const relaxed = evaluateGate(manifest, { allowNew: true, allowError: false });
    expect(relaxed.ok).toBe(true);
    expect(relaxed.exitCode).toBe(0);
    expect(relaxed.blocking.new).toBe(0);
    expect(relaxed.counts.new).toBe(1); // still counted, just not blocking
    expect(relaxed.summaryLine).toContain("1 new allowed");
  });

  it("blocks an `error` target by default, but not with allowError", () => {
    const manifest = mkManifest([mkTarget("Broken", "error")]);
    expect(evaluateGate(manifest, strict).exitCode).toBe(1);
    expect(evaluateGate(manifest, { allowNew: false, allowError: true }).ok).toBe(true);
  });

  it("does not pass green on a zero-target manifest — exits 2 (could not run)", () => {
    const result = evaluateGate(mkManifest([]), strict);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.summaryLine).toContain("0 targets");
  });

  it("a fail still blocks even when new and error are allowed", () => {
    const manifest = mkManifest([
      mkTarget("Button", "fail"),
      mkTarget("Fresh", "new"),
      mkTarget("Broken", "error"),
    ]);
    const result = evaluateGate(manifest, { allowNew: true, allowError: true });
    expect(result.ok).toBe(false);
    expect(result.blockingTargets.map((t) => t.target)).toEqual(["Button"]);
    expect(result.blocking).toEqual({ fail: 1, new: 0, error: 0 });
  });
});

describe("parseArgs", () => {
  it("reads flags and defaults", () => {
    expect(parseArgs([])).toEqual({
      runId: undefined,
      outRoot: undefined,
      allowNew: false,
      allowError: false,
      json: false,
    });
    expect(parseArgs(["--run", "R", "--out", "x", "--allow-new", "--allow-error", "--json"])).toEqual(
      { runId: "R", outRoot: "x", allowNew: true, allowError: true, json: true },
    );
  });

  it("throws on an unknown flag and a missing value", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--run"])).toThrow(/missing value for --run/);
  });
});

describe("runGate", () => {
  let tmp = "";
  let outRoot = "";

  const writeManifest = (runId: string, manifest: Manifest): void => {
    const runDir = join(outRoot, "runs", runId);
    mkdirSync(join(runDir, "current"), { recursive: true }); // latestRunId requires a current/ dir
    writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-ci-"));
    outRoot = join(tmp, ".visual-guard");
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("reads a run's manifest and evaluates the gate", () => {
    writeManifest("RUN1", mkManifest([mkTarget("Button", "fail")]));
    const result = runGate({ runId: "RUN1", outRoot, policy: strict });
    expect(result.runId).toBe("RUN1");
    expect(result.exitCode).toBe(1);
    expect(result.manifestPath).toContain("RUN1");
  });

  it("defaults to the latest run when --run is omitted", () => {
    writeManifest("20260101-000000", mkManifest([mkTarget("Old", "pass")]));
    writeManifest("20260614-120000", mkManifest([mkTarget("New", "fail")]));
    const result = runGate({ outRoot, policy: strict });
    expect(result.runId).toBe("20260614-120000");
    expect(result.exitCode).toBe(1);
  });

  it("throws when there are no runs", () => {
    expect(() => runGate({ outRoot, policy: strict })).toThrow(/no runs under/);
  });

  it("throws when the manifest is missing for an explicit run", () => {
    mkdirSync(join(outRoot, "runs", "RUN1", "current"), { recursive: true });
    expect(() => runGate({ runId: "RUN1", outRoot, policy: strict })).toThrow(/no manifest\.json/);
  });

  it("throws on an invalid manifest JSON", () => {
    const runDir = join(outRoot, "runs", "RUN1");
    mkdirSync(join(runDir, "current"), { recursive: true });
    writeFileSync(join(runDir, "manifest.json"), "{ not json");
    expect(() => runGate({ runId: "RUN1", outRoot, policy: strict })).toThrow(/not valid JSON/);
  });
});
