import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderTarget } from "../scripts/lib/targets";
import {
  candidateComponentNames,
  collectChangedFiles,
  decideScope,
  isGlobalFile,
  matchesAnyGlob,
  parseScopeArgs,
  summarize,
  DEFAULT_GLOBAL_GLOBS,
  type DecideInput,
} from "../scripts/scope";
import { filterByScope, readScopeFile } from "../scripts/capture";
import type { ImportGraph } from "../scripts/lib/graph/import-graph";

const UI_GLOBS = ["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss,sass,less,styl,pcss}"];
const TOKEN_GLOBS = ["src/styles/tokens.css"];

const render = (name: string, state = "default", viewport = 1280): RenderTarget => ({
  instance: "components",
  name,
  state,
  viewport,
  kind: "storybook",
  url: `http://localhost:6006/iframe.html?id=${name.toLowerCase()}--${state}&viewMode=story`,
  storyId: `${name.toLowerCase()}--${state}`,
});

// A small known universe: Button (2 renders), Card (1), Input (1).
const TARGETS: RenderTarget[] = [
  render("Button", "primary"),
  render("Button", "secondary"),
  render("Card"),
  render("Input"),
];

const base = (over: Partial<DecideInput>): DecideInput => ({
  changedFiles: [],
  gitResolved: true,
  forceAll: false,
  uiGlobs: UI_GLOBS,
  tokenGlobs: TOKEN_GLOBS,
  globalGlobs: DEFAULT_GLOBAL_GLOBS,
  targets: TARGETS,
  ...over,
});

describe("candidateComponentNames", () => {
  it("returns basename and parent dir, stripping story/test suffixes", () => {
    expect(candidateComponentNames("src/components/Button/Button.css")).toEqual(["Button"]);
    expect(candidateComponentNames("src/components/Button/Button.stories.tsx")).toEqual(["Button"]);
    expect(candidateComponentNames("src/components/Button/index.tsx").sort()).toEqual([
      "Button",
      "index",
    ]);
    expect(candidateComponentNames("Button.tsx")).toEqual(["Button"]);
    expect(candidateComponentNames("src/lib/format.ts").sort()).toEqual(["format", "lib"]);
  });
});

describe("matchesAnyGlob / isGlobalFile", () => {
  it("matches brace + ** globs", () => {
    expect(matchesAnyGlob("src/a/Button.tsx", UI_GLOBS)).toBe(true);
    expect(matchesAnyGlob("src/a/Button.css", UI_GLOBS)).toBe(true);
    expect(matchesAnyGlob("README.md", UI_GLOBS)).toBe(false);
  });

  it("flags global files: tokens, .storybook, global css, lockfiles", () => {
    expect(isGlobalFile("src/styles/tokens.css", DEFAULT_GLOBAL_GLOBS, TOKEN_GLOBS)).toBe(true);
    expect(isGlobalFile(".storybook/preview.ts", DEFAULT_GLOBAL_GLOBS, TOKEN_GLOBS)).toBe(true);
    expect(isGlobalFile("src/styles/global.css", DEFAULT_GLOBAL_GLOBS, TOKEN_GLOBS)).toBe(true);
    expect(isGlobalFile("package-lock.json", DEFAULT_GLOBAL_GLOBS, TOKEN_GLOBS)).toBe(true);
    expect(isGlobalFile("src/components/Button/Button.css", DEFAULT_GLOBAL_GLOBS, TOKEN_GLOBS)).toBe(
      false,
    );
  });

  it("flags the build/env/asset surface the adversarial audit surfaced (else they slip to 'affects no story')", () => {
    for (const file of [
      "vite.config.ts",
      "vite.config.mts",
      "webpack.config.js",
      "babel.config.json",
      ".babelrc",
      "components.json",
      ".npmrc",
      ".env",
      ".env.production",
      "src/theme/tokens.scss",
      "src/styles/base.css",
      "src/styles/reset.css",
      "src/theme/designTokens.ts",
      "src/components/Button/Button.theme.ts",
      ".storybook/preview-head.html",
      "public/fonts/Brand.woff2",
      "static/logo.svg",
      "patches/@acme+ui+1.0.0.patch",
    ]) {
      expect(isGlobalFile(file, DEFAULT_GLOBAL_GLOBS, TOKEN_GLOBS), file).toBe(true);
    }
    // A component-local stylesheet/asset is NOT global (it scopes to its importers via the graph).
    expect(isGlobalFile("src/components/Button/Button.css", DEFAULT_GLOBAL_GLOBS, TOKEN_GLOBS)).toBe(false);
    expect(isGlobalFile("src/components/Button/icon.svg", DEFAULT_GLOBAL_GLOBS, TOKEN_GLOBS)).toBe(false);
  });
});

