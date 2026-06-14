import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  buildScaffoldConfig,
  candidatePorts,
  classifyTarget,
  detectTokenSources,
  scaffoldConfigObject,
  DEFAULT_APP_ROUTES,
  type ProbeResult,
} from "../scripts/lib/init";
import { parseConfig } from "../scripts/lib/config";
import {
  blockingConfigPath,
  existingConfigPath,
  parseArgs,
  parseScaffoldInput,
  runInit,
  runInitFromConfig,
  scanTokenFiles,
  type DetectionResult,
} from "../scripts/init";

describe("candidatePorts", () => {
  it("probes Storybook 6006 first, then the common app dev-server ports", () => {
    expect(candidatePorts()).toEqual([6006, 3000, 5173, 8080, 4321]);
  });
});

describe("classifyTarget", () => {
  it("classifies an origin with a Storybook index as a storybook target", () => {
    const probe: ProbeResult = { url: "http://localhost:6006", reachable: true, storyEntryCount: 12 };
    expect(classifyTarget(probe)).toEqual({ type: "storybook", url: "http://localhost:6006" });
  });

  it("treats a docs-only Storybook (zero entries) as a storybook target, not an app", () => {
    const probe: ProbeResult = { url: "http://localhost:6006", reachable: true, storyEntryCount: 0 };
    expect(classifyTarget(probe)).toEqual({ type: "storybook", url: "http://localhost:6006" });
  });

  it("classifies a reachable non-Storybook origin as an app with the default route", () => {
    const probe: ProbeResult = { url: "http://localhost:3000", reachable: true };
    expect(classifyTarget(probe)).toEqual({
      type: "app",
      url: "http://localhost:3000",
      routes: [...DEFAULT_APP_ROUTES],
    });
  });

  it("seeds an app target with the probe's routes when provided", () => {
    const probe: ProbeResult = {
      url: "http://localhost:3000",
      reachable: true,
      routes: ["/login", "/checkout"],
    };
    expect(classifyTarget(probe)).toEqual({
      type: "app",
      url: "http://localhost:3000",
      routes: ["/login", "/checkout"],
    });
  });

  it("refuses to classify an unreachable origin (names the url)", () => {
    expect(() => classifyTarget({ url: "http://localhost:9999", reachable: false })).toThrow(
      /9999/,
    );
  });
});

describe("detectTokenSources — per-format extension mapping", () => {
  it("maps a plain CSS file to the css format (auto content-detection happens in the engine)", () => {
    expect(detectTokenSources(["src/styles/tokens.css"])).toEqual({
      sources: [{ source: "src/styles/tokens.css", format: "css" }],
    });
  });

  it("maps an SCSS file to scss", () => {
    expect(detectTokenSources(["src/_tokens.scss"])).toEqual({
      sources: [{ source: "src/_tokens.scss", format: "scss" }],
    });
  });

  it("maps a .sass file to scss too", () => {
    expect(detectTokenSources(["src/tokens.sass"])).toEqual({
      sources: [{ source: "src/tokens.sass", format: "scss" }],
    });
  });

  it("maps a Less file to less", () => {
    expect(detectTokenSources(["theme/tokens.less"])).toEqual({
      sources: [{ source: "theme/tokens.less", format: "less" }],
    });
  });

  it("maps a .tokens.json file to dtcg (DTCG community convention)", () => {
    expect(detectTokenSources(["tokens/base.tokens.json"])).toEqual({
      sources: [{ source: "tokens/base.tokens.json", format: "dtcg" }],
    });
  });

  it("maps a bare .tokens file to dtcg", () => {
    expect(detectTokenSources(["design.tokens"])).toEqual({
      sources: [{ source: "design.tokens", format: "dtcg" }],
    });
  });

  it("leaves a plain .json file as auto (DTCG vs Style-Dictionary vs Studio is content-decided)", () => {
    expect(detectTokenSources(["tokens.json"])).toEqual({
      sources: [{ source: "tokens.json", format: "auto" }],
    });
  });

  it("drops files with no recognized token extension", () => {
    expect(detectTokenSources(["src/Button.tsx", "README.md", "tailwind.config.js"])).toBeUndefined();
  });

  it("returns undefined for an empty candidate list (engine default applies)", () => {
    expect(detectTokenSources([])).toBeUndefined();
  });

  it("prefers a token-named file, then format priority, then alphabetical — deterministically", () => {
    const result = detectTokenSources([
      "src/extra.scss",
      "src/styles/tokens.css",
      "src/app.css",
    ]);
    // tokens.css is token-named → first; the rest fall back to format rank (css before scss).
    expect(result?.sources).toEqual([
      { source: "src/styles/tokens.css", format: "css" },
      { source: "src/app.css", format: "css" },
      { source: "src/extra.scss", format: "scss" },
    ]);
  });

  it("is order-independent (same inputs in any order yield the same config)", () => {
    const a = detectTokenSources(["b/theme.scss", "a/tokens.css"]);
    const b = detectTokenSources(["a/tokens.css", "b/theme.scss"]);
    expect(a).toEqual(b);
  });
});

