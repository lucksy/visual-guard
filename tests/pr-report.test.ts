import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, renderPrComment, writePrComment } from "../scripts/pr-report";
import type { ComparisonStatus } from "../scripts/compare";
import type { Manifest, ManifestImage, ManifestTarget, Verdict } from "../scripts/report";

function mkImage(overrides: Partial<ManifestImage> = {}): ManifestImage {
  return {
    state: "default",
    viewport: 1280,
    status: "pass",
    ratio: 0,
    dimensionDelta: null,
    regions: [],
    baselinePath: ".visual-baselines/sample/x/default@1280.png",
    currentPath: ".visual-guard/runs/RUN1/current/sample/x/default@1280.png",
    diffPath: null,
    error: null,
    verdict: null,
    renderTarget: null,
    currentDimensions: null,
    skipped: false,
    ...overrides,
  };
}

function mkTarget(
  target: string,
  status: ComparisonStatus,
  images: ManifestImage[],
  extra: Partial<ManifestTarget> = {},
): ManifestTarget {
  return { instance: "sample", target, status, changedFiles: [], images, ...extra };
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
      images: targets.reduce((n, t) => n + t.images.length, 0),
      pass: by("pass"),
      fail: by("fail"),
      new: by("new"),
      error: by("error"),
      skipped: 0,
    },
    targets,
  };
}

const verdict: Verdict = {
  severity: "high",
  classification: "design-system-violation",
  issue: "Button padding grew because the spacing token was inlined",
  file: "src/Button.css",
  line: 12,
  cause: "padding: 48px 40px replaces var(--vg-space-pad)",
  impact: ["off-system spacing", "taller button"],
  fix: "restore padding: var(--vg-space-pad)",
};

