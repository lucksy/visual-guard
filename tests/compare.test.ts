import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseConfig, type Config } from "../scripts/lib/config";
import {
  classify,
  compareRun,
  isSafeKey,
  parseArgs,
  walkPngFiles,
  type CompareResult,
} from "../scripts/compare";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): Buffer => readFileSync(join(fixtures, name));

// --- Pure helpers ---------------------------------------------------------

describe("classify", () => {
  it("fails when the ratio exceeds the gate", () => {
    expect(classify(0.5, null, 0.01)).toBe("fail");
  });

  it("passes when the ratio is at or under the gate", () => {
    expect(classify(0.005, null, 0.01)).toBe("pass");
    expect(classify(0.01, null, 0.01)).toBe("pass");
  });

  it("fails on any dimension change regardless of ratio", () => {
    expect(classify(0, { width: -2, height: 0 }, 0.01)).toBe("fail");
  });
});

describe("parseArgs", () => {
  it("requires --run", () => {
    expect(() => parseArgs([])).toThrow(/--run/);
  });

  it("reads --config, --run, --baseline", () => {
    expect(parseArgs(["--run", "R", "--config", "c.json", "--baseline", "b"])).toEqual({
      config: "c.json",
      runId: "R",
      baselineDir: "b",
    });
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgs(["--run", "R", "--nope"])).toThrow(/unknown argument/);
  });
});

