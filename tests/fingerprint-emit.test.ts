import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createResolver } from "../scripts/lib/graph/resolver";
import { buildImportGraph, type ImportGraph } from "../scripts/lib/graph/import-graph";
import {
  computeFingerprintsCurrent,
  parseHeadTemplate,
  resolveChromiumRevision,
  resolvePlaywrightVersion,
} from "../scripts/lib/fingerprint-emit";
import type { RenderTarget } from "../scripts/lib/targets";

describe("resolveChromiumRevision / resolvePlaywrightVersion", () => {
  it("reads the chromium revision + version from a playwright browsers.json/package.json", () => {
    const read = (p: string): string => {
      if (p.endsWith("browsers.json")) {
        return JSON.stringify({ browsers: [{ name: "chromium", revision: "1148" }, { name: "firefox", revision: "1.0" }] });
      }
      if (p.endsWith("package.json")) return JSON.stringify({ version: "1.49.1" });
      throw new Error("ENOENT");
    };
    expect(resolveChromiumRevision("/x", read)).toBe("1148");
    expect(resolvePlaywrightVersion("/x", read)).toBe("1.49.1");
  });
  it("returns '' (the documented floor) when nothing is resolvable", () => {
    const fail = (): string => {
      throw new Error("ENOENT");
    };
    expect(resolveChromiumRevision("/x", fail)).toBe("");
    expect(resolvePlaywrightVersion("/x", fail)).toBe("");
  });
});

describe("parseHeadTemplate", () => {
  const tmpl = "/proj/.storybook/preview-head.html";
  const present = new Set(["/proj/.storybook/overrides.css", "/proj/.storybook/fonts/Brand.woff2"]);
  const isFile = (abs: string): boolean => present.has(abs);

  it("resolves a RELATIVE local <link> to a root", () => {
    const out = parseHeadTemplate(`<link rel="stylesheet" href="./overrides.css">`, tmpl, isFile);
    expect(out.roots).toEqual(["/proj/.storybook/overrides.css"]);
    expect(out.dynamic).toBe(false);
  });
  it("resolves an inline <style> @font-face url() asset to a root (the confirmed hole)", () => {
    const out = parseHeadTemplate(
      `<style>@font-face { font-family: Brand; src: url('./fonts/Brand.woff2'); }</style>`,
      tmpl,
      isFile,
    );
    expect(out.roots).toEqual(["/proj/.storybook/fonts/Brand.woff2"]);
    expect(out.dynamic).toBe(false);
  });
  it("skips remote / data / absolute targets (link + inline style)", () => {
    const html = [
      `<link href="https://fonts.googleapis.com/x" rel="stylesheet">`,
      `<link rel="stylesheet" href="/global.css">`,
      `<style>.a { background: url(https://cdn/x.png); } .b { background: url(/hero.jpg); }</style>`,
    ].join("\n");
    const out = parseHeadTemplate(html, tmpl, isFile);
    expect(out.roots).toEqual([]);
    expect(out.dynamic).toBe(false);
  });
  it("flags an UNRESOLVABLE relative target (link OR inline-style url) as dynamic → caller fails closed", () => {
    expect(parseHeadTemplate(`<link rel="stylesheet" href="./missing.css">`, tmpl, isFile).dynamic).toBe(true);
    expect(parseHeadTemplate(`<style>.a{ background: url(./missing.png) }</style>`, tmpl, isFile).dynamic).toBe(true);
    expect(parseHeadTemplate(`<style>.a{ background: url(var(--x)) }</style>`, tmpl, isFile).dynamic).toBe(true);
  });
});