describe("buildScaffoldConfig — uses the repo's exact DEFAULTS", () => {
  const targets = [{ type: "storybook" as const, url: "http://localhost:6006" }];

  it("fills every non-targets field from the engine defaults", () => {
    const cfg = buildScaffoldConfig({ targets });
    expect(cfg.detect).toBe("auto");
    expect(cfg.viewports).toEqual([375, 768, 1280]);
    expect(cfg.states).toEqual(["default", "hover", "disabled"]);
    expect(cfg.threshold).toBe(0.1);
    expect(cfg.maxDiffRatio).toBe(0.01);
    expect(cfg.baselineDir).toBe(".visual-baselines");
    expect(cfg.uiGlobs).toEqual(["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss}"]);
  });

  it("defaults tokens to src/styles/tokens.css when none were detected", () => {
    const cfg = buildScaffoldConfig({ targets });
    expect(cfg.tokens).toEqual({ sources: [{ source: "src/styles/tokens.css", format: "auto" }] });
  });

  it("uses the detected token sources when provided", () => {
    const cfg = buildScaffoldConfig({
      targets,
      tokenSources: { sources: [{ source: "src/theme.scss", format: "scss" }] },
    });
    expect(cfg.tokens).toEqual({ sources: [{ source: "src/theme.scss", format: "scss" }] });
  });

  it("preserves app-target routes through validation", () => {
    const cfg = buildScaffoldConfig({
      targets: [{ type: "app", url: "http://localhost:3000", routes: ["/login"] }],
    });
    expect(cfg.targets[0]).toEqual({
      type: "app",
      url: "http://localhost:3000",
      routes: ["/login"],
    });
  });

  it("throws when no targets are given (the single required field)", () => {
    expect(() => buildScaffoldConfig({ targets: [] })).toThrow(/targets/);
  });
});

describe("scaffoldConfigObject — slim, valid output", () => {
  const targets = [{ type: "storybook" as const, url: "http://localhost:6006" }];

  it("writes only targets when no tokens were detected (engine defaults fill the rest)", () => {
    expect(scaffoldConfigObject({ targets })).toEqual({ targets });
  });

  it("includes detected tokens when present", () => {
    const tokenSources = { sources: [{ source: "src/theme.css", format: "css" as const }] };
    expect(scaffoldConfigObject({ targets, tokenSources })).toEqual({ targets, tokens: tokenSources });
  });

  it("round-trips: the slim object re-validates via parseConfig (buildScaffoldConfig)", () => {
    const obj = scaffoldConfigObject({ targets });
    // buildScaffoldConfig over the slim object must not throw — the scaffold is always loadable.
    expect(() => buildScaffoldConfig({ targets: obj.targets, tokenSources: obj.tokens })).not.toThrow();
  });

  it("writes the validated/normalized fields only — unknown keys are stripped, not persisted", () => {
    const obj = scaffoldConfigObject({
      targets: [{ type: "storybook", url: "http://localhost:6006", junk: 1 } as never],
    });
    expect(obj).toEqual({ targets: [{ type: "storybook", url: "http://localhost:6006" }] });
  });

  it("throws (via validation) for an empty scaffold", () => {
    expect(() => scaffoldConfigObject({ targets: [] })).toThrow(/targets/);
  });
});