describe("walkPngFiles", () => {
  it("lists png files recursively as sorted posix keys, ignoring non-png", () => {
    const dir = mkdtempSync(join(tmpdir(), "vg-walk-"));
    const put = (key: string): void => {
      const path = join(dir, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from("x"));
    };
    put("a/x@2.png");
    put("a/b/c@1.png");
    put("a/notes.txt");
    expect(walkPngFiles(dir)).toEqual(["a/b/c@1.png", "a/x@2.png"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] for a missing directory", () => {
    expect(walkPngFiles(join(tmpdir(), "vg-does-not-exist-xyz"))).toEqual([]);
  });

  it("does not crash on a broken symlink and skips it (no follow)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vg-link-"));
    writeFileSync(join(dir, "real@1.png"), Buffer.from("x"));
    symlinkSync(join(dir, "nonexistent-target.png"), join(dir, "broken@2.png"));
    expect(() => walkPngFiles(dir)).not.toThrow();
    expect(walkPngFiles(dir)).toEqual(["real@1.png"]); // broken symlink skipped
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("isSafeKey", () => {
  it("accepts ordinary relative keys", () => {
    expect(isSafeKey("components/Button/Primary@1280.png")).toBe(true);
  });

  it("rejects traversal, absolute, and NUL-byte keys", () => {
    expect(isSafeKey("../../etc/passwd.png")).toBe(false);
    expect(isSafeKey("a/../b.png")).toBe(false);
    expect(isSafeKey("/abs/x.png")).toBe(false);
    expect(isSafeKey("a\0b.png")).toBe(false);
    expect(isSafeKey("")).toBe(false);
  });
});

// --- compareRun integration (real fixtures, real diff) --------------------

describe("compareRun", () => {
  let tmp = "";
  let baselineDir = "";
  let outRoot = "";
  const config: Config = parseConfig({
    targets: [{ type: "storybook", url: "http://localhost:6006" }],
    threshold: 0.1,
    maxDiffRatio: 0.01,
  });

  const get = (result: CompareResult, key: string) => result.results.find((r) => r.key === key);

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-cmp-"));
    outRoot = join(tmp, ".visual-guard");
    baselineDir = join(tmp, "baselines");
    const currentDir = join(outRoot, "runs", "R", "current");
    const put = (root: string, key: string, name: string): void => {
      const path = join(root, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, fixture(name));
    };
    // unchanged → pass
    put(currentDir, "comp/Button/default@1280.png", "solid-10x10.png");
    put(baselineDir, "comp/Button/default@1280.png", "solid-10x10.png");
    // changed over the gate → fail
    put(currentDir, "comp/Button/hover@1280.png", "patch-2x2.png");
    put(baselineDir, "comp/Button/hover@1280.png", "solid-10x10.png");
    // dimension change → fail
    put(currentDir, "comp/Button/wide@1280.png", "solid-8x10.png");
    put(baselineDir, "comp/Button/wide@1280.png", "solid-10x10.png");
    // no baseline → new
    put(currentDir, "icons/Star/default@1280.png", "solid-10x10.png");
    // undecodable current render (baseline present) → error, run continues
    const corrupt = join(currentDir, "comp/Bad/default@1280.png");
    mkdirSync(dirname(corrupt), { recursive: true });
    writeFileSync(corrupt, Buffer.from("THIS IS NOT A PNG"));
    put(baselineDir, "comp/Bad/default@1280.png", "solid-10x10.png");
  });

  afterAll(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("classifies unchanged / changed / dimension / new and writes diff PNGs", async () => {
    const result = await compareRun(config, { runId: "R", outRoot, baselineDir });

    const pass = get(result, "comp/Button/default@1280.png");
    expect(pass?.status).toBe("pass");
    expect(pass?.ratio).toBe(0);

    const changed = get(result, "comp/Button/hover@1280.png");
    expect(changed?.status).toBe("fail");
    expect(changed?.ratio ?? 0).toBeGreaterThan(0.01);
    expect(changed?.regions.length).toBeGreaterThan(0);

    const dim = get(result, "comp/Button/wide@1280.png");
    expect(dim?.status).toBe("fail");
    expect(dim?.dimensionDelta).toEqual({ width: -2, height: 0 });

    const added = get(result, "icons/Star/default@1280.png");
    expect(added?.status).toBe("new");
    expect(added?.ratio).toBeNull();
    expect(added?.baselinePath).toBeNull();
    expect(added?.diffPath).toBeNull();

    // an undecodable render is reported with context, not crashed on
    const bad = get(result, "comp/Bad/default@1280.png");
    expect(bad?.status).toBe("error");
    expect(bad?.error).toBeTruthy();
    expect(bad?.diffPath).toBeNull();

    // recorded paths are relative/portable (no absolute machine prefix)
    expect(changed?.currentPath).toBe("current/comp/Button/hover@1280.png");
    expect(changed?.diffPath).toBe("diff/comp/Button/hover@1280.png");

    // diff PNGs written only for successfully-compared renders
    expect(existsSync(join(outRoot, "runs", "R", "diff", "comp/Button/hover@1280.png"))).toBe(true);
    expect(existsSync(join(outRoot, "runs", "R", "diff", "icons/Star/default@1280.png"))).toBe(false);
    expect(existsSync(join(outRoot, "runs", "R", "diff", "comp/Bad/default@1280.png"))).toBe(false);

    expect(result.summary).toEqual({ total: 5, added: 1, passed: 1, failed: 2, errored: 1 });

    // per-image results persisted even though one render errored
    const compareJson = JSON.parse(
      readFileSync(join(outRoot, "runs", "R", "compare.json"), "utf8"),
    ) as CompareResult;
    expect(compareJson.summary).toEqual(result.summary);
  });

  it("throws when current/ exists but is not a directory", async () => {
    const fileRun = join(outRoot, "runs", "asfile");
    mkdirSync(fileRun, { recursive: true });
    writeFileSync(join(fileRun, "current"), Buffer.from("not a dir"));
    await expect(compareRun(config, { runId: "asfile", outRoot, baselineDir })).rejects.toThrow(
      /not a directory/,
    );
  });

  it("throws an actionable error when the run has no current/ directory", async () => {
    await expect(
      compareRun(config, { runId: "missing", outRoot, baselineDir }),
    ).rejects.toThrow(/no captured renders/);
  });
});
