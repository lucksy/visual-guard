import { describe, it, expect } from "vitest";
import {
  detectFormat,
  parseCssFamily,
  parseDtcg,
  parseSource,
  parseStyleDictionary,
  parseTokensStudio,
} from "../scripts/lib/token-adapters";
import type { Token } from "../scripts/lib/tokens-model";

const ctx = { source: "test" };
const by = (tokens: Token[], name: string): Token => {
  const found = tokens.find((t) => t.name === name);
  if (!found) {
    throw new Error(`token "${name}" not found in [${tokens.map((t) => t.name).join(", ")}]`);
  }
  return found;
};

describe("CSS custom properties", () => {
  const css = `
    :root {
      --space-md: 8px;
      --color-bg: #ffffff;
      --color-primary: var(--color-bg);
      --radius-lg: 0.5rem;
      --z-index-modal: 1000;
    }
    [data-theme="dark"] { --color-bg: #000000; }
  `;

  it("parses custom properties with inferred types", () => {
    const tokens = parseCssFamily(css, ctx, "css");
    expect(by(tokens, "--space-md")).toMatchObject({ value: "8px", type: "dimension" });
    expect(by(tokens, "--color-bg")).toMatchObject({ value: "#ffffff", type: "color" });
    expect(by(tokens, "--radius-lg")).toMatchObject({ type: "radius" });
    expect(by(tokens, "--z-index-modal")).toMatchObject({ type: "zIndex" });
  });

  it("resolves a var() alias and records the reference", () => {
    const primary = by(parseCssFamily(css, ctx, "css"), "--color-primary");
    expect(primary.value).toBe("#ffffff");
    expect(primary.reference).toBe("--color-bg");
    expect(primary.raw).toBe("var(--color-bg)");
  });

  it("ignores a mode override unless that mode is selected", () => {
    expect(by(parseCssFamily(css, ctx, "css"), "--color-bg").value).toBe("#ffffff");
  });

  it("applies the selected mode (dark) and tags it", () => {
    const dark = parseCssFamily(css, { source: "t", mode: "dark" }, "css");
    expect(by(dark, "--color-bg")).toMatchObject({ value: "#000000", mode: "dark" });
    // an alias to an overridden token resolves through the mode
    expect(by(dark, "--color-primary").value).toBe("#000000");
  });
});

describe("Tailwind v4 @theme", () => {
  const tw = `@theme {
    --color-primary: #3b82f6;
    --spacing-4: 1rem;
    --text-lg: 1.125rem;
    --font-weight-bold: 700;
    --radius-md: 0.375rem;
  }`;

  it("detects @theme as tailwind", () => {
    expect(detectFormat("globals.css", tw)).toBe("tailwind");
  });

  it("types tokens from the tailwind namespace prefix", () => {
    const tokens = parseSource("globals.css", tw, "auto", ctx);
    expect(by(tokens, "--color-primary").type).toBe("color");
    expect(by(tokens, "--spacing-4").type).toBe("dimension");
    expect(by(tokens, "--text-lg").type).toBe("fontSize");
    expect(by(tokens, "--font-weight-bold").type).toBe("fontWeight");
    expect(by(tokens, "--radius-md").type).toBe("radius");
  });
});

describe("SCSS variables", () => {
  const scss = `
    $space-md: 8px !default;
    $color-bg: #fff;
    $color-primary: $color-bg;
  `;
  it("parses $vars, strips !default, resolves aliases", () => {
    const tokens = parseCssFamily(scss, ctx, "scss");
    expect(by(tokens, "$space-md")).toMatchObject({ value: "8px", type: "dimension" });
    expect(by(tokens, "$color-primary")).toMatchObject({ value: "#fff", reference: "$color-bg" });
  });
});

describe("Less variables", () => {
  const less = `
    @space-md: 8px;
    @color-bg: #fff;
    @color-primary: @color-bg;
  `;
  it("parses @vars (atrule variables) and resolves aliases", () => {
    const tokens = parseCssFamily(less, ctx, "less");
    expect(by(tokens, "@space-md")).toMatchObject({ value: "8px", type: "dimension" });
    expect(by(tokens, "@color-primary")).toMatchObject({ value: "#fff", reference: "@color-bg" });
  });
});