// --- Impure shell: scripts/init.ts (detection injected so tests need no network) ------------

const injectedDetection: DetectionResult = {
  probes: [{ url: "http://localhost:6006", reachable: true, storyEntryCount: 3 }],
  targets: [{ type: "storybook", url: "http://localhost:6006" }],
  usedFallback: false,
  tokenCandidates: [],
};
const detect = async (): Promise<DetectionResult> => injectedDetection;

describe("parseArgs (init CLI)", () => {
  it("defaults configPath to undefined and the booleans to false", () => {
    expect(parseArgs([])).toEqual({
      configPath: undefined,
      force: false,
      dryRun: false,
      stdin: false,
    });
  });

  it("parses --config <path>, --force, --dry-run and --stdin", () => {
    expect(parseArgs(["--config", "build/vg.json", "--force", "--dry-run", "--stdin"])).toEqual({
      configPath: "build/vg.json",
      force: true,
      dryRun: true,
      stdin: true,
    });
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("throws when --config is missing its value", () => {
    expect(() => parseArgs(["--config"])).toThrow(/missing value/);
  });
});

describe("parseScaffoldInput (wizard --stdin payload)", () => {
  it("parses a { targets, tokens } object, mapping tokens -> tokenSources", () => {
    const raw = JSON.stringify({
      targets: [{ type: "storybook", url: "http://localhost:6006" }],
      tokens: { sources: [{ source: "src/theme.css", format: "css" }] },
    });
    expect(parseScaffoldInput(raw)).toEqual({
      targets: [{ type: "storybook", url: "http://localhost:6006" }],
      tokenSources: { sources: [{ source: "src/theme.css", format: "css" }] },
    });
  });

  it("parses a targets-only object (no tokens)", () => {
    const raw = JSON.stringify({ targets: [{ type: "app", url: "http://localhost:3000", routes: ["/"] }] });
    expect(parseScaffoldInput(raw)).toEqual({
      targets: [{ type: "app", url: "http://localhost:3000", routes: ["/"] }],
    });
  });

  it("throws on non-JSON input", () => {
    expect(() => parseScaffoldInput("not json")).toThrow(/JSON config object/);
  });

  it("throws when there's no targets array", () => {
    expect(() => parseScaffoldInput(JSON.stringify({ viewports: [375] }))).toThrow(/"targets" array/);
  });

  it("throws on an empty targets array (fail closed at the boundary)", () => {
    expect(() => parseScaffoldInput(JSON.stringify({ targets: [] }))).toThrow(/non-empty "targets"/);
  });

  it("refuses a JS-eval token format — the scaffolder never configures those", () => {
    const raw = JSON.stringify({
      targets: [{ type: "storybook", url: "http://localhost:6006" }],
      tokens: { sources: [{ source: "tailwind.config.js", format: "tailwind-config" }] },
    });
    expect(() => parseScaffoldInput(raw)).toThrow(/JS-eval token format/);
  });

  it("refuses an allowJsEval payload", () => {
    const raw = JSON.stringify({
      targets: [{ type: "storybook", url: "http://localhost:6006" }],
      tokens: { sources: [{ source: "src/theme.css", format: "css" }], allowJsEval: true },
    });
    expect(() => parseScaffoldInput(raw)).toThrow(/allowJsEval/);
  });
});

describe("runInitFromConfig — wizard-confirmed config, same guards as auto", () => {
  let tmp = "";
  const input = {
    targets: [{ type: "app" as const, url: "http://localhost:4000", routes: ["/home", "/pricing"] }],
  };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-wiz-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the provided (confirmed) config, and it round-trips through parseConfig", () => {
    const result = runInitFromConfig(input, { cwd: tmp });
    expect(result.written).toBe(true);
    const written = join(tmp, "visual.config.json");
    const parsed = parseConfig(JSON.parse(readFileSync(written, "utf8")));
    expect(parsed.targets).toEqual([
      { type: "app", url: "http://localhost:4000", routes: ["/home", "/pricing"] },
    ]);
  });

  it("--dry-run previews the provided config without writing", () => {
    const result = runInitFromConfig(input, { cwd: tmp, dryRun: true });
    expect(result.written).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(existsSync(join(tmp, "visual.config.json"))).toBe(false);
  });

  it("never clobbers an existing config without --force, and overwrites with it", () => {
    const dest = join(tmp, "visual.config.json");
    writeFileSync(dest, '{"targets":[{"type":"storybook","url":"http://localhost:6006"}]}');
    expect(runInitFromConfig(input, { cwd: tmp }).written).toBe(false);
    expect(runInitFromConfig(input, { cwd: tmp, force: true }).written).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain("localhost:4000");
  });

  it("refuses to write outside the project root", () => {
    expect(() =>
      runInitFromConfig(input, { cwd: tmp, configPath: join(tmp, "..", "escape.json"), force: true }),
    ).toThrow(/outside the project root/);
  });

  it("rejects an invalid scaffold (empty targets) via parseConfig validation", () => {
    expect(() => runInitFromConfig({ targets: [] }, { cwd: tmp })).toThrow(/targets/);
  });
});