describe("decideScope — the cardinal invariant (uncertainty always widens to a full sweep)", () => {
  it("--all → full sweep", () => {
    const d = decideScope(base({ forceAll: true, changedFiles: ["src/components/Button/Button.css"] }));
    expect(d.mode).toBe("all");
    expect(d.totalRenders).toBe(4);
  });

  it("no relevant changes with a resolved git state → none (trustworthy empty)", () => {
    const d = decideScope(base({ changedFiles: ["README.md", "docs/x.md"], gitResolved: true }));
    expect(d.mode).toBe("none");
    expect(d.scopedRenders).toBe(0);
  });

  it("no relevant changes but git could NOT be resolved → full sweep (untrustworthy empty)", () => {
    const d = decideScope(base({ changedFiles: [], gitResolved: false }));
    expect(d.mode).toBe("all");
    expect(d.reasons[0]).toMatch(/could not determine/);
  });

  it("a token change → full sweep", () => {
    const d = decideScope(base({ changedFiles: ["src/styles/tokens.css"] }));
    expect(d.mode).toBe("all");
    expect(d.reasons[0]).toMatch(/global change: src\/styles\/tokens\.css/);
  });

  it("a Storybook-config change → full sweep", () => {
    const d = decideScope(base({ changedFiles: [".storybook/preview.ts"] }));
    expect(d.mode).toBe("all");
  });

  it("a UI change the heuristic can't map to a known story → full sweep", () => {
    const d = decideScope(base({ changedFiles: ["src/lib/format.ts"] }));
    // format.ts → candidates {format, lib}; neither is a known component → conservative full sweep.
    expect(d.mode).toBe("all");
    expect(d.reasons[0]).toMatch(/unmapped change/);
  });

  it("a mix of mapped + unmapped → full sweep (one miss is enough)", () => {
    const d = decideScope(
      base({ changedFiles: ["src/components/Button/Button.css", "src/lib/format.ts"] }),
    );
    expect(d.mode).toBe("all");
  });

  it("every changed UI file maps cleanly → scoped, with the right components + render count", () => {
    const d = decideScope(
      base({
        changedFiles: ["src/components/Button/Button.css", "src/components/Card/Card.tsx"],
      }),
    );
    expect(d.mode).toBe("scoped");
    expect(d.components).toEqual(["Button", "Card"]);
    // Button has 2 renders + Card 1 = 3 of 4 total.
    expect(d.scopedRenders).toBe(3);
    expect(d.totalRenders).toBe(4);
  });

  it("maps case-insensitively and via the parent directory", () => {
    const d = decideScope(base({ changedFiles: ["src/components/Button/index.tsx"] }));
    expect(d.mode).toBe("scoped");
    expect(d.components).toEqual(["Button"]);
  });
});

