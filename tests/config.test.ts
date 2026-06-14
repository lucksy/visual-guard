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
    expect(cfg.tokens).toEqual({
      sources: [{ source: "src/styles/tokens.css", format: "auto" }],
    });
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

describe("parseConfig — optional per-target instance name", () => {
  it("preserves an explicit storybook target name", () => {
    const cfg = parseConfig({
      targets: [{ type: "storybook", url: "http://localhost:6006", name: "components" }],
    });
    expect(cfg.targets[0]).toEqual({
      type: "storybook",
      url: "http://localhost:6006",
      name: "components",
    });
  });

  it("preserves an explicit app target name alongside routes", () => {
    const cfg = parseConfig({
      targets: [{ type: "app", url: "http://localhost:3000", name: "admin", routes: ["/dash"] }],
    });
    expect(cfg.targets[0]).toEqual({
      type: "app",
      url: "http://localhost:3000",
      name: "admin",
      routes: ["/dash"],
    });
  });

  it("leaves name undefined when not provided", () => {
    const cfg = parseConfig(minimal);
    expect(cfg.targets[0]).toEqual({ type: "storybook", url: "http://localhost:6006" });
  });

  it("throws naming the field when name is not a non-empty string", () => {
    expect(() =>
      parseConfig({ targets: [{ type: "storybook", url: "http://x", name: "" }] }),
    ).toThrow(/name/);
    expect(() => parseConfig({ targets: [{ type: "app", url: "http://x", name: 7 }] })).toThrow(
      /name/,
    );
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

describe("parseConfig — tokens (multi-format, back-compat)", () => {
  it("normalizes a bare string path to one auto-detected source", () => {
    const cfg = parseConfig({ ...minimal, tokens: "src/theme.css" });
    expect(cfg.tokens).toEqual({ sources: [{ source: "src/theme.css", format: "auto" }] });
  });

  it("normalizes the legacy { source } form (Phase-0 back-compat)", () => {
    const cfg = parseConfig({ ...minimal, tokens: { source: "a/b.css" } });
    expect(cfg.tokens).toEqual({ sources: [{ source: "a/b.css", format: "auto" }] });
  });

  it("accepts multiple sources, mixing explicit format, auto, and bare strings", () => {
    const cfg = parseConfig({
      ...minimal,
      tokens: {
        sources: [
          { source: "tokens/base.tokens.json", format: "dtcg" },
          { source: "src/theme.css" },
          "src/extra.scss",
        ],
      },
    });
    expect(cfg.tokens.sources).toEqual([
      { source: "tokens/base.tokens.json", format: "dtcg" },
      { source: "src/theme.css", format: "auto" },
      { source: "src/extra.scss", format: "auto" },
    ]);
  });

  it("preserves mode, rootFontSize, and ignoreValues", () => {
    const cfg = parseConfig({
      ...minimal,
      tokens: {
        sources: [{ source: "t.json", format: "tokens-studio", mode: "dark", rootFontSize: 10 }],
        ignoreValues: ["0", "auto"],
      },
    });
    expect(cfg.tokens.sources[0]).toEqual({
      source: "t.json",
      format: "tokens-studio",
      mode: "dark",
      rootFontSize: 10,
    });
    expect(cfg.tokens.ignoreValues).toEqual(["0", "auto"]);
  });

  it("throws naming the field for an unknown format", () => {
    expect(() =>
      parseConfig({ ...minimal, tokens: { sources: [{ source: "x", format: "sass-maps" }] } }),
    ).toThrow(/format/);
  });

  it("throws when sources is an empty array", () => {
    expect(() => parseConfig({ ...minimal, tokens: { sources: [] } })).toThrow(/sources/);
  });

  it("throws naming source when a source object has no path", () => {
    expect(() => parseConfig({ ...minimal, tokens: { sources: [{ format: "css" }] } })).toThrow(
      /source/,
    );
  });

  it("rejects a JS-eval format unless allowJsEval is set", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        tokens: { sources: [{ source: "tailwind.config.js", format: "tailwind-config" }] },
      }),
    ).toThrow(/allowJsEval/);
  });

  it("allows a JS-eval format when allowJsEval is true", () => {
    const cfg = parseConfig({
      ...minimal,
      tokens: {
        allowJsEval: true,
        sources: [{ source: "tailwind.config.js", format: "tailwind-config" }],
      },
    });
    expect(cfg.tokens.allowJsEval).toBe(true);
    expect(cfg.tokens.sources[0]).toEqual({
      source: "tailwind.config.js",
      format: "tailwind-config",
    });
  });

  it("rejects setting both source and sources", () => {
    expect(() =>
      parseConfig({ ...minimal, tokens: { source: "a.css", sources: ["b.css"] } }),
    ).toThrow(/source/);
  });

  it("throws when allowJsEval is not a boolean", () => {
    expect(() => parseConfig({ ...minimal, tokens: { allowJsEval: "yes" } })).toThrow(
      /allowJsEval/,
    );
  });

  it("uses default sources when tokens is an object with only flags", () => {
    const cfg = parseConfig({ ...minimal, tokens: { allowJsEval: true } });
    expect(cfg.tokens.sources).toEqual([{ source: "src/styles/tokens.css", format: "auto" }]);
    expect(cfg.tokens.allowJsEval).toBe(true);
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