describe("computeFingerprintsCurrent (the reachability-G emit)", () => {
  let dir = "";
  const write = (rel: string, body: string): void => {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  };
  const REL = "src/Button/Button.stories.tsx";

  const target = (): RenderTarget => ({
    instance: "components",
    name: "Button",
    state: "primary",
    viewport: 1280,
    kind: "storybook",
    url: "http://localhost:6006/iframe.html?id=button--primary&viewMode=story",
    storyId: "button--primary",
    storyFile: REL,
  });

  const storyGraph = (): ImportGraph => {
    const resolver = createResolver(dir, (p) => readFileSync(p, "utf8"));
    return buildImportGraph(dir, [join(dir, REL)], resolver);
  };

  /** globalRoots = the glob-matched globals (here: the global css + the SB preview entry point). */
  const globalRoots = (): string[] => [
    resolve(dir, "src/styles/global.css"),
    resolve(dir, ".storybook/preview.ts"),
  ];

  // Returns just the fps map (most assertions want it); the full {fps, inputs} is exercised separately.
  const emit = (over: Partial<Parameters<typeof computeFingerprintsCurrent>[0]> = {}) =>
    computeFingerprintsCurrent({
      cwd: dir,
      targets: [target()],
      storyGraph: storyGraph(),
      globalRoots: globalRoots(),
      playwrightVersion: "1.49.1",
      chromiumRevision: "1148",
      ...over,
    }).fps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vg-fp-"));
    write("tsconfig.json", JSON.stringify({ compilerOptions: { moduleResolution: "node", jsx: "react-jsx" }, include: ["."] }));
    write("src/Button/Button.stories.tsx", `import { Button } from "./Button";\nexport const Primary = Button;\n`);
    write("src/Button/Button.tsx", `import "./Button.css";\nexport const Button = 1;\n`);
    write("src/Button/Button.css", `.b { color: red }\n`);
    write("src/styles/global.css", `body { margin: 0 }\n`);
    // The SB preview imports a global stylesheet of a NON-STANDARD name (the decorator/addon case).
    write(".storybook/preview.ts", `import "../src/brand.css";\nexport const decorators = [];\n`);
    write("src/brand.css", `:root { --brand: blue }\n`);
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("emits a stable fingerprint for a fingerprintable story", () => {
    const a = emit();
    expect(Object.keys(a)).toEqual(["components/Button/primary@1280.png"]);
    expect(emit()["components/Button/primary@1280.png"]).toBe(a["components/Button/primary@1280.png"]);
  });

  it("changes the fingerprint when a CLOSURE file (the component's CSS) changes", () => {
    const before = emit()["components/Button/primary@1280.png"];
    write("src/Button/Button.css", `.b { color: blue }\n`);
    expect(emit()["components/Button/primary@1280.png"]).not.toBe(before);
  });

  it("changes the fingerprint when a name-globbed GLOBAL file changes", () => {
    const before = emit()["components/Button/primary@1280.png"];
    write("src/styles/global.css", `body { margin: 8px }\n`);
    expect(emit()["components/Button/primary@1280.png"]).not.toBe(before);
  });

  it("changes the fingerprint when a DECORATOR-imported CSS of a non-standard name changes (reachability-G)", () => {
    // brand.css matches NO global glob — it is covered ONLY because preview.ts imports it. This is the
    // exact 'common' hole the audit found in the name-glob design.
    const before = emit()["components/Button/primary@1280.png"];
    write("src/brand.css", `:root { --brand: green }\n`);
    expect(emit()["components/Button/primary@1280.png"]).not.toBe(before);
  });

  it("changes the fingerprint when the engine (Chromium revision) changes", () => {
    const before = emit()["components/Button/primary@1280.png"];
    expect(emit({ chromiumRevision: "1149" })["components/Button/primary@1280.png"]).not.toBe(before);
  });

  it("FAILS CLOSED (emits nothing) when a global root's closure has a dynamic import", () => {
    write(".storybook/preview.ts", `const m = "../src/brand.css";\nexport const load = () => import(m);\n`);
    expect(emit()).toEqual({});
  });

  it("FAILS CLOSED when there is no tsconfig (alias resolution can't be trusted)", () => {
    rmSync(join(dir, "tsconfig.json"));
    expect(emit()).toEqual({});
  });

  it("does NOT emit for a target with no storyFile (app route / Ladle / explicit list)", () => {
    const t = { ...target(), storyId: undefined, storyFile: undefined, kind: "app" as const };
    expect(computeFingerprintsCurrent({
      cwd: dir, targets: [t], storyGraph: storyGraph(), globalRoots: globalRoots(),
      playwrightVersion: "1.49.1", chromiumRevision: "1148",
    }).fps).toEqual({});
  });

  it("returns the INPUTS content map (globals + emitted closures) for the TOCTOU guard", () => {
    const { fps, inputs } = computeFingerprintsCurrent({
      cwd: dir, targets: [target()], storyGraph: storyGraph(), globalRoots: globalRoots(),
      playwrightVersion: "1.49.1", chromiumRevision: "1148",
    });
    expect(Object.keys(fps)).toEqual(["components/Button/primary@1280.png"]);
    // The component's closure (Button.tsx + Button.css) AND the globals (global.css + preview's brand.css)
    // are all present, so capture can re-verify none changed mid-run.
    expect(Object.keys(inputs).sort()).toEqual(
      expect.arrayContaining([
        "src/Button/Button.css",
        "src/Button/Button.tsx",
        "src/brand.css",
        "src/styles/global.css",
      ]),
    );
  });

  it("FAILS CLOSED when a preview-head.html links an unresolvable local stylesheet", () => {
    write(".storybook/preview-head.html", `<link rel="stylesheet" href="./missing.css">`);
    expect(emit({ globalRoots: [...globalRoots(), resolve(dir, ".storybook/preview-head.html")] })).toEqual({});
  });

  it("covers a preview-head linked LOCAL stylesheet in G (its change busts the fingerprint)", () => {
    write(".storybook/preview-head.html", `<link rel="stylesheet" href="./head.css">`);
    write(".storybook/head.css", `* { box-sizing: border-box }\n`);
    const roots = [...globalRoots(), resolve(dir, ".storybook/preview-head.html")];
    const before = emit({ globalRoots: roots })["components/Button/primary@1280.png"];
    expect(before).toBeDefined();
    write(".storybook/head.css", `* { box-sizing: content-box }\n`);
    expect(emit({ globalRoots: roots })["components/Button/primary@1280.png"]).not.toBe(before);
  });

  it("covers an inline-<style> @font-face asset in G — swapping the woff2 busts the fingerprint", () => {
    write(".storybook/preview-head.html", `<style>@font-face { font-family: Brand; src: url('./Brand.woff2'); }</style>`);
    write(".storybook/Brand.woff2", `FONT-V1`);
    const roots = [...globalRoots(), resolve(dir, ".storybook/preview-head.html")];
    const before = emit({ globalRoots: roots })["components/Button/primary@1280.png"];
    expect(before).toBeDefined();
    write(".storybook/Brand.woff2", `FONT-V2-RESUBSET`); // same path, new bytes — the exact silent-skip scenario
    expect(emit({ globalRoots: roots })["components/Button/primary@1280.png"]).not.toBe(before);
  });

  it("FAILS CLOSED when there are NO global roots (can't enumerate globals → G would be engine-only)", () => {
    expect(emit({ globalRoots: [] })).toEqual({});
  });

  it("FAILS CLOSED when the engine pin is unresolved (chromiumRevision or playwrightVersion '')", () => {
    expect(emit({ chromiumRevision: "" })).toEqual({});
    expect(emit({ playwrightVersion: "" })).toEqual({});
  });
});
