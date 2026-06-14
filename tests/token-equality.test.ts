import { describe, it, expect } from "vitest";
import {
  buildTokenSet,
  canonicalize,
  canonicalizeAuto,
  canonicalKey,
  classOf,
  valuesEqual,
} from "../scripts/lib/token-equality";
import type { Token, TokenType } from "../scripts/lib/tokens-model";

const token = (over: Partial<Token> & Pick<Token, "name" | "value" | "type">): Token => ({
  raw: over.value,
  path: [],
  source: "test",
  ...over,
});

describe("classOf — token type → equality class", () => {
  const cases: [TokenType, string][] = [
    ["color", "color"],
    ["dimension", "dimension"],
    ["fontSize", "dimension"],
    ["radius", "dimension"],
    ["letterSpacing", "dimension"],
    ["lineHeight", "dimension"],
    ["duration", "duration"],
    ["fontWeight", "fontWeight"],
    ["opacity", "number"],
    ["zIndex", "number"],
    ["number", "number"],
    ["fontFamily", "string"],
    ["shadow", "string"],
    ["custom:elevation", "string"],
  ];
  it.each(cases)("classOf(%s) === %s", (type, expected) => {
    expect(classOf(type)).toBe(expected);
  });
});

describe("color equality (via culori)", () => {
  const equal: [string, string][] = [
    ["#fff", "#ffffff"],
    ["#fff", "white"],
    ["#fff", "rgb(255, 255, 255)"],
    ["#FF0000", "red"],
    ["rgb(255, 0, 0)", "#f00"],
    ["hsl(0, 100%, 50%)", "#ff0000"],
    ["rgba(255, 255, 255, 0.5)", "#ffffff80"],
  ];
  it.each(equal)("%s ≡ %s", (a, b) => {
    expect(valuesEqual(a, b, "color")).toBe(true);
  });

  const notEqual: [string, string][] = [
    ["#fff", "#000"],
    ["#ffffff", "rgba(255, 255, 255, 0.5)"], // alpha is significant
    ["#ff0000", "#ff0001"],
    ["red", "blue"],
  ];
  it.each(notEqual)("%s ≠ %s", (a, b) => {
    expect(valuesEqual(a, b, "color")).toBe(false);
  });

  it("canonicalizes to lowercase 6-digit sRGB hex at high confidence", () => {
    expect(canonicalize("WHITE", "color")).toEqual({
      class: "color",
      value: "#ffffff",
      confidence: "high",
    });
  });

  it("flags a wide-gamut/perceptual color as medium confidence", () => {
    const c = canonicalize("oklch(0.7 0.1 200)", "color");
    expect(c?.class).toBe("color");
    expect(c?.confidence).toBe("medium");
  });

  it("does NOT treat a bare number as a color (culori parses hex-without-#)", () => {
    // "700" / "1000" must canonicalize as numbers, never #770000 / #110000.
    expect(canonicalizeAuto("700")).toEqual({ class: "number", value: "700", confidence: "high" });
    expect(canonicalizeAuto("1000")?.class).toBe("number");
    expect(valuesEqual("700", "#770000", "color")).toBe(false);
  });
});

describe("dimension equality (rem→px, zero, relative units)", () => {
  const equal: [string, string][] = [
    ["8px", "8px"],
    ["8px", "0.5rem"],
    ["16px", "1rem"],
    ["12pt", "16px"],
    ["0", "0px"],
    ["0rem", "0"],
    ["0%", "0px"],
    ["50%", "50%"],
  ];
  it.each(equal)("%s ≡ %s (dimension)", (a, b) => {
    expect(valuesEqual(a, b, "dimension")).toBe(true);
  });

  const notEqual: [string, string][] = [
    ["8px", "9px"],
    ["8px", "8rem"],
    ["50%", "8px"],
    ["8px", "8vh"],
  ];
  it.each(notEqual)("%s ≠ %s (dimension)", (a, b) => {
    expect(valuesEqual(a, b, "dimension")).toBe(false);
  });

  it("honors a custom root font size for rem→px", () => {
    expect(valuesEqual("10px", "1rem", "dimension", { rootFontSize: 10 })).toBe(true);
    expect(valuesEqual("16px", "1rem", "dimension", { rootFontSize: 10 })).toBe(false);
  });

  it("marks em as medium confidence (element-relative)", () => {
    expect(canonicalize("1em", "dimension")).toEqual({
      class: "dimension",
      value: "16",
      confidence: "medium",
    });
  });

  it("marks context-relative units as low confidence and keeps the unit", () => {
    expect(canonicalize("50%", "dimension")).toEqual({
      class: "dimension",
      value: "50%",
      confidence: "low",
    });
  });

  it("treats a unitless dimension type (line-height) as a number", () => {
    expect(valuesEqual("1.5", "1.50", "lineHeight")).toBe(true);
    expect(valuesEqual("1.5", "24px", "lineHeight")).toBe(false);
    expect(canonicalize("1.5", "lineHeight")?.class).toBe("number");
  });
});