describe("renderPrComment", () => {
  it("renders a blocking report with evidence before the verdict", () => {
    const manifest = mkManifest([
      mkTarget(
        "Button",
        "fail",
        [
          mkImage({
            status: "fail",
            ratio: 0.0318,
            dimensionDelta: { width: 0, height: 4 },
            regions: [{ x: 0, y: 0, width: 10, height: 10 }],
            diffPath: ".visual-guard/runs/RUN1/diff/sample/Button/default@1280.png",
            verdict,
          }),
        ],
        { changedFiles: ["src/Button.css"] },
      ),
      mkTarget("Badge", "pass", [mkImage()]),
    ]);

    const md = renderPrComment(manifest);

    // Header + gate line.
    expect(md).toContain("## Visual Guard — 1 blocking change");
    expect(md).toContain("1 fail, 0 new, 0 error, 1 pass → BLOCKED");
    // Summary table has both targets.
    expect(md).toContain("| `sample/Button` | fail |");
    expect(md).toContain("| `sample/Badge` | pass |");
    // Evidence first.
    expect(md).toContain("ratio **3.18%** (gate 1.00%)");
    expect(md).toContain("dimension **+0×+4 px**");
    expect(md).toContain("1 changed region(s)");
    expect(md).toContain("diff: `.visual-guard/runs/RUN1/diff/sample/Button/default@1280.png`");
    // Verdict second, with file:line.
    expect(md).toContain("**design-system-violation (high)**");
    expect(md).toContain("`src/Button.css:12`");
    expect(md).toContain("fix: restore padding: var(--vg-space-pad)");
    // Changed files + local-only footer.
    expect(md).toContain("**Changed files:** `src/Button.css`");
    expect(md).toContain("no screenshots are uploaded");
  });

  it("renders a clean report when nothing is flagged", () => {
    const md = renderPrComment(mkManifest([mkTarget("Badge", "pass", [mkImage()])]));
    expect(md).toContain("## Visual Guard — 0 regressions");
    expect(md).toContain("→ clean");
    expect(md).toContain("All 1 target(s) match their baseline.");
    // No detail section for a passing target.
    expect(md).not.toContain("### ");
  });

  it("treats a `new` target as flagged but not a verdict-bearing detail", () => {
    const md = renderPrComment(mkManifest([mkTarget("Fresh", "new", [mkImage({ status: "new" })])]));
    expect(md).toContain("## Visual Guard");
    expect(md).toContain("| `sample/Fresh` | new |");
    expect(md).toContain("no baseline yet");
  });

  it("respects allowNew so a first-baseline run reads as clean", () => {
    const md = renderPrComment(mkManifest([mkTarget("Fresh", "new", [mkImage({ status: "new" })])]), {
      policy: { allowNew: true, allowError: false },
    });
    expect(md).toContain("## Visual Guard — 0 regressions");
    expect(md).toContain("1 new allowed");
  });

  it("surfaces an error render's message", () => {
    const md = renderPrComment(
      mkManifest([
        mkTarget("Broken", "error", [mkImage({ status: "error", error: "could not decode PNG" })]),
      ]),
    );
    expect(md).toContain("| `sample/Broken` | error |");
    expect(md).toContain("could not decode PNG");
  });

  it("summary cell describes the flagged image, not a higher-ratio passing one (dimension-only fail)", () => {
    // A dimension-only fail (ratio 0) alongside a higher-ratio PASS image in the same target: the
    // summary cell must reflect the dimension regression, not the benign sub-gate pass ratio.
    const md = renderPrComment(
      mkManifest([
        mkTarget("Button", "fail", [
          mkImage({ state: "a", status: "pass", ratio: 0.005 }),
          mkImage({ state: "b", status: "fail", ratio: 0, dimensionDelta: { width: 0, height: 8 } }),
        ]),
      ]),
    );
    const row = md.split("\n").find((line) => line.includes("`sample/Button`"))!;
    expect(row).toContain("+0×+8 px");
    expect(row).not.toContain("0.50%"); // the passing image's ratio must not be shown as the change
  });

  it("verdict cell reflects the worst (flagged) image's verdict", () => {
    const md = renderPrComment(
      mkManifest([
        mkTarget("Button", "fail", [
          mkImage({ state: "a", status: "new", verdict: { ...verdict, classification: "intentional" } }),
          mkImage({ state: "b", status: "fail", ratio: 0.05, verdict: { ...verdict, classification: "bug" } }),
        ]),
      ]),
    );
    const row = md.split("\n").find((line) => line.includes("`sample/Button`"))!;
    expect(row).toContain("bug"); // the fail image drives the row
    expect(row).not.toContain("intentional");
  });
});

describe("parseArgs", () => {
  it("reads flags and defaults", () => {
    expect(parseArgs([])).toEqual({
      runId: undefined,
      outRoot: undefined,
      allowNew: false,
      allowError: false,
    });
    expect(parseArgs(["--run", "R", "--out", "x", "--allow-new", "--allow-error"])).toEqual({
      runId: "R",
      outRoot: "x",
      allowNew: true,
      allowError: true,
    });
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });
});

describe("writePrComment", () => {
  let tmp = "";
  let outRoot = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-pr-"));
    outRoot = join(tmp, ".visual-guard");
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("writes pr-comment.md into the run dir and returns its path + markdown", () => {
    const runDir = join(outRoot, "runs", "RUN1");
    mkdirSync(join(runDir, "current"), { recursive: true });
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify(mkManifest([mkTarget("Button", "fail", [mkImage({ status: "fail", ratio: 0.05 })])])),
    );

    const result = writePrComment({ runId: "RUN1", outRoot });
    expect(result.runId).toBe("RUN1");
    expect(result.path).toBe(join(runDir, "pr-comment.md"));
    const onDisk = readFileSync(result.path, "utf8");
    expect(onDisk).toBe(result.markdown);
    expect(onDisk).toContain("Visual Guard");
  });

  it("throws when the manifest is missing", () => {
    mkdirSync(join(outRoot, "runs", "RUN1", "current"), { recursive: true });
    expect(() => writePrComment({ runId: "RUN1", outRoot })).toThrow(/no manifest\.json/);
  });
});