describe("decideScope — audit regressions (uncertainty must NEVER narrow)", () => {
  it("a CASE-VARIANT token file (tokens.CSS) still fans out to a full sweep", () => {
    // Was a critical hole: case-sensitive globs dropped tokens.CSS before the global check.
    const d = decideScope(
      base({ changedFiles: ["src/styles/tokens.CSS", "src/components/Button/Button.css"] }),
    );
    expect(d.mode).toBe("all");
  });

  it("an unrecognized, non-ignorable changed file forces a full sweep (never silently dropped)", () => {
    // A positive include-filter used to make these vanish → mode 'none'/'scoped'. Now they widen.
    expect(decideScope(base({ changedFiles: ["src/data/items.json"] })).mode).toBe("all");
    expect(
      decideScope(base({ changedFiles: ["src/components/Button/Button.css", "config/weird.toml"] }))
        .mode,
    ).toBe("all");
  });

  it("gitResolved:false ALWAYS widens, even when mappable UI files are present (bad --since)", () => {
    // The guard now sits at the TOP, before the relevant filter: an untracked-only set off a failed
    // `git diff` must not produce a scoped run.
    const d = decideScope(
      base({ changedFiles: ["src/components/Button/Button.tsx"], gitResolved: false }),
    );
    expect(d.mode).toBe("all");
    expect(d.reasons[0]).toMatch(/could not determine/);
  });

  it("drives non-UI global files (lockfile, .storybook/main, postcss config) through to a full sweep", () => {
    for (const file of ["pnpm-lock.yaml", "yarn.lock", ".storybook/main.ts", "postcss.config.js"]) {
      expect(decideScope(base({ changedFiles: [file] })).mode).toBe("all");
    }
  });

  it("a GLOB token source overlapping the UI .css glob wins as global (not scoped to a component)", () => {
    const d = decideScope(
      base({ changedFiles: ["src/theme/colors.css"], tokenGlobs: ["**/theme/*.css"] }),
    );
    expect(d.mode).toBe("all"); // global check runs BEFORE component mapping
  });

  it("a component-scoped .less edit now maps (broadened default uiGlobs)", () => {
    const d = decideScope(base({ changedFiles: ["src/components/Card/Card.less"] }));
    expect(d.mode).toBe("scoped");
    expect(d.components).toEqual(["Card"]);
  });

  it("ignorable-only changes (docs, tests) are 'none'", () => {
    expect(decideScope(base({ changedFiles: ["README.md", "src/Button.test.tsx"] })).mode).toBe(
      "none",
    );
  });

  it("a renderable file under an ignorable directory is NOT swallowed (story/.tsx stays in scope)", () => {
    // A story discovered via the live index can live anywhere; a broad `<dir>/**` ignore must not
    // drop it. `.stories.*` is structurally protected; a component .tsx under .github isn't ignored.
    expect(
      decideScope(base({ changedFiles: ["src/components/Button/__tests__/Button.stories.tsx"] }))
        .mode,
    ).toBe("scoped");
    expect(decideScope(base({ changedFiles: [".github/ui/Card.tsx"] })).mode).toBe("scoped");
    // A genuinely non-rendering file under those dirs is still ignored.
    expect(decideScope(base({ changedFiles: [".github/workflows/ci.yml"] })).mode).toBe("none");
  });
});