describe("DTCG (Design Tokens Format Module)", () => {
  const dtcg = JSON.stringify({
    color: {
      $type: "color",
      brand: { $value: "#ff0000" },
      primary: { $value: "{color.brand}" },
    },
    space: { md: { $value: "8px", $type: "dimension" } },
    shadow: {
      sm: {
        $type: "shadow",
        $value: { color: "#000000", offsetX: "0", offsetY: "1px", blur: "2px", spread: "0" },
      },
    },
  });

  it("reads $value/$type, inherits group type, resolves {alias}", () => {
    const tokens = parseDtcg(dtcg, ctx);
    expect(by(tokens, "color.brand")).toMatchObject({ value: "#ff0000", type: "color" });
    const primary = by(tokens, "color.primary");
    expect(primary).toMatchObject({ value: "#ff0000", type: "color", reference: "color.brand" });
    expect(by(tokens, "space.md")).toMatchObject({ value: "8px", type: "dimension" });
  });

  it("stringifies a composite value", () => {
    const shadow = by(parseDtcg(dtcg, ctx), "shadow.sm");
    expect(shadow.type).toBe("shadow");
    expect(JSON.parse(shadow.value)).toMatchObject({ blur: "2px" });
  });

  it("detects .tokens as dtcg", () => {
    expect(detectFormat("design.tokens", dtcg)).toBe("dtcg");
  });
});

describe("Style Dictionary", () => {
  const v3 = JSON.stringify({
    color: {
      base: { red: { value: "#ff0000" } },
      font: { primary: { value: "{color.base.red.value}" } },
    },
    size: { sm: { value: "8px" } },
  });

  it("parses v3 value/type with a .value reference and CTI typing", () => {
    const tokens = parseStyleDictionary(v3, ctx);
    expect(by(tokens, "color.base.red")).toMatchObject({ value: "#ff0000", type: "color" });
    expect(by(tokens, "color.font.primary")).toMatchObject({
      value: "#ff0000",
      reference: "color.base.red",
    });
    expect(by(tokens, "size.sm").type).toBe("dimension");
  });

  it("parses v4 $value/$type", () => {
    const v4 = JSON.stringify({ color: { red: { $value: "#f00", $type: "color" } } });
    expect(by(parseStyleDictionary(v4, ctx), "color.red")).toMatchObject({
      value: "#f00",
      type: "color",
    });
  });

  it("detects a value-only JSON as style-dictionary", () => {
    expect(detectFormat("tokens.json", v3)).toBe("style-dictionary");
  });
});

describe("Tokens Studio", () => {
  const studio = JSON.stringify({
    global: {
      color: {
        red: { value: "#ff0000", type: "color" },
        primary: { value: "{global.color.red}", type: "color" },
      },
      space: { md: { value: "8px", type: "spacing" } },
    },
    $themes: [],
    $metadata: { tokenSetOrder: ["global"] },
  });

  it("maps studio types, resolves refs, skips $themes/$metadata", () => {
    const tokens = parseTokensStudio(studio, ctx);
    expect(tokens.some((t) => t.name.startsWith("$"))).toBe(false);
    expect(by(tokens, "global.color.red")).toMatchObject({ value: "#ff0000", type: "color" });
    expect(by(tokens, "global.color.primary").reference).toBe("global.color.red");
    expect(by(tokens, "global.space.md").type).toBe("dimension"); // spacing → dimension
  });

  it("detects $metadata as tokens-studio", () => {
    expect(detectFormat("tokens.json", studio)).toBe("tokens-studio");
  });
});

describe("alias resolution edge cases (no crash, keep literal)", () => {
  it("keeps an unresolved CSS alias literal with no reference", () => {
    const t = by(parseCssFamily(":root{--x: var(--nope)}", ctx, "css"), "--x");
    expect(t.value).toBe("var(--nope)");
    expect(t.reference).toBeUndefined();
  });

  it("survives a CSS alias cycle without infinite recursion", () => {
    const tokens = parseCssFamily(":root{--a: var(--b); --b: var(--a)}", ctx, "css");
    expect(tokens.map((t) => t.name).sort()).toEqual(["--a", "--b"]);
  });

  it("keeps an unresolved DTCG alias literal", () => {
    const json = JSON.stringify({ a: { $value: "{missing.token}", $type: "color" } });
    expect(by(parseDtcg(json, ctx), "a").value).toBe("{missing.token}");
  });
});

describe("detectFormat + parseSource dispatch", () => {
  it("detects by extension", () => {
    expect(detectFormat("a.css", ":root{--x:1px}")).toBe("css");
    expect(detectFormat("a.scss", "$x: 1px;")).toBe("scss");
    expect(detectFormat("a.less", "@x: 1px;")).toBe("less");
  });

  it("sniffs an unknown extension by content", () => {
    expect(detectFormat("vars.txt", "$brand: #fff;")).toBe("scss");
  });

  it("honors an explicit format override", () => {
    const tokens = parseSource("weird.txt", "$space-md: 8px;", "scss", ctx);
    expect(by(tokens, "$space-md").type).toBe("dimension");
  });

  it("throws an actionable error when the format can't be detected", () => {
    expect(() => parseSource("mystery.bin", "%%% not tokens %%%", "auto", ctx)).toThrow(
      /could not detect/i,
    );
  });

  it("throws an actionable error on malformed JSON for an explicit JSON format", () => {
    expect(() => parseSource("broken.json", "{ not json", "dtcg", ctx)).toThrow(/could not parse/i);
  });
});