describe("init CLI --stdin (integrated: main + readStdin via a real subprocess)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
  const initTs = join(repoRoot, "scripts", "init.ts");
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-cli-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("reads the piped config from stdin and writes visual.config.json", () => {
    const payload = JSON.stringify({
      targets: [{ type: "app", url: "http://localhost:4000", routes: ["/"] }],
    });
    const out = execFileSync(tsx, [initTs, "--stdin"], { input: payload, cwd: tmp, encoding: "utf8" });
    expect(JSON.parse(out).written).toBe(true);
    expect(existsSync(join(tmp, "visual.config.json"))).toBe(true);
  });

  it("exits non-zero and writes nothing on invalid stdin", () => {
    let status: number | null = 0;
    try {
      execFileSync(tsx, [initTs, "--stdin"], {
        input: "{}",
        cwd: tmp,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      status = (err as { status?: number | null }).status ?? -1;
    }
    expect(status).not.toBe(0);
    expect(existsSync(join(tmp, "visual.config.json"))).toBe(false);
  });
});

describe("scanTokenFiles", () => {
  let tmp = "";
  const put = (rel: string, body = ""): void => {
    const abs = join(tmp, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-scan-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("finds token-extension files (POSIX-relative, sorted) and ignores non-token files", () => {
    put("src/styles/tokens.css");
    put("theme/colors.scss");
    put("src/Button.tsx");
    put("README.md");
    expect(scanTokenFiles(tmp)).toEqual(["src/styles/tokens.css", "theme/colors.scss"]);
  });

  it("skips node_modules, dotdirs (.git) and build output (dist)", () => {
    put("tokens.css");
    put("node_modules/pkg/styles.css");
    put(".git/config.css");
    put("dist/bundle.css");
    expect(scanTokenFiles(tmp)).toEqual(["tokens.css"]);
  });

  it("respects maxDepth", () => {
    put("a/b/c/d/deep.css");
    expect(scanTokenFiles(tmp, 2)).toEqual([]);
    expect(scanTokenFiles(tmp, 5)).toEqual(["a/b/c/d/deep.css"]);
  });

  it("does not follow symlinks (a broken/cyclic link can't crash or pollute the scan)", () => {
    put("real/tokens.css");
    try {
      symlinkSync(join(tmp, "real"), join(tmp, "linked"));
    } catch {
      // symlink unsupported on this platform — the file-only result still proves no-follow
    }
    expect(scanTokenFiles(tmp)).toEqual(["real/tokens.css"]);
  });
});

describe("existingConfigPath / blockingConfigPath", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-cfg-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("existingConfigPath returns null when no config is present", () => {
    expect(existingConfigPath(tmp)).toBeNull();
  });

  it("existingConfigPath finds a root visual.config.json", () => {
    const p = join(tmp, "visual.config.json");
    writeFileSync(p, "{}");
    expect(existingConfigPath(tmp)).toBe(p);
  });

  it("existingConfigPath finds config/visual.config.json when there's no root one", () => {
    mkdirSync(join(tmp, "config"), { recursive: true });
    const p = join(tmp, "config", "visual.config.json");
    writeFileSync(p, "{}");
    expect(existingConfigPath(tmp)).toBe(p);
  });

  it("blockingConfigPath returns the destination itself when it already exists", () => {
    const custom = join(tmp, "custom.json");
    writeFileSync(custom, "{}");
    expect(blockingConfigPath(tmp, custom)).toBe(resolve(custom));
  });

  it("blockingConfigPath falls back to the discovery precedence when the destination is absent", () => {
    const root = join(tmp, "visual.config.json");
    writeFileSync(root, "{}");
    expect(blockingConfigPath(tmp, join(tmp, "does-not-exist.json"))).toBe(root);
  });
});

describe("runInit — write gating (detection injected; no network)", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-init-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("--dry-run previews without writing anything to disk", async () => {
    const result = await runInit({ cwd: tmp, dryRun: true, detect });
    expect(result.written).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(existsSync(join(tmp, "visual.config.json"))).toBe(false);
  });

  it("scaffolds a loadable visual.config.json in a fresh project", async () => {
    const result = await runInit({ cwd: tmp, detect });
    expect(result.written).toBe(true);
    const written = join(tmp, "visual.config.json");
    expect(existsSync(written)).toBe(true);
    // the written file round-trips through the engine's own parser
    expect(() => parseConfig(JSON.parse(readFileSync(written, "utf8")))).not.toThrow();
  });

  it("never clobbers an existing root config without --force", async () => {
    const dest = join(tmp, "visual.config.json");
    writeFileSync(dest, '{"targets":[{"type":"app","url":"http://localhost:4000","routes":["/"]}]}');
    const before = readFileSync(dest, "utf8");
    const result = await runInit({ cwd: tmp, detect });
    expect(result.written).toBe(false);
    expect(result.existingPath).toBe(dest);
    expect(readFileSync(dest, "utf8")).toBe(before); // untouched
  });

  it("overwrites an existing config when --force is given", async () => {
    const dest = join(tmp, "visual.config.json");
    writeFileSync(dest, '{"targets":[{"type":"app","url":"http://localhost:4000","routes":["/"]}]}');
    const result = await runInit({ cwd: tmp, force: true, detect });
    expect(result.written).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain("localhost:6006"); // the scaffold replaced it
  });

  it("does NOT clobber an existing file at a custom --config path without --force (regression)", async () => {
    const custom = join(tmp, "build", "visual.dev.json");
    mkdirSync(join(tmp, "build"), { recursive: true });
    writeFileSync(custom, '{"targets":[{"type":"storybook","url":"http://localhost:7007"}]}');
    const before = readFileSync(custom, "utf8");
    // No root visual.config.json exists — the destination-blind guard would have clobbered this.
    const result = await runInit({ cwd: tmp, configPath: custom, detect });
    expect(result.written).toBe(false);
    expect(result.existingPath).toBe(resolve(custom));
    expect(readFileSync(custom, "utf8")).toBe(before);
    // ...and --force still allows the overwrite.
    const forced = await runInit({ cwd: tmp, configPath: custom, force: true, detect });
    expect(forced.written).toBe(true);
  });

  it("refuses to write outside the project root (assertUnder)", async () => {
    const escape = join(tmp, "..", "vg-escape.json");
    await expect(runInit({ cwd: tmp, configPath: escape, force: true, detect })).rejects.toThrow(
      /outside the project root/,
    );
  });
});
