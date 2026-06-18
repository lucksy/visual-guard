import { describe, it, expect } from "vitest";
import { extractCssSpecifiers, isCssFile } from "../scripts/lib/graph/css-imports";

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
