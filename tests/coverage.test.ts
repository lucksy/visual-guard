import { describe, it, expect } from "vitest";
import { parseConfig } from "../scripts/lib/config";
import type { RenderTarget } from "../scripts/lib/targets";
import { renderRelPath } from "../scripts/capture";
import {
  buildCoverage,
  parseArgs,
  renderCoverageText,
  renderKey,
  runCoverage,
} from "../scripts/coverage";

const mk = (name: string, state: string, viewport: number, instance = "sample"): RenderTarget => ({
  instance,
  name,
  state,
  viewport,
  url: "http://localhost:3000/",
  kind: "app",
});

describe("renderKey", () => {
  it("stays in lockstep with capture.ts renderRelPath (drift guard)", () => {
    const render = mk("Button", "hover", 1280);
    expect(renderKey(render)).toBe(renderRelPath(render));
    expect(renderKey(render)).toBe("sample/Button/hover@1280.png");
  });
});

describe("buildCoverage", () => {
  it("reports covered cells, gaps, and orphans", () => {
    const renders = [
      mk("Button", "default", 375),
      mk("Button", "default", 1280),
      mk("Button", "hover", 375),
      mk("Button", "hover", 1280),
    ];
    const baselineKeys = [
      "sample/Button/default@375.png",
      "sample/Button/default@1280.png",
      "sample/Button/hover@375.png",
      // hover@1280 is missing → a gap
      "sample/Old/default@375.png", // not expected → an orphan
    ];

    const map = buildCoverage(renders, baselineKeys);
    expect(map.summary).toEqual({ targets: 1, expected: 4, covered: 3, gaps: 1, orphans: 1 });
    expect(map.targets[0]?.gaps).toEqual([{ state: "hover", viewport: 1280 }]);
    expect(map.orphans).toEqual(["sample/Old/default@375.png"]);
  });

  it("groups by instance/target and reports a fully-covered target with no gaps", () => {
    const renders = [mk("Badge", "default", 400), mk("Button", "default", 400)];
    const map = buildCoverage(renders, [
      "sample/Badge/default@400.png",
      "sample/Button/default@400.png",
    ]);
    expect(map.summary).toMatchObject({ targets: 2, expected: 2, covered: 2, gaps: 0, orphans: 0 });
    expect(map.targets.every((t) => t.gaps.length === 0)).toBe(true);
  });

  it("collapses a duplicate render key to a single cell (capture writes one PNG per key)", () => {
    const renders = [mk("Button", "default", 375), mk("Button", "default", 375)];
    const map = buildCoverage(renders, []);
    expect(map.summary.expected).toBe(1);
    expect(map.targets[0]?.cells).toHaveLength(1);
  });

  it("reports everything as a gap when there are no baselines", () => {
    const map = buildCoverage([mk("Button", "default", 375)], []);
    expect(map.summary).toMatchObject({ expected: 1, covered: 0, gaps: 1 });
  });
});

describe("runCoverage", () => {
  it("resolves an app config offline and crosses it with injected baseline keys", async () => {
    const config = parseConfig({
      targets: [
        { type: "app", name: "sample", url: "http://localhost:3000", routes: ["/button", "/badge"] },
      ],
      viewports: [375, 1280],
      states: ["default", "hover"],
      baselineDir: ".visual-baselines",
    });

    // 2 routes × 2 viewports × 2 states = 8 expected; supply 6 + 1 orphan.
    const baselineKeys = [
      "sample/button/default@375.png",
      "sample/button/default@1280.png",
      "sample/button/hover@375.png",
      "sample/button/hover@1280.png",
      "sample/badge/default@375.png",
      "sample/badge/default@1280.png",
      "sample/stale/default@375.png",
    ];
    const map = await runCoverage(
      config,
      { baselineDir: ".visual-baselines" },
      { walk: () => baselineKeys },
    );
    expect(map.summary).toMatchObject({ targets: 2, expected: 8, covered: 6, gaps: 2, orphans: 1 });
    expect(map.orphans).toEqual(["sample/stale/default@375.png"]);
    const badge = map.targets.find((t) => t.target === "badge");
    expect(badge?.gaps).toEqual([
      { state: "hover", viewport: 375 },
      { state: "hover", viewport: 1280 },
    ]);
  });
});

describe("renderCoverageText", () => {
  it("renders a per-target matrix with covered/gap marks", () => {
    const map = buildCoverage(
      [mk("Button", "default", 375), mk("Button", "default", 1280)],
      ["sample/Button/default@375.png"],
    );
    const text = renderCoverageText(map, ".visual-baselines");
    expect(text).toContain("1/2 cell(s) covered");
    expect(text).toContain("sample/Button");
    // The matrix row for the "default" state: covered (x) at 375, gap (.) at 1280.
    expect(text).toContain("default  x  .");
  });

  it("lists orphan baselines", () => {
    const map = buildCoverage([mk("Button", "default", 375)], [
      "sample/Button/default@375.png",
      "sample/Gone/default@375.png",
    ]);
    expect(renderCoverageText(map, ".bl")).toContain("sample/Gone/default@375.png");
  });
});

describe("parseArgs", () => {
  it("reads flags and defaults", () => {
    expect(parseArgs([])).toEqual({
      config: "config/visual.config.json",
      baselineDir: undefined,
      json: false,
    });
    expect(parseArgs(["--config", "c.json", "--baseline", "bl", "--json"])).toEqual({
      config: "c.json",
      baselineDir: "bl",
      json: true,
    });
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });
});
