import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseConfig, type Config } from "../scripts/lib/config";
import { diffImages } from "../scripts/lib/diff";
import {
  applyBaseline,
  latestRunId,
  parseArgs,
  planBaseline,
  runBaseline,
  type BaselineCopy,
} from "../scripts/baseline";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): Buffer => readFileSync(join(fixtures, name));

const config: Config = parseConfig({
  targets: [{ type: "storybook", url: "http://localhost:6006" }],
});

let tmp = "";
let outRoot = "";
let runsDir = "";
let currentDir = "";
let baselineDir = "";

function put(root: string, key: string, name: string): void {
  const path = join(root, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fixture(name));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vg-base-"));
  outRoot = join(tmp, ".visual-guard");
  runsDir = join(outRoot, "runs");
  currentDir = join(runsDir, "RUN1", "current");
  baselineDir = join(tmp, "baselines");
  // a run with two Button renders and one Star render
  put(currentDir, "components/Button/default@1280.png", "solid-10x10.png");
  put(currentDir, "components/Button/hover@1280.png", "patch-2x2.png");
  put(currentDir, "icons/Star/default@1280.png", "solid-10x10.png");
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("reads flags and defaults the booleans to false", () => {
    expect(parseArgs(["--target", "Button"])).toEqual({
      config: "config/visual.config.json",
      target: "Button",
      overwrite: false,
      confirmed: false,
      dryRun: false,
    });
    expect(parseArgs(["--run", "R", "--overwrite", "--confirmed", "--dry-run"])).toEqual({
      config: "config/visual.config.json",
      runId: "R",
      overwrite: true,
      confirmed: true,
      dryRun: true,
    });
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });
});

describe("latestRunId", () => {
  it("returns the lexically-greatest run that has a current/ dir (timestamps sort)", () => {
    const fresh = join(tmp, "fresh-runs");
    mkdirSync(join(fresh, "20260101-000000", "current"), { recursive: true });
    mkdirSync(join(fresh, "20260613-120000", "current"), { recursive: true });
    mkdirSync(join(fresh, "20260613-235959"), { recursive: true }); // newer but no current/ → skipped
    expect(latestRunId(fresh)).toBe("20260613-120000");
  });

  it("returns null when there are no runs", () => {
    expect(latestRunId(join(tmp, "missing"))).toBeNull();
  });
});

describe("planBaseline", () => {
  it("plans copies for a target and marks which already exist", () => {
    put(baselineDir, "components/Button/default@1280.png", "solid-10x10.png"); // pre-existing
    const plan = planBaseline(currentDir, baselineDir, "Button");
    expect(plan.map((c) => c.key)).toEqual([
      "components/Button/default@1280.png",
      "components/Button/hover@1280.png",
    ]);
    expect(plan.find((c) => c.key.includes("default"))?.existed).toBe(true);
    expect(plan.find((c) => c.key.includes("hover"))?.existed).toBe(false);
  });

  it("plans all renders when no target filter is given", () => {
    expect(planBaseline(currentDir, baselineDir)).toHaveLength(3);
  });

  it("matches a target by instance or instance/target too", () => {
    expect(planBaseline(currentDir, baselineDir, "icons")).toHaveLength(1);
    expect(planBaseline(currentDir, baselineDir, "components/Button")).toHaveLength(2);
  });
});

describe("applyBaseline", () => {
  it("copies new baselines and skips existing ones unless overwrite", () => {
    put(baselineDir, "components/Button/default@1280.png", "solid-10x10.png");
    const plan = planBaseline(currentDir, baselineDir, "Button");

    const first = applyBaseline(plan, baselineDir, { overwrite: false });
    expect(first.written).toEqual(["components/Button/hover@1280.png"]);
    expect(first.skipped).toEqual(["components/Button/default@1280.png"]);

    const plan2 = planBaseline(currentDir, baselineDir, "Button");
    const second = applyBaseline(plan2, baselineDir, { overwrite: true });
    expect(second.written).toEqual([
      "components/Button/default@1280.png",
      "components/Button/hover@1280.png",
    ]);
    expect(second.skipped).toEqual([]);
  });

  it("refuses to write outside the baseline dir (path-traversal guard)", () => {
    const evil: BaselineCopy = {
      key: "x.png",
      fromAbs: join(currentDir, "components/Button/default@1280.png"),
      toAbs: join(tmp, "ESCAPED.png"), // outside baselineDir
      toRel: "../ESCAPED.png",
      existed: false,
    };
    expect(() => applyBaseline([evil], baselineDir, { overwrite: true })).toThrow(
      /outside the baseline dir/,
    );
    expect(existsSync(join(tmp, "ESCAPED.png"))).toBe(false);
  });
});

