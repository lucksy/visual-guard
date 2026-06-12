import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, loadConfig } from "../scripts/lib/config";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const shippedConfig = join(repoRoot, "config", "visual.config.json");

const minimal = { targets: [{ type: "storybook", url: "http://localhost:6006" }] };

describe("parseConfig — defaults", () => {
  it("fills every optional field from defaults when only targets is given", () => {
    const cfg = parseConfig(minimal);
    expect(cfg.detect).toBe("auto");
    expect(cfg.viewports).toEqual([375, 768, 1280]);
    expect(cfg.states).toEqual(["default", "hover", "disabled"]);
    expect(cfg.threshold).toBe(0.1);
    expect(cfg.maxDiffRatio).toBe(0.01);
    expect(cfg.baselineDir).toBe(".visual-baselines");
    expect(cfg.uiGlobs).toEqual(["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss}"]);
    expect(cfg.tokens).toEqual({ source: "src/styles/tokens.css" });
  });

  it("preserves explicitly provided values instead of overwriting with defaults", () => {
    const cfg = parseConfig({
      ...minimal,
      viewports: [320],
      threshold: 0.25,
      states: ["default"],
      baselineDir: "custom-baselines",
    });
    expect(cfg.viewports).toEqual([320]);
    expect(cfg.threshold).toBe(0.25);
    expect(cfg.states).toEqual(["default"]);
    expect(cfg.baselineDir).toBe("custom-baselines");
  });

  it("keeps app-target routes", () => {
    const cfg = parseConfig({
      targets: [{ type: "app", url: "http://localhost:3000", routes: ["/login"] }],
    });
    expect(cfg.targets[0]).toEqual({
      type: "app",
      url: "http://localhost:3000",
      routes: ["/login"],
    });
  });
});

describe("parseConfig — validation (actionable, names the field)", () => {
  it("throws when the root is not an object", () => {
    expect(() => parseConfig(null)).toThrow(/config/i);
    expect(() => parseConfig("nope")).toThrow(/object/i);
  });

  it("throws naming targets when it is missing", () => {
    expect(() => parseConfig({})).toThrow(/targets/);
  });

  it("throws naming targets when it is empty", () => {
    expect(() => parseConfig({ targets: [] })).toThrow(/targets/);
  });

  it("throws naming the target type when invalid", () => {
    expect(() => parseConfig({ targets: [{ type: "native", url: "x" }] })).toThrow(/type/);
  });

  it("throws naming url when a target has none", () => {
    expect(() => parseConfig({ targets: [{ type: "storybook" }] })).toThrow(/url/);
  });

  it("throws naming threshold when out of the 0..1 range", () => {
    expect(() => parseConfig({ ...minimal, threshold: 5 })).toThrow(/threshold/);
  });

  it("throws naming maxDiffRatio when not a number", () => {
    expect(() => parseConfig({ ...minimal, maxDiffRatio: "high" })).toThrow(/maxDiffRatio/);
  });

  it("throws naming detect when it is an unknown mode", () => {
    expect(() => parseConfig({ ...minimal, detect: "guess" })).toThrow(/detect/);
  });

  it("throws naming viewports when it holds a non-positive number", () => {
    expect(() => parseConfig({ ...minimal, viewports: [0] })).toThrow(/viewports/);
  });
});

describe("loadConfig — file I/O", () => {
  it("loads and validates the shipped default config", () => {
    const cfg = loadConfig(shippedConfig);
    expect(cfg.detect).toBe("auto");
    expect(cfg.targets.length).toBeGreaterThan(0);
    expect(cfg.threshold).toBe(0.1);
    expect(cfg.maxDiffRatio).toBe(0.01);
  });

  it("throws an actionable error when the file is missing", () => {
    expect(() => loadConfig(join(repoRoot, "config", "does-not-exist.json"))).toThrow(
      /does-not-exist\.json/,
    );
  });
});
