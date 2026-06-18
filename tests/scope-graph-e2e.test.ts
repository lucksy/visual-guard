import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResolver } from "../scripts/lib/graph/resolver";
import { buildProjectGraph, decideScope } from "../scripts/scope";
import { filterByScope, readScopeFile } from "../scripts/capture";
import type { RenderTarget } from "../scripts/lib/targets";

const UI_GLOBS = ["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss,sass,less,styl,pcss}"];

const target = (over: Partial<RenderTarget>): RenderTarget => ({
  instance: "c",
  name: "X",
  state: "default",
  viewport: 1280,
  kind: "storybook",
  url: "http://localhost:6006/iframe.html?id=x--default&viewMode=story",
  storyId: "x--default",
  ...over,
});

describe("resolver hardening (audit fixes) — real TS resolution", () => {
  let dir = "";
  const write = (rel: string, body: string): void => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vg-rfix-"));
    write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { moduleResolution: "node", baseUrl: ".", paths: { "@/*": ["src/*"] } }, include: ["."] }),
    );
    write("src/shared.ts", "export const shared = 1;\n");
    write("src/styles/theme.scss", ".t {}\n");
    // node_modules package — the traversal boundary.
    write("node_modules/dep/package.json", JSON.stringify({ name: "dep", main: "index.js" }));
    write("node_modules/dep/index.js", "module.exports = 1;\n");
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("resolves an ALIASED extensionless asset (@/styles/theme → theme.scss) as a real edge", () => {
    write("src/A/A.tsx", `import "@/styles/theme";\nimport { shared } from "@/shared";\nexport const A = shared;\n`);
    const out = createResolver(dir, (p) => readFileSync(p, "utf8")).extractImports(join(dir, "src/A/A.tsx"));
    expect(out.unresolvedOrDynamic).toBe(false); // NOT dropped as external
    const rels = out.resolved.map((p) => p.slice(dir.length + 1).split("\\").join("/")).sort();
    expect(rels).toEqual(["src/shared.ts", "src/styles/theme.scss"]);
  });

  it("excludes a node_modules package (boundary) but keeps a sibling in-project edge", () => {
    write("src/A/A.tsx", `import dep from "dep";\nimport "./A.css";\nexport const A = dep;\n`);
    write("src/A/A.css", ".a {}\n");
    const out = createResolver(dir, (p) => readFileSync(p, "utf8")).extractImports(join(dir, "src/A/A.tsx"));
    expect(out.unresolvedOrDynamic).toBe(false);
    expect(out.resolved.map((p) => p.slice(dir.length + 1).split("\\").join("/"))).toEqual(["src/A/A.css"]);
  });

  it("treats an UNPLACEABLE bare specifier (a bundler alias absent from tsconfig) as incomplete, not external", () => {
    write("src/A/A.tsx", `import { Button } from "@ui/Button";\nexport const A = Button;\n`);
    const out = createResolver(dir, (p) => readFileSync(p, "utf8")).extractImports(join(dir, "src/A/A.tsx"));
    expect(out.unresolvedOrDynamic).toBe(true); // would otherwise silently drop the edge
  });

  it("resolves a non-dotted relative CSS @import as a sibling edge, not an external package", () => {
    write("src/styles/foo/bar.css", ".b {}\n");
    write("src/styles/A.css", `@import "foo/bar.css";\n@import "normalize.css";\n.a {}\n`);
    const out = createResolver(dir, (p) => readFileSync(p, "utf8")).extractImports(join(dir, "src/styles/A.css"));
    expect(out.unresolvedOrDynamic).toBe(false);
    const rels = out.resolved.map((p) => p.slice(dir.length + 1).split("\\").join("/"));
    // The path-shaped sibling is a real edge; the single-word npm package stays an external boundary.
    expect(rels).toEqual(["src/styles/foo/bar.css"]);
  });

  it("follows a workspace package SYMLINKED into node_modules as a first-party edge (not external)", () => {
    // pnpm/npm/yarn workspace layout: node_modules/mylib → packages/mylib (a symlink). TS may flag
    // the import isExternalLibraryImport even though it resolves to a tracked in-repo file.
    write("packages/mylib/package.json", JSON.stringify({ name: "mylib", main: "index.ts", types: "index.ts" }));
    write("packages/mylib/index.ts", "export const u = 1;\n");
    symlinkSync(join(dir, "packages/mylib"), join(dir, "node_modules/mylib"), "dir");
    write("src/A/A.tsx", `import { u } from "mylib";\nexport const A = u;\n`);
    const out = createResolver(dir, (p) => readFileSync(p, "utf8")).extractImports(join(dir, "src/A/A.tsx"));
    const rels = out.resolved.map((p) => p.split("\\").join("/"));
    // The SAFE outcome (never a silent drop): the workspace package is either followed as a real
    // in-repo edge (precise) OR the importer is marked incomplete (so its story is always captured).
    // What must NOT happen: dropped as `external` with a clean/complete closure.
    const followedFirstParty = rels.some((p) => p.includes("/packages/mylib/") && !p.includes("/node_modules/"));
    expect(out.unresolvedOrDynamic || followedFirstParty).toBe(true);
    expect(rels.some((p) => p.includes("/node_modules/"))).toBe(false); // never a node_modules edge
  });

  it("flags a static require edge clean but a computed/aliased require as incomplete", () => {
    write("src/static.tsx", `const s = require("./shared");\nexport const x = s;\n`);
    write("src/computed.tsx", `const r = require;\nexport const load = (p) => r(p);\n`);
    const r = createResolver(dir, (p) => readFileSync(p, "utf8"));
    const stat = r.extractImports(join(dir, "src/static.tsx"));
    expect(stat.unresolvedOrDynamic).toBe(false);
    expect(stat.resolved.map((p) => p.slice(dir.length + 1))).toEqual(["src/shared.ts"]);
    expect(r.extractImports(join(dir, "src/computed.tsx")).unresolvedOrDynamic).toBe(true);
  });
});