describe("duration equality (ms/s)", () => {
  it.each([
    ["200ms", "0.2s"],
    ["1s", "1000ms"],
    ["0s", "0ms"],
  ] as [string, string][])("%s ≡ %s", (a, b) => {
    expect(valuesEqual(a, b, "duration")).toBe(true);
  });

  it("200ms ≠ 300ms", () => {
    expect(valuesEqual("200ms", "300ms", "duration")).toBe(false);
  });
});

describe("fontWeight equality (keyword ↔ number)", () => {
  it.each([
    ["bold", "700"],
    ["normal", "400"],
    ["Bold", "700"],
    ["medium", "500"],
    ["700", "700"],
  ] as [string, string][])("%s ≡ %s", (a, b) => {
    expect(valuesEqual(a, b, "fontWeight")).toBe(true);
  });

  it("bold ≠ 400", () => {
    expect(valuesEqual("bold", "400", "fontWeight")).toBe(false);
  });
});

describe("number equality (opacity, zIndex, plain)", () => {
  it.each([
    [".5", "0.5", "opacity"],
    ["0.50", "0.5", "number"],
    ["10", "10", "zIndex"],
    ["1", "1.0", "number"],
  ] as [string, string, TokenType][])("%s ≡ %s (%s)", (a, b, type) => {
    expect(valuesEqual(a, b, type)).toBe(true);
  });
});

describe("string equality (composite — whitespace-normalized)", () => {
  it("collapses whitespace for font families", () => {
    expect(
      valuesEqual("'Helvetica Neue', sans-serif", "'Helvetica Neue',  sans-serif", "fontFamily"),
    ).toBe(true);
  });
  it("differs on different families", () => {
    expect(valuesEqual("Arial, sans-serif", "Helvetica, sans-serif", "fontFamily")).toBe(false);
  });
});

describe("cross-class isolation (no false collisions)", () => {
  it("a z-index 700 and a fontWeight 700 never share a canonical key", () => {
    expect(canonicalKey("700", "zIndex")).toBe("number:700");
    expect(canonicalKey("700", "fontWeight")).toBe("fontWeight:700");
    expect(canonicalKey("700", "zIndex")).not.toBe(canonicalKey("700", "fontWeight"));
  });
});

describe("canonicalizeAuto — shape inference with no type", () => {
  it.each([
    ["#fff", "color:#ffffff"],
    ["8px", "dimension:8"],
    ["200ms", "duration:200"],
    ["42", "number:42"],
    ["solid", "string:solid"],
  ] as [string, string][])("%s → %s", (value, key) => {
    const c = canonicalizeAuto(value);
    expect(c).not.toBeNull();
    expect(`${c!.class}:${c!.value}`).toBe(key);
  });
});

describe("edge cases — empty values and type fallbacks", () => {
  it("returns null for an empty / whitespace-only value", () => {
    expect(canonicalize("", "color")).toBeNull();
    expect(canonicalize("   ", "dimension")).toBeNull();
    expect(canonicalizeAuto("")).toBeNull();
    expect(canonicalKey("", "color")).toBeNull();
  });

  it("an empty value never equals anything", () => {
    expect(valuesEqual("", "#fff", "color")).toBe(false);
  });

  it("falls back to string when a value doesn't fit its declared class", () => {
    expect(canonicalize("inherit", "color")).toEqual({
      class: "string",
      value: "inherit",
      confidence: "high",
    });
    expect(canonicalize("ease", "duration")?.class).toBe("string");
    expect(canonicalize("auto", "number")?.class).toBe("string");
    expect(canonicalize("bolder", "fontWeight")?.class).toBe("string"); // relative keyword, not mapped
  });

  it("skips a token whose value doesn't canonicalize when indexing", () => {
    const set = buildTokenSet([token({ name: "--x", value: "   ", type: "color" })]);
    expect(set.byCanonicalValue.size).toBe(0);
    expect(set.byName.size).toBe(1);
  });
});

describe("buildTokenSet — name + canonical-value index", () => {
  const tokens: Token[] = [
    token({ name: "--space-md", value: "8px", type: "dimension" }),
    token({ name: "--gap-sm", value: "0.5rem", type: "dimension" }), // same canonical as --space-md
    token({ name: "--color-bg", value: "#ffffff", type: "color" }),
    token({ name: "--fw-bold", value: "bold", type: "fontWeight" }),
  ];
  const set = buildTokenSet(tokens);

  it("indexes by name", () => {
    expect(set.byName.get("--space-md")?.value).toBe("8px");
    expect(set.byName.size).toBe(4);
  });

  it("groups value-equal tokens into one candidate bucket", () => {
    const bucket = set.byCanonicalValue.get("dimension:8");
    expect(bucket?.map((t) => t.name).sort()).toEqual(["--gap-sm", "--space-md"]);
  });

  it("keeps distinct values in distinct buckets", () => {
    expect(set.byCanonicalValue.get("color:#ffffff")?.map((t) => t.name)).toEqual(["--color-bg"]);
    expect(set.byCanonicalValue.get("fontWeight:700")?.map((t) => t.name)).toEqual(["--fw-bold"]);
  });
});
