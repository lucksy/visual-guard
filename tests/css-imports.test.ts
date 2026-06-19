import { describe, it, expect } from "vitest";
import { classifyUrlTarget, extractCssSpecifiers, isCssFile } from "../scripts/lib/graph/css-imports";

describe("isCssFile", () => {
  it("matches stylesheet extensions (case-insensitive), not source files", () => {
    expect(isCssFile("a/b.css")).toBe(true);
    expect(isCssFile("a/B.SCSS")).toBe(true);
    expect(isCssFile("a/b.less")).toBe(true);
    expect(isCssFile("a/b.tsx")).toBe(false);
    expect(isCssFile("a/b")).toBe(false);
  });
});

describe("extractCssSpecifiers", () => {
  it("extracts @import string + url() forms; ignores media queries and remote/inline urls", () => {
    const css = [
      `@import "./a.css";`,
      `@import url('./b.scss') screen and (min-width: 1px);`,
      `@import url(./c.css);`,
      `@import "https://x/y.css";`,
      `@import "//cdn/z.css";`,
      `.x { color: red }`,
    ].join("\n");
    const { specifiers, dynamic } = extractCssSpecifiers(css, ".css");
    expect(specifiers).toEqual(["./a.css", "./b.scss", "./c.css"]); // remote + protocol-relative dropped
    expect(dynamic).toBe(false);
  });

  it("extracts SCSS @use / @forward targets", () => {
    expect(extractCssSpecifiers(`@use "./tokens" as t;\n@forward "./list";`, ".scss").specifiers).toEqual([
      "./tokens",
      "./list",
    ]);
  });

  it("extracts CSS-Modules `composes … from`, but not a same-file/global composes", () => {
    const css = `.a { composes: base from "./shared.css"; }\n.b { composes: local; }`;
    expect(extractCssSpecifiers(css, ".css").specifiers).toEqual(["./shared.css"]);
  });

  it("extracts ALL comma-separated @import targets (not just the first)", () => {
    expect(extractCssSpecifiers(`@import "./a.css", "./b.css";`, ".css").specifiers).toEqual([
      "./a.css",
      "./b.css",
    ]);
    expect(extractCssSpecifiers(`@import url(./a.css), url("./b.css");`, ".css").specifiers).toEqual([
      "./a.css",
      "./b.css",
    ]);
    // A single target with a comma in its MEDIA query is still one target (media has no quotes).
    expect(extractCssSpecifiers(`@import "./a.css" screen, print;`, ".css").specifiers).toEqual([
      "./a.css",
    ]);
  });

  it("recovers the path from LESS option syntax @import (reference) \"./x.less\"", () => {
    expect(extractCssSpecifiers(`@import (reference) "./x.less";`, ".less").specifiers).toEqual([
      "./x.less",
    ]);
  });

  it("extracts EVERY `from` in a multi-target composes declaration", () => {
    const css = `.x { composes: a from "./x.css", b from "./y.css"; }`;
    expect(extractCssSpecifiers(css, ".css").specifiers).toEqual(["./x.css", "./y.css"]);
  });

  it("flags an interpolated or bare @import as dynamic (→ the file is graph-incomplete)", () => {
    expect(extractCssSpecifiers(`@import "#{$theme}/x.css";`, ".scss").dynamic).toBe(true); // scss interpolation
    expect(extractCssSpecifiers(`@import nib;`, ".css").dynamic).toBe(true); // bare identifier
  });
});

describe("classifyUrlTarget", () => {
  it("treats relative paths as asset edges", () => {
    expect(classifyUrlTarget("./bg.png")).toBe("asset");
    expect(classifyUrlTarget("../fonts/Brand.woff2")).toBe("asset");
    expect(classifyUrlTarget("images/sprite.svg")).toBe("asset");
  });
  it("skips fragments, remote, data, and ABSOLUTE (static-serve) targets", () => {
    expect(classifyUrlTarget("#gradient")).toBe("skip"); // in-document reference
    expect(classifyUrlTarget("https://cdn/x.woff2")).toBe("skip");
    expect(classifyUrlTarget("//cdn/x.png")).toBe("skip");
    expect(classifyUrlTarget("data:image/png;base64,AAAA")).toBe("skip");
    expect(classifyUrlTarget("/logo.png")).toBe("skip"); // absolute → public/staticDirs (global, not closure)
  });
  it("flags interpolation / var() as dynamic (can't follow → importer incomplete)", () => {
    expect(classifyUrlTarget("#{$icon}.png")).toBe("dynamic"); // scss
    expect(classifyUrlTarget("@{icon}.png")).toBe("dynamic"); // less
    expect(classifyUrlTarget("var(--logo)")).toBe("dynamic");
  });
});

describe("extractCssSpecifiers — url() asset edges", () => {
  it("collects relative url() assets from any declaration (@font-face src, background, etc.)", () => {
    const css = [
      `@font-face { font-family: Brand; src: url('../fonts/Brand.woff2') format('woff2'), url(../fonts/Brand.woff); }`,
      `.logo { background: url("./logo.png") no-repeat; }`,
      `.i { mask-image: url(icons/check.svg); }`,
    ].join("\n");
    const { assets, dynamic } = extractCssSpecifiers(css, ".css");
    expect(assets).toEqual([
      "../fonts/Brand.woff2",
      "../fonts/Brand.woff",
      "./logo.png",
      "icons/check.svg",
    ]);
    expect(dynamic).toBe(false);
  });

  it("skips remote / data / absolute / fragment url() (not story-local closure edges)", () => {
    const css = [
      `.a { background: url(https://cdn/x.png); }`,
      `.b { background: url('data:image/gif;base64,AAA'); }`,
      `.c { background: url(/hero.jpg); }`, // absolute → static-serve, covered by globals
      `.d { clip-path: url(#mask); }`,
    ].join("\n");
    expect(extractCssSpecifiers(css, ".css").assets).toEqual([]);
  });

  it("flags an interpolated / var() url() as dynamic (→ importer incomplete, never skipped)", () => {
    expect(extractCssSpecifiers(`.a{ background: url("#{$dir}/x.png"); }`, ".scss").dynamic).toBe(true);
    expect(extractCssSpecifiers(`.a{ background: url(var(--bg)); }`, ".css").dynamic).toBe(true);
  });

  it("does not treat @import url() as an asset (it's an at-rule import, captured as a specifier)", () => {
    const out = extractCssSpecifiers(`@import url(./a.css);\n.x{ background: url(./bg.png) }`, ".css");
    expect(out.specifiers).toEqual(["./a.css"]);
    expect(out.assets).toEqual(["./bg.png"]);
  });
});