describe("runBaseline", () => {
  it("dry-run reports the plan without writing anything", () => {
    const result = runBaseline(config, {
      target: "Button",
      outRoot,
      baselineDir,
      dryRun: true,
    });
    expect(result.runId).toBe("RUN1");
    expect(result.dryRun).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.planned).toHaveLength(2);
    expect(existsSync(join(baselineDir, "components/Button/default@1280.png"))).toBe(false);
  });

  it("approves a target so a later diff against the new baseline is clean (0 regressions)", async () => {
    const result = runBaseline(config, { target: "Button", outRoot, baselineDir });
    expect(result.written.sort()).toEqual([
      "components/Button/default@1280.png",
      "components/Button/hover@1280.png",
    ]);
    // The sign-off property: current now equals baseline byte-for-byte → ratio 0.
    const key = "components/Button/hover@1280.png";
    const diff = await diffImages(
      readFileSync(join(baselineDir, key)),
      readFileSync(join(currentDir, key)),
      config.threshold,
    );
    expect(diff.ratio).toBe(0);
  });

  it("defaults to the latest run when --run is omitted", () => {
    // add a newer run; runBaseline should pick it
    put(join(runsDir, "RUN2", "current"), "components/Button/default@1280.png", "patch-2x2.png");
    const result = runBaseline(config, { target: "Button", outRoot, baselineDir });
    expect(result.runId).toBe("RUN2");
  });

  it("refuses to overwrite existing baselines without --confirmed (script-enforced gate)", () => {
    put(baselineDir, "components/Button/default@1280.png", "solid-10x10.png"); // existing
    // --overwrite alone is not enough to replace a committed baseline
    expect(() =>
      runBaseline(config, { target: "Button", outRoot, baselineDir, overwrite: true }),
    ).toThrow(/confirmation required/);
    // the existing baseline is untouched
    const diff = readFileSync(join(baselineDir, "components/Button/default@1280.png"));
    expect(diff.equals(fixture("solid-10x10.png"))).toBe(true);
  });

  it("overwrites existing baselines only when overwrite AND confirmed are both set", () => {
    put(baselineDir, "components/Button/default@1280.png", "solid-10x10.png");
    const result = runBaseline(config, {
      target: "Button",
      outRoot,
      baselineDir,
      overwrite: true,
      confirmed: true,
    });
    expect(result.written.sort()).toEqual([
      "components/Button/default@1280.png",
      "components/Button/hover@1280.png",
    ]);
  });

  it("records a failed copy without aborting the rest of the sign-off", () => {
    const plan = planBaseline(currentDir, baselineDir, "Button"); // 2 copies, both sources present
    // a source vanishes after planning, before the copy
    rmSync(join(currentDir, "components/Button/hover@1280.png"));
    const result = applyBaseline(plan, baselineDir, { overwrite: false });
    expect(result.written).toEqual(["components/Button/default@1280.png"]);
    expect(result.failed.map((f) => f.key)).toEqual(["components/Button/hover@1280.png"]);
    expect(existsSync(join(baselineDir, "components/Button/default@1280.png"))).toBe(true);
  });

  it("throws when no target matches", () => {
    expect(() => runBaseline(config, { target: "Nonexistent", outRoot, baselineDir })).toThrow(
      /no renders matched/,
    );
  });

  it("throws when there are no runs to approve", () => {
    rmSync(runsDir, { recursive: true, force: true });
    expect(() => runBaseline(config, { target: "Button", outRoot, baselineDir })).toThrow(
      /no runs/,
    );
  });
});
