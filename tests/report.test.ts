import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig, type Config } from "../scripts/lib/config";
import type { CompareResult, ComparisonStatus, ImageComparison } from "../scripts/compare";
import {
  buildManifest,
  gatherChangedFiles,
  globToRegExp,
  parseKey,
  report,
  type Manifest,
} from "../scripts/report";

const config: Config = parseConfig({
  targets: [{ type: "storybook", url: "http://localhost:6006" }],
  threshold: 0.1,
  maxDiffRatio: 0.01,
});

// --- Pure helpers ---------------------------------------------------------

describe("parseKey", () => {
  it("splits instance / target / state@viewport", () => {
    expect(parseKey("components/Button/Primary@1280.png")).toEqual({
      instance: "components",
      target: "Button",
      state: "Primary",
      viewport: 1280,
    });
  });

  it("handles an app route key", () => {
    expect(parseKey("web/user-settings/default@375.png")).toEqual({
      instance: "web",
      target: "user-settings",
      state: "default",
      viewport: 375,
    });
  });
});

describe("globToRegExp / gatherChangedFiles", () => {
  it("matches brace-extension globs across nested paths", () => {
    const re = globToRegExp("**/*.{tsx,jsx,vue,svelte}");
    expect(re.test("src/components/Button.tsx")).toBe(true);
    expect(re.test("Button.jsx")).toBe(true);
    expect(re.test("styles.css")).toBe(false);
  });

  it("keeps only UI files, de-duplicated and sorted", () => {
    expect(
      gatherChangedFiles(
        ["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss}"],
        ["src/Button.tsx", "a/b/x.css", "README.md", "Button.jsx", "notes.txt", "src/Button.tsx"],
      ),
    ).toEqual(["Button.jsx", "a/b/x.css", "src/Button.tsx"]);
  });
});

// --- buildManifest --------------------------------------------------------

function image(key: string, status: ComparisonStatus, over: Partial<ImageComparison> = {}): ImageComparison {
  const blank = status === "new" || status === "error";
  return {
    key,
    status,
    ratio: blank ? null : 0,
    changedPixels: blank ? null : 0,
    totalPixels: blank ? null : 100,
    dimensionDelta: null,
    regions: [],
    baselinePath: status === "new" ? null : `.visual-baselines/${key}`,
    currentPath: `current/${key}`,
    diffPath: blank ? null : `diff/${key}`,
    error: status === "error" ? "could not decode image" : null,
    ...over,
  };
}

function compareFixture(): CompareResult {
  const results: ImageComparison[] = [
    image("components/Button/default@1280.png", "pass"),
    image("components/Button/hover@1280.png", "fail", {
      ratio: 0.04,
      changedPixels: 4,
      regions: [{ x: 0, y: 0, width: 2, height: 2 }],
    }),
    image("components/Card/default@1280.png", "new"),
    image("icons/Star/default@1280.png", "error"),
    image("web/login/default@375.png", "pass"),
  ];
  return {
    runId: "RUN1",
    results,
    summary: {
      total: results.length,
      added: results.filter((r) => r.status === "new").length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
      errored: results.filter((r) => r.status === "error").length,
    },
  };
}

const CHANGED = ["src/components/Button.tsx", "src/components/button.css", "src/Card.tsx"];

const RUN_DIR = ".visual-guard/runs/RUN1";