describe("decideScope — Phase 1 import graph (closes the cross-import gap)", () => {
  const t = (name: string, state: string, storyId: string, storyFile: string): RenderTarget => ({
    instance: "components",
    name,
    state,
    viewport: 1280,
    kind: "storybook",
    url: `http://localhost:6006/iframe.html?id=${storyId}&viewMode=story`,
    storyId,
    storyFile,
  });
  const TG: RenderTarget[] = [
    t("Button", "primary", "button--primary", "src/components/Button/Button.stories.tsx"),
    t("Card", "default", "card--default", "src/components/Card/Card.stories.tsx"),
  ];
  const BTN = "src/components/button/button.stories.tsx"; // lowercased graph keys
  const CARD = "src/components/card/card.stories.tsx";

  it("scopes a shared component to EVERY story that imports it (Phase 0 would give only one)", () => {
    const graph: ImportGraph = {
      built: true,
      fileToStoryFiles: new Map([["src/components/button/button.tsx", new Set([BTN, CARD])]]),
      storyIncomplete: new Map([
        [BTN, false],
        [CARD, false],
      ]),
    };
    const d = decideScope(base({ changedFiles: ["src/components/Button/Button.tsx"], targets: TG, graph }));
    expect(d.mode).toBe("scoped");
    expect(d.components).toEqual(["Button", "Card"]);
    expect(d.storyIds).toEqual(["button--primary", "card--default"]);
  });

  it("a file reaching no story is 'none' WHEN the graph is complete", () => {
    const graph: ImportGraph = {
      built: true,
      fileToStoryFiles: new Map(),
      storyIncomplete: new Map([[BTN, false]]),
    };
    expect(decideScope(base({ changedFiles: ["src/utils/helper.ts"], targets: TG, graph })).mode).toBe(
      "none",
    );
  });

  it("a file reaching no story WIDENS to all when the graph is incomplete", () => {
    const graph: ImportGraph = {
      built: true,
      fileToStoryFiles: new Map(),
      storyIncomplete: new Map([[BTN, true]]),
    };
    expect(decideScope(base({ changedFiles: ["src/utils/helper.ts"], targets: TG, graph })).mode).toBe(
      "all",
    );
  });

  it("an incomplete story is captured in EVERY scoped run, regardless of what changed", () => {
    const graph: ImportGraph = {
      built: true,
      fileToStoryFiles: new Map([["src/components/button/button.tsx", new Set([BTN])]]),
      storyIncomplete: new Map([
        [BTN, false],
        [CARD, true], // Card's closure is untrustworthy → always captured
      ]),
    };
    const d = decideScope(base({ changedFiles: ["src/components/Button/Button.tsx"], targets: TG, graph }));
    expect(d.mode).toBe("scoped");
    expect(d.components).toEqual(["Button", "Card"]);
  });

  it("falls back to the Phase-0 filename heuristic when the graph isn't built", () => {
    const graph: ImportGraph = { built: false, fileToStoryFiles: new Map(), storyIncomplete: new Map() };
    const d = decideScope(base({ changedFiles: ["src/components/Button/Button.css"], targets: TG, graph }));
    expect(d.mode).toBe("scoped");
    expect(d.components).toEqual(["Button"]); // no cross-import in the fallback
  });

  it("global + early-exit checks still run BEFORE the graph path", () => {
    const graph: ImportGraph = {
      built: true,
      fileToStoryFiles: new Map([["src/styles/tokens.css", new Set([BTN])]]),
      storyIncomplete: new Map([[BTN, false]]),
    };
    // tokens.css is a token source → global → full sweep, never graph-scoped to one story.
    expect(decideScope(base({ changedFiles: ["src/styles/tokens.css"], targets: TG, graph })).mode).toBe(
      "all",
    );
  });

  // --- Phase 2: fan-out-barrel detection (only above the min-library-size floor) ---
  const many = "abcdefghij".split(""); // 10 stories (>= FANOUT_MIN_STORIES)
  const manyTargets = many.map((s) => t(s.toUpperCase(), "default", `${s}--default`, `src/${s}/${s}.stories.tsx`));
  const manyKeys = many.map((s) => `src/${s}/${s}.stories.tsx`); // lowercased graph keys

  it("a fan-out barrel (reaches > 40% of a non-trivial library) WIDENS to a full sweep", () => {
    const graph: ImportGraph = {
      built: true,
      fileToStoryFiles: new Map([["src/lib/barrel.ts", new Set(manyKeys.slice(0, 6))]]), // 6/10 = 60%
      storyIncomplete: new Map(manyKeys.map((k) => [k, false])),
    };
    const d = decideScope(base({ changedFiles: ["src/lib/barrel.ts"], targets: manyTargets, graph }));
    expect(d.mode).toBe("all");
    expect(d.reasons.some((r) => /fan-out/.test(r))).toBe(true);
  });

  it("a file reaching only a minority of stories stays scoped (no fan-out)", () => {
    const graph: ImportGraph = {
      built: true,
      fileToStoryFiles: new Map([["src/a/a.tsx", new Set(manyKeys.slice(0, 1))]]), // 1/10 = 10%
      storyIncomplete: new Map(manyKeys.map((k) => [k, false])),
    };
    const d = decideScope(base({ changedFiles: ["src/A/A.tsx"], targets: manyTargets, graph }));
    expect(d.mode).toBe("scoped");
    expect(d.components).toEqual(["A"]);
  });

  it("does NOT fan-out a tiny library (the cross-import headline still scopes precisely)", () => {
    // 2-story library: Button imported by Card is 100%, but below the floor → scoped, not a sweep.
    const graph: ImportGraph = {
      built: true,
      fileToStoryFiles: new Map([["src/components/button/button.tsx", new Set([BTN, CARD])]]),
      storyIncomplete: new Map([
        [BTN, false],
        [CARD, false],
      ]),
    };
    const d = decideScope(base({ changedFiles: ["src/components/Button/Button.tsx"], targets: TG, graph }));
    expect(d.mode).toBe("scoped");
    expect(d.components).toEqual(["Button", "Card"]);
  });

  it("honors a configured fanoutThreshold (a lower threshold fans out at a smaller fraction)", () => {
    const graph: ImportGraph = {
      built: true,
      fileToStoryFiles: new Map([["src/lib/x.ts", new Set(manyKeys.slice(0, 3))]]), // 3/10 = 30%
      storyIncomplete: new Map(manyKeys.map((k) => [k, false])),
    };
    // Default threshold 0.4 → 30% is not a fan-out → scoped.
    expect(decideScope(base({ changedFiles: ["src/lib/x.ts"], targets: manyTargets, graph })).mode).toBe(
      "scoped",
    );
    // Configured threshold 0.2 → 30% > 20% → fan-out → full sweep.
    expect(
      decideScope(base({ changedFiles: ["src/lib/x.ts"], targets: manyTargets, graph, fanoutThreshold: 0.2 })).mode,
    ).toBe("all");
  });

  it("a configured extra global glob forces a full sweep (mark a project-specific global file)", () => {
    const graph: ImportGraph = {
      built: true,
      fileToStoryFiles: new Map([["src/theme/provider.tsx", new Set([BTN])]]),
      storyIncomplete: new Map([[BTN, false]]),
    };
    // The graph would otherwise scope it to Button; the extra global glob makes it a full sweep.
    expect(
      decideScope(
        base({
          changedFiles: ["src/theme/Provider.tsx"],
          targets: TG,
          graph,
          globalGlobs: [...DEFAULT_GLOBAL_GLOBS, "**/theme/**"],
        }),
      ).mode,
    ).toBe("all");
  });
});