describe("buildProjectGraph — coverage gate (only graph a fully-covered, cwd-internal universe)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vg-cov-"));
    mkdirSync(join(dir, "src/A"), { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { moduleResolution: "node" }, include: ["."] }));
    writeFileSync(join(dir, "src/A/A.stories.tsx"), "export const Primary = 1;\n");
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const read = (p: string): string => readFileSync(p, "utf8");

  it("builds when EVERY target is rooted by a cwd-internal story file", () => {
    const targets = [target({ name: "A", storyId: "a--primary", storyFile: "src/A/A.stories.tsx" })];
    expect(buildProjectGraph(dir, targets, read)?.built).toBe(true);
  });

  it("returns undefined when ANY target lacks a storyFile (Ladle / app / explicit list) — Phase-0 fallback", () => {
    const targets = [
      target({ name: "A", storyId: "a--primary", storyFile: "src/A/A.stories.tsx" }),
      target({ name: "Legacy", storyId: "legacy--default" }), // no storyFile → not graph-rooted
    ];
    expect(buildProjectGraph(dir, targets, read)).toBeUndefined();
  });

  it("returns undefined when a story file escapes cwd ('../') — keys can't match git paths", () => {
    const targets = [target({ name: "A", storyId: "a--primary", storyFile: "../src/A/A.stories.tsx" })];
    expect(buildProjectGraph(dir, targets, read)).toBeUndefined();
  });

  it("returns undefined with no tsconfig (can't trust alias resolution)", () => {
    const noTs = mkdtempSync(join(tmpdir(), "vg-nots-"));
    try {
      mkdirSync(join(noTs, "src"), { recursive: true });
      writeFileSync(join(noTs, "src/A.stories.tsx"), "export const P = 1;\n");
      const targets = [target({ name: "A", storyId: "a--primary", storyFile: "src/A.stories.tsx" })];
      expect(buildProjectGraph(noTs, targets, read)).toBeUndefined();
    } finally {
      rmSync(noTs, { recursive: true, force: true });
    }
  });
});

describe("Phase 1 end-to-end: real graph → decideScope → scope.json → filterByScope", () => {
  let dir = "";
  const write = (rel: string, body: string): void => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vg-e2e-"));
    write("tsconfig.json", JSON.stringify({ compilerOptions: { moduleResolution: "node" }, include: ["."] }));
    write("src/Shared/Shared.tsx", "export const Shared = 1;\n");
    // BOTH stories import the shared component — the cross-import Phase 0 can't see.
    write("src/A/A.stories.tsx", `import { Shared } from "../Shared/Shared";\nexport const Primary = Shared;\n`);
    write("src/B/B.stories.tsx", `import { Shared } from "../Shared/Shared";\nexport const Primary = Shared;\n`);
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("editing a shared component scopes BOTH stories, and the scope round-trips through capture", () => {
    const targets: RenderTarget[] = [
      target({ name: "A", storyId: "a--primary", storyFile: "src/A/A.stories.tsx" }),
      target({ name: "B", storyId: "b--primary", storyFile: "src/B/B.stories.tsx" }),
    ];
    const graph = buildProjectGraph(dir, targets, (p) => readFileSync(p, "utf8"));
    expect(graph?.built).toBe(true);

    const decision = decideScope({
      changedFiles: ["src/Shared/Shared.tsx"],
      gitResolved: true,
      forceAll: false,
      uiGlobs: UI_GLOBS,
      tokenGlobs: [],
      globalGlobs: [],
      targets,
      graph,
    });
    expect(decision.mode).toBe("scoped");
    expect(decision.components).toEqual(["A", "B"]);
    expect(decision.storyIds).toEqual(["a--primary", "b--primary"]);

    // The serialized decision round-trips through the capture-side reader + filter.
    const scope = readScopeFile("scope.json", () => `${JSON.stringify(decision, null, 2)}\n`);
    expect(scope).not.toBeNull();
    const kept = filterByScope(targets, scope!);
    expect(kept.map((t) => t.storyId).sort()).toEqual(["a--primary", "b--primary"]);
  });
});

