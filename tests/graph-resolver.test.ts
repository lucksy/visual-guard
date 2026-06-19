import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResolver } from "../scripts/lib/graph/resolver";
import { buildImportGraph, graphComplete } from "../scripts/lib/graph/import-graph";

/**
 * Real TypeScript-compiler-API resolution against an on-disk fixture project. Proves the load-bearing
 * Phase-1 facts the design probes found: relative + barrel resolution, the CSS fs-fallback edge,
 * node_modules as a boundary, computed-dynamic / missing imports → incomplete, and the cross-import
 * inversion (B's story imports A → editing A scopes B too).
 */
describe("createResolver + buildImportGraph (real TS resolution)", () => {
  let dir = "";
  const write = (rel: string, body: string): void => {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vg-graph-"));
    write("tsconfig.json", JSON.stringify({ compilerOptions: { moduleResolution: "node", jsx: "react-jsx" }, include: ["."] }));
    write("src/A/A.stories.tsx", `import { A } from "./A";\nexport const Primary = A;\n`);
    write("src/A/A.tsx", `import "./A.css";\nimport { shared } from "../shared";\nexport const A = shared;\n`);
    write("src/A/A.css", `.a {}\n`);
    write("src/shared.ts", `export const shared = 1;\n`);
    // B's STORY imports A directly — the cross-import case Phase 0 can't see.
    write("src/B/B.stories.tsx", `import { A } from "../A/A";\nexport const Primary = A;\n`);
    write("src/dyn/Dyn.tsx", `const name = "./x";\nexport const load = () => import(name);\n`);
    write("src/miss/Miss.tsx", `import "./does-not-exist";\nexport const x = 1;\n`);
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("extracts + resolves: relative + CSS fs-fallback edges, node_modules excluded", () => {
    const r = createResolver(dir, (p) => readFileSync(p, "utf8"));
    expect(r.tsconfigFound).toBe(true);
    const out = r.extractImports(join(dir, "src/A/A.tsx"));
    expect(out.unresolvedOrDynamic).toBe(false);
    const rels = out.resolved.map((p) => p.slice(dir.length + 1).split("\\").join("/")).sort();
    // ./A.css resolves via the fs-fallback; ../shared resolves via TS. (No node_modules here.)
    expect(rels).toEqual(["src/A/A.css", "src/shared.ts"]);
  });

  it("flags a computed dynamic import() as graph-incomplete", () => {
    const r = createResolver(dir, (p) => readFileSync(p, "utf8"));
    expect(r.extractImports(join(dir, "src/dyn/Dyn.tsx")).unresolvedOrDynamic).toBe(true);
  });

  it("flags a missing relative import as unresolved (not a silent clean file)", () => {
    const r = createResolver(dir, (p) => readFileSync(p, "utf8"));
    expect(r.extractImports(join(dir, "src/miss/Miss.tsx")).unresolvedOrDynamic).toBe(true);
  });

  it("follows a CSS url() asset to a real file (a font/image edge), as a content-hashed leaf", () => {
    write("src/A/A.css", `@font-face { src: url('./Brand.woff2'); }\n.a { background: url(../shared/bg.png); }\n`);
    write("src/A/Brand.woff2", `FONT-BYTES`);
    write("src/shared/bg.png", `IMG-BYTES`);
    const r = createResolver(dir, (p) => readFileSync(p, "utf8"));
    const out = r.extractImports(join(dir, "src/A/A.css"));
    expect(out.unresolvedOrDynamic).toBe(false);
    const rels = out.resolved.map((p) => p.slice(dir.length + 1).split("\\").join("/")).sort();
    expect(rels).toEqual(["src/A/Brand.woff2", "src/shared/bg.png"]);
    // The asset itself is a leaf: no imports, never parsed as code.
    expect(r.extractImports(join(dir, "src/A/Brand.woff2"))).toEqual({
      resolved: [],
      unresolvedOrDynamic: false,
    });
  });

  it("marks a CSS file with a missing relative url() asset as incomplete (never a silent miss)", () => {
    write("src/A/A.css", `.a { background: url(./not-here.png); }\n`);
    const r = createResolver(dir, (p) => readFileSync(p, "utf8"));
    expect(r.extractImports(join(dir, "src/A/A.css")).unresolvedOrDynamic).toBe(true);
  });

  it("threads a story → css → font asset into the story's closure (the per-story font hole)", () => {
    write("src/A/A.css", `@font-face { src: url('./Brand.woff2'); }\n`);
    write("src/A/Brand.woff2", `FONT-BYTES`);
    const r = createResolver(dir, (p) => readFileSync(p, "utf8"));
    const graph = buildImportGraph(dir, [join(dir, "src/A/A.stories.tsx")], r);
    expect(graph.built).toBe(true);
    // Editing the font now scopes A's story (it was invisible before url() edges).
    expect([...(graph.fileToStoryFiles.get("src/a/brand.woff2") ?? [])]).toEqual([
      "src/a/a.stories.tsx",
    ]);
  });

  it("inverts the real graph so editing A's component scopes BOTH A's and B's stories", () => {
    const r = createResolver(dir, (p) => readFileSync(p, "utf8"));
    const roots = [join(dir, "src/A/A.stories.tsx"), join(dir, "src/B/B.stories.tsx")];
    const graph = buildImportGraph(dir, roots, r);
    expect(graph.built).toBe(true);
    expect(graphComplete(graph)).toBe(true);
    // src/A/A.tsx is reached by A.stories (imports ./A) AND B.stories (imports ../A/A).
    expect([...(graph.fileToStoryFiles.get("src/a/a.tsx") ?? [])].sort()).toEqual([
      "src/a/a.stories.tsx",
      "src/b/b.stories.tsx",
    ]);
    // The shared util reaches both as well.
    expect([...(graph.fileToStoryFiles.get("src/shared.ts") ?? [])].sort()).toEqual([
      "src/a/a.stories.tsx",
      "src/b/b.stories.tsx",
    ]);
  });
});