describe("scope.json round-trip: scope.ts decision → capture.ts consumption", () => {
  it("a scoped decision serializes and re-applies to the exact same renders", () => {
    const decision = decideScope(
      base({ changedFiles: ["src/components/Button/Button.css", "src/components/Card/Card.tsx"] }),
    );
    expect(decision.mode).toBe("scoped");
    // Serialize exactly as scope.ts main() does, then read it back via the capture-side reader.
    const serialized = `${JSON.stringify(decision, null, 2)}\n`;
    const scope = readScopeFile("scope.json", () => serialized);
    expect(scope).not.toBeNull();
    const kept = filterByScope(TARGETS, scope!);
    // Button (2 renders) + Card (1) — the exact set decideScope chose, by component-name casing.
    expect(kept.map((t) => `${t.name}/${t.state}`).sort()).toEqual([
      "Button/primary",
      "Button/secondary",
      "Card/default",
    ]);
    expect(kept.length).toBe(decision.scopedRenders);
  });
});

describe("parseScopeArgs", () => {
  it("parses --all / --since / --config / --cwd and derives the default out path", () => {
    expect(parseScopeArgs(["--all"], "/proj").all).toBe(true);
    expect(parseScopeArgs(["--since", "main"], "/proj").since).toBe("main");
    expect(parseScopeArgs([], "/proj").out).toBe("/proj/.visual-guard/scope.json");
    const a = parseScopeArgs(["--config", "c.json", "--cwd", "/x", "--out", "/o/s.json"], "/proj");
    expect(a).toEqual({ config: "c.json", cwd: "/x", out: "/o/s.json", since: undefined, all: false });
  });

  it("throws on an unknown flag or a missing value", () => {
    expect(() => parseScopeArgs(["--nope"], "/proj")).toThrow(/unknown argument/);
    expect(() => parseScopeArgs(["--since"], "/proj")).toThrow(/missing value/);
  });
});