describe("buildManifest", () => {
  const manifest = buildManifest(compareFixture(), CHANGED, config, {
    generatedAt: "2026-06-13T00:00:00.000Z",
    runDir: RUN_DIR,
  });

  it("groups per-image results into per-target entries (instance/target)", () => {
    expect(manifest.targets.map((t) => `${t.instance}/${t.target}`)).toEqual([
      "components/Button",
      "components/Card",
      "icons/Star",
      "web/login",
    ]);
    const button = manifest.targets.find((t) => t.target === "Button");
    expect(button?.images.map((i) => i.state)).toEqual(["default", "hover"]);
  });

  it("rolls each target up to its worst status (fail > error > new > pass)", () => {
    const status = (target: string) => manifest.targets.find((t) => t.target === target)?.status;
    expect(status("Button")).toBe("fail"); // pass + fail → fail
    expect(status("Card")).toBe("new");
    expect(status("Star")).toBe("error");
    expect(status("login")).toBe("pass");
  });

  it("attaches changed files to a target by name heuristic", () => {
    const button = manifest.targets.find((t) => t.target === "Button");
    expect(button?.changedFiles).toEqual(["src/components/Button.tsx", "src/components/button.css"]);
    expect(manifest.targets.find((t) => t.target === "Star")?.changedFiles).toEqual([]);
  });

  it("matches a target name as a whole token, not a loose substring (Card != Dashcard)", () => {
    const m = buildManifest(
      compareFixture(),
      ["src/Dashcard/Wizard.tsx", "src/components/Card.tsx"],
      config,
      { generatedAt: "2026-06-13T00:00:00.000Z", runDir: RUN_DIR },
    );
    expect(m.targets.find((t) => t.target === "Card")?.changedFiles).toEqual([
      "src/components/Card.tsx",
    ]);
  });

  it("rebases current/diff paths onto the run dir (single project-root anchor)", () => {
    const img = manifest.targets
      .find((t) => t.target === "Button")
      ?.images.find((i) => i.state === "hover");
    expect(img?.currentPath).toBe(`${RUN_DIR}/current/components/Button/hover@1280.png`);
    expect(img?.diffPath).toBe(`${RUN_DIR}/diff/components/Button/hover@1280.png`);
    expect(img?.baselinePath).toBe(".visual-baselines/components/Button/hover@1280.png");
    expect(manifest.runDir).toBe(RUN_DIR);
  });

  it("leaves a per-image verdict placeholder and echoes gates + summary", () => {
    expect(manifest.targets.every((t) => t.images.every((i) => i.verdict === null))).toBe(true);
    expect(manifest.gates).toEqual({ threshold: 0.1, maxDiffRatio: 0.01 });
    expect(manifest.summary).toEqual({ targets: 4, images: 5, pass: 2, fail: 1, new: 1, error: 1 });
    expect(manifest.version).toBe(1);
  });

  it("matches the locked golden manifest shape (R6 — contract can't drift)", () => {
    expect(manifest).toMatchSnapshot();
  });
});

// --- report() I/O ---------------------------------------------------------

describe("report", () => {
  const tmps: string[] = [];
  afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("reads compare.json, filters changed files by uiGlobs, and writes manifest.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vg-report-"));
    tmps.push(tmp);
    const runDir = join(tmp, ".visual-guard", "runs", "RUN1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "compare.json"), JSON.stringify(compareFixture()));

    const result = report(
      config,
      { runId: "RUN1", outRoot: join(tmp, ".visual-guard") },
      {
        // a mix of UI and non-UI changes; only UI files should survive
        listChangedFiles: () => ["src/components/Button.tsx", "README.md", "src/components/button.css"],
        now: () => new Date("2026-06-13T00:00:00.000Z"),
      },
    );

    const onDisk = JSON.parse(readFileSync(result.manifestPath, "utf8")) as Manifest;
    expect(onDisk).toEqual(result.manifest);
    expect(onDisk.changedFiles).toEqual(["src/components/Button.tsx", "src/components/button.css"]);
    expect(onDisk.runId).toBe("RUN1");
    expect(onDisk.summary.targets).toBe(4);
  });

  it("throws an actionable error when compare.json is missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vg-report-"));
    tmps.push(tmp);
    expect(() =>
      report(config, { runId: "nope", outRoot: join(tmp, ".visual-guard") }, {
        listChangedFiles: () => [],
        now: () => new Date(),
      }),
    ).toThrow(/no compare\.json/);
  });
});
