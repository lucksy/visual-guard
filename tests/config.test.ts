import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, loadConfig, parseFigma, parseStudio } from "../scripts/lib/config";

const FIGMA_KEY = "AbCdEf1234567890"; // 16-char base62 — a representative Figma file key
const FIGMA_KEY_2 = "Zz9Yy8Xx7Ww6Vv5U"; // a second 16-char base62 key

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
    expect(cfg.uiGlobs).toEqual(["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss,sass,less,styl,pcss}"]);
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

  it("accepts a positive-integer concurrency and omits it when absent", () => {
    expect(parseConfig({ ...minimal, concurrency: 12 }).concurrency).toBe(12);
    expect(parseConfig(minimal).concurrency).toBeUndefined();
  });

  it("throws naming concurrency when it is not a positive integer", () => {
    expect(() => parseConfig({ ...minimal, concurrency: 0 })).toThrow(/concurrency/);
    expect(() => parseConfig({ ...minimal, concurrency: 2.5 })).toThrow(/concurrency/);
    expect(() => parseConfig({ ...minimal, concurrency: "lots" })).toThrow(/concurrency/);
  });
});

describe("parseConfig — scope block (change-scoped knobs)", () => {
  it("defaults the scope block when absent", () => {
    expect(parseConfig(minimal).scope).toEqual({
      fanoutThreshold: 0.4,
      fanoutMinStories: 8,
      globalGlobs: [],
      fingerprintSkip: false,
    });
  });

  it("parses fanoutThreshold / fanoutMinStories / globalGlobs / fingerprintSkip", () => {
    const cfg = parseConfig({
      ...minimal,
      scope: { fanoutThreshold: 0.6, fanoutMinStories: 20, globalGlobs: ["**/theme/**"], fingerprintSkip: true },
    });
    expect(cfg.scope).toEqual({
      fanoutThreshold: 0.6,
      fanoutMinStories: 20,
      globalGlobs: ["**/theme/**"],
      fingerprintSkip: true,
    });
  });

  it("validates scope fields, naming the offender", () => {
    expect(() => parseConfig({ ...minimal, scope: { fanoutThreshold: 2 } })).toThrow(/scope\.fanoutThreshold/);
    expect(() => parseConfig({ ...minimal, scope: { fanoutMinStories: 0 } })).toThrow(/scope\.fanoutMinStories/);
    expect(() => parseConfig({ ...minimal, scope: { globalGlobs: "x" } })).toThrow(/scope\.globalGlobs/);
    expect(() => parseConfig({ ...minimal, scope: "nope" })).toThrow(/scope/);
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

describe("parseConfig — figma (additive, backward-compatible, no token)", () => {
  it("a config with no figma block has no figma key (code-only mode is byte-identical)", () => {
    const cfg = parseConfig(minimal);
    expect("figma" in cfg).toBe(false);
    expect(Object.keys(cfg).sort()).toEqual([
      "baselineDir",
      "detect",
      "maxDiffRatio",
      "scope", // always defaulted (Phase 3)
      "states",
      "studio", // always defaulted (P5)
      "targets",
      "threshold",
      "tokens",
      "uiGlobs",
      "viewports",
    ]);
  });

  it("defaults studio retention and validates an explicit block (P5)", () => {
    expect(parseConfig(minimal).studio).toEqual({
      retainPerSource: 20,
      retainCurrent: 3,
      pruneOrphanBlobs: true,
    });
    expect(parseStudio(undefined)).toEqual({ retainPerSource: 20, retainCurrent: 3, pruneOrphanBlobs: true });
    expect(parseStudio({ retainPerSource: 5 })).toEqual({
      retainPerSource: 5,
      retainCurrent: 3,
      pruneOrphanBlobs: true,
    });
    expect(parseStudio({ retainCurrent: 1, pruneOrphanBlobs: false })).toEqual({
      retainPerSource: 20,
      retainCurrent: 1,
      pruneOrphanBlobs: false,
    });
  });

  it("rejects invalid studio retention values", () => {
    expect(() => parseStudio({ retainPerSource: 0 })).toThrow(/retainPerSource/);
    expect(() => parseStudio({ retainPerSource: 2.5 })).toThrow(/retainPerSource/);
    expect(() => parseStudio({ retainCurrent: -1 })).toThrow(/retainCurrent/);
    expect(() => parseStudio({ pruneOrphanBlobs: "yes" })).toThrow(/pruneOrphanBlobs/);
    expect(() => parseStudio(42)).toThrow(/studio/);
  });

  it("normalizes a bare file-key string to a one-element files list", () => {
    const cfg = parseConfig({ ...minimal, figma: FIGMA_KEY });
    expect(cfg.figma).toEqual({ files: [{ key: FIGMA_KEY }] });
  });

  it("accepts the { fileKey } single-file shorthand object", () => {
    const cfg = parseConfig({ ...minimal, figma: { fileKey: FIGMA_KEY } });
    expect(cfg.figma).toEqual({ files: [{ key: FIGMA_KEY }] });
  });

  it("validates a full files[] block with labels and a componentMap", () => {
    const cfg = parseConfig({
      ...minimal,
      figma: {
        files: [
          { key: FIGMA_KEY, label: "Core" },
          { key: FIGMA_KEY_2 },
        ],
        componentMap: { BtnPrimary: "Button" },
      },
    });
    expect(cfg.figma).toEqual({
      files: [
        { key: FIGMA_KEY, label: "Core" },
        { key: FIGMA_KEY_2 },
      ],
      componentMap: { BtnPrimary: "Button" },
    });
  });

  it("extracts the file key from a pasted Figma URL (in a bare string and in files[].key)", () => {
    const url = `https://www.figma.com/design/${FIGMA_KEY}/Acme?node-id=0-1`;
    expect(parseConfig({ ...minimal, figma: url }).figma).toEqual({ files: [{ key: FIGMA_KEY }] });
    expect(
      parseConfig({ ...minimal, figma: { files: [{ key: url, label: "Core" }] } }).figma,
    ).toEqual({ files: [{ key: FIGMA_KEY, label: "Core" }] });
  });

  it("accepts bare files[] entry strings (key or URL)", () => {
    const cfg = parseConfig({ ...minimal, figma: { files: [FIGMA_KEY] } });
    expect(cfg.figma).toEqual({ files: [{ key: FIGMA_KEY }] });
  });

  it("rejects an empty files array", () => {
    expect(() => parseConfig({ ...minimal, figma: { files: [] } })).toThrow(/figma\.files/);
  });

  it("rejects a file entry missing a key (names the field)", () => {
    expect(() => parseConfig({ ...minimal, figma: { files: [{ label: "Core" }] } })).toThrow(
      /figma\.files\[0\]\.key/,
    );
  });

  it("rejects a file entry that is neither a string nor an object (names the field)", () => {
    expect(() => parseConfig({ ...minimal, figma: { files: [42] } })).toThrow(/figma\.files\[0\]/);
  });

  it("rejects setting both fileKey and files", () => {
    expect(() =>
      parseConfig({ ...minimal, figma: { fileKey: FIGMA_KEY, files: [{ key: FIGMA_KEY }] } }),
    ).toThrow(/fileKey.*files|files.*fileKey/);
  });

  it("rejects an object with neither files nor fileKey", () => {
    expect(() => parseConfig({ ...minimal, figma: { componentMap: {} } })).toThrow(/figma/);
  });

  it("rejects a Figma-looking URL with no extractable key (names the field)", () => {
    expect(() =>
      parseConfig({ ...minimal, figma: { files: [{ key: "https://www.figma.com/" }] } }),
    ).toThrow(/figma\.files\[0\]\.key/);
  });

  it("rejects a bare non-key string (not a URL, not base62 16–128)", () => {
    expect(() => parseConfig({ ...minimal, figma: "Button" })).toThrow(/figma/);
    expect(() => parseConfig({ ...minimal, figma: "my design system" })).toThrow(/figma/);
  });

  it("rejects a bare key carrying path-traversal characters (can't become a stored path segment)", () => {
    expect(() => parseConfig({ ...minimal, figma: "../../../etc/passwd" })).toThrow(/figma/);
    expect(() =>
      parseConfig({ ...minimal, figma: { files: [{ key: "../../escape" }] } }),
    ).toThrow(/figma\.files\[0\]\.key/);
  });

  it("rejects an over-long key (>128 chars)", () => {
    expect(() => parseConfig({ ...minimal, figma: "a".repeat(200) })).toThrow(/figma/);
  });

  it("rejects a Figma URL whose key segment is too short / garbage", () => {
    expect(() =>
      parseConfig({ ...minimal, figma: "https://www.figma.com/design/short/x" }),
    ).toThrow(/figma/);
  });

  it("rejects a Figma community URL (community/file is out of scope per SPEC §8)", () => {
    expect(() =>
      parseConfig({ ...minimal, figma: `https://www.figma.com/community/file/${FIGMA_KEY}/Mat` }),
    ).toThrow(/figma/);
  });

  it("rejects a componentMap whose value is not a non-empty string", () => {
    expect(() =>
      parseConfig({ ...minimal, figma: { files: [{ key: FIGMA_KEY }], componentMap: { X: 1 } } }),
    ).toThrow(/componentMap\.X/);
  });

  it("rejects a componentMap with an empty key", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        figma: { files: [{ key: FIGMA_KEY }], componentMap: { "": "Button" } },
      }),
    ).toThrow(/componentMap" keys/);
  });

  it("rejects a non-object componentMap", () => {
    expect(() =>
      parseConfig({ ...minimal, figma: { files: [{ key: FIGMA_KEY }], componentMap: "nope" } }),
    ).toThrow(/componentMap/);
  });

  it("rejects a non-string, non-object figma value", () => {
    expect(() => parseConfig({ ...minimal, figma: 42 })).toThrow(/figma/);
  });

  it("rejects a whitespace-only key", () => {
    expect(() => parseConfig({ ...minimal, figma: "   " })).toThrow(/figma.*non-empty|non-empty/);
  });
});

describe("parseFigma (direct)", () => {
  it("returns undefined when absent (code-only behavior)", () => {
    expect(parseFigma(undefined)).toBeUndefined();
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