describe("summarize", () => {
  it("describes each mode for the user", () => {
    expect(summarize(decideScope(base({ changedFiles: ["README.md"] })))).toMatch(/nothing to check/);
    expect(summarize(decideScope(base({ forceAll: true })))).toMatch(/full sweep — 4 renders/);
    const scoped = decideScope(base({ changedFiles: ["src/components/Card/Card.tsx"] }));
    expect(summarize(scoped)).toMatch(/scoped — 1 component\(s\), 1 of 4 renders \(3 out of scope\)/);
  });
});

describe("collectChangedFiles — git diff + untracked + pending (gitResolved flag)", () => {
  let tmp = "";
  const gitInit = (dir: string): void => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-scope-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("reports gitResolved:true and surfaces tracked + untracked + pending files", () => {
    gitInit(tmp);
    mkdirSync(join(tmp, "src"), { recursive: true });
    // Commit a .gitignore so .visual-guard/ (and the gitignore) aren't counted as untracked noise —
    // mirrors a real project where run artifacts are ignored.
    writeFileSync(join(tmp, ".gitignore"), ".visual-guard/\n");
    writeFileSync(join(tmp, "src", "Button.tsx"), "export const Button = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: tmp });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: tmp });
    // modify a tracked file + add an untracked one + a pending marker
    writeFileSync(join(tmp, "src", "Button.tsx"), "export const Button = 2;\n");
    writeFileSync(join(tmp, "src", "Card.tsx"), "export const Card = 1;\n");
    mkdirSync(join(tmp, ".visual-guard"), { recursive: true });
    writeFileSync(
      join(tmp, ".visual-guard", "pending.json"),
      JSON.stringify({ version: 1, files: ["src/Input.tsx"] }),
    );

    const { files, gitResolved } = collectChangedFiles(tmp, undefined);
    expect(gitResolved).toBe(true);
    expect(files.sort()).toEqual(["src/Button.tsx", "src/Card.tsx", "src/Input.tsx"]);
  });

  it("reports gitResolved:false outside a git repo (so empty can't be trusted)", () => {
    const { files, gitResolved } = collectChangedFiles(tmp, undefined);
    expect(gitResolved).toBe(false);
    expect(files).toEqual([]);
  });

  it("diffs against an explicit --since base (HEAD~1) across commits", () => {
    gitInit(tmp);
    writeFileSync(join(tmp, ".gitignore"), ".visual-guard/\n");
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "Button.tsx"), "1\n");
    execFileSync("git", ["add", "-A"], { cwd: tmp });
    execFileSync("git", ["commit", "-qm", "c1"], { cwd: tmp });
    writeFileSync(join(tmp, "src", "Button.tsx"), "2\n"); // change in the 2nd commit
    execFileSync("git", ["commit", "-aqm", "c2"], { cwd: tmp });

    const { files, gitResolved } = collectChangedFiles(tmp, "HEAD~1");
    expect(gitResolved).toBe(true);
    expect(files).toContain("src/Button.tsx");
  });

  it("reports gitResolved:false for a bad --since ref (git diff exits non-zero)", () => {
    gitInit(tmp);
    writeFileSync(join(tmp, "a.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: tmp });
    execFileSync("git", ["commit", "-qm", "c1"], { cwd: tmp });
    const { gitResolved } = collectChangedFiles(tmp, "no-such-ref-xyz");
    expect(gitResolved).toBe(false); // → decideScope widens to a full sweep
  });
});