describe("Phase 3 end-to-end: a CSS @import chain reaches the story", () => {
  let dir = "";
  const write = (rel: string, body: string): void => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vg-css-"));
    write("tsconfig.json", JSON.stringify({ compilerOptions: { moduleResolution: "node" }, include: ["."] }));
    // shared.css is reached ONLY via a CSS @import — invisible to the JS/TS extractor.
    write("src/Shared/shared.css", ".shared { color: red }\n");
    write("src/A/A.css", `@import "../Shared/shared.css";\n.a { color: blue }\n`);
    write("src/A/A.tsx", `import "./A.css";\nexport const A = 1;\n`);
    write("src/A/A.stories.tsx", `import { A } from "./A";\nexport const Primary = A;\n`);
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("editing a stylesheet reached only via @import scopes the importing story", () => {
    const targets: RenderTarget[] = [
      target({ name: "A", storyId: "a--primary", storyFile: "src/A/A.stories.tsx" }),
    ];
    const graph = buildProjectGraph(dir, targets, (p) => readFileSync(p, "utf8"));
    expect(graph?.built).toBe(true);
    // The CSS @import edge put shared.css into A's story closure.
    expect(graph?.fileToStoryFiles.has("src/shared/shared.css")).toBe(true);

    const decision = decideScope({
      changedFiles: ["src/Shared/shared.css"],
      gitResolved: true,
      forceAll: false,
      uiGlobs: UI_GLOBS,
      tokenGlobs: [],
      globalGlobs: [],
      targets,
      graph,
    });
    expect(decision.mode).toBe("scoped");
    expect(decision.storyIds).toEqual(["a--primary"]);
  });
});

describe("Phase 3: graph cache (incremental, never-stale)", () => {
  let dir = "";
  const read = (p: string): string => readFileSync(p, "utf8");
  const targets: RenderTarget[] = [target({ name: "A", storyId: "a--primary", storyFile: "src/A/A.stories.tsx" })];
  const write = (rel: string, body: string): void => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  const cachePath = (): string => join(dir, ".visual-guard", "graph.json");
  const cacheKey = (): string => JSON.parse(readFileSync(cachePath(), "utf8")).key as string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vg-gcache-"));
    write(".gitignore", ".visual-guard/\n"); // so the cache file isn't itself a tree change
    write("tsconfig.json", JSON.stringify({ compilerOptions: { moduleResolution: "node" }, include: ["."] }));
    write("src/Shared/Shared.tsx", "export const Shared = 1;\n");
    write("src/Other/Other.tsx", "export const Other = 2;\n");
    write("src/A/A.stories.tsx", `import { Shared } from "../Shared/Shared";\nexport const Primary = Shared;\n`);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a cache and a second build (same tree) yields the same graph with a stable key", () => {
    const g1 = buildProjectGraph(dir, targets, read);
    expect(g1?.fileToStoryFiles.has("src/shared/shared.tsx")).toBe(true);
    const key1 = cacheKey();
    const g2 = buildProjectGraph(dir, targets, read);
    expect(cacheKey()).toBe(key1); // tree + options unchanged → cache reused, key stable
    expect(g2?.fileToStoryFiles.has("src/shared/shared.tsx")).toBe(true);
  });

  it("a CONTENT change (stable tree) re-parses — the cache never serves a stale edge", () => {
    const g1 = buildProjectGraph(dir, targets, read);
    expect(g1?.fileToStoryFiles.has("src/shared/shared.tsx")).toBe(true);
    expect(g1?.fileToStoryFiles.has("src/other/other.tsx")).toBe(false);

    // Switch the story to import a DIFFERENT already-existing component — no file added/removed, so
    // the tree fingerprint is stable; only A.stories' content hash changes.
    write("src/A/A.stories.tsx", `import { Other } from "../Other/Other";\nexport const Primary = Other;\n`);
    const g2 = buildProjectGraph(dir, targets, read);
    expect(cacheKey()).toBe(cacheKey()); // (key derives from the tree, which didn't change)
    expect(g2?.fileToStoryFiles.has("src/other/other.tsx")).toBe(true); // fresh edge
    expect(g2?.fileToStoryFiles.has("src/shared/shared.tsx")).toBe(false); // stale edge gone
  });

  it("invalidates the cache key when the file tree changes (a file is added)", () => {
    buildProjectGraph(dir, targets, read);
    const key1 = cacheKey();
    write("src/New.tsx", "export const New = 3;\n"); // untracked add → ls-files --others changes
    buildProjectGraph(dir, targets, read);
    expect(cacheKey()).not.toBe(key1);
  });

  it("invalidates the cache when a tracked file is deleted from the working tree (UNSTAGED)", () => {
    // `git ls-files` still lists an unstaged-deleted file, so this blind spot must be closed via
    // `--deleted` — otherwise a stale edge could be served (the file's resolution may have shifted).
    buildProjectGraph(dir, targets, read);
    const key1 = cacheKey();
    rmSync(join(dir, "src/Other/Other.tsx")); // working-tree deletion, not staged
    buildProjectGraph(dir, targets, read);
    expect(cacheKey()).not.toBe(key1);
  });
});
