import { describe, it, expect } from "vitest";
import { inferType, tailwindTypeFromName } from "../scripts/lib/token-adapters/infer";
import type { TokenType } from "../scripts/lib/tokens-model";

describe("inferType — value class + name hints", () => {
  const cases: [string, string, TokenType][] = [
    // color (value-class wins)
    ["--brand", "#ff0000", "color"],
    ["--anything", "red", "color"],
    // duration
    ["--motion", "200ms", "duration"],
    // dimension family
    ["--space-md", "8px", "dimension"],
    ["--radius-lg", "8px", "radius"],
    ["--font-size-base", "16px", "fontSize"],
    ["--tracking-wide", "0.1px", "letterSpacing"],
    ["--leading-tight", "20px", "lineHeight"],
    // number family
    ["--z-index-modal", "1000", "zIndex"],
    ["--opacity-disabled", "0.5", "opacity"],
    ["--font-weight-bold", "700", "fontWeight"],
    ["--line-height-body", "1.5", "lineHeight"],
    ["--scale", "2", "number"],
    // string family (refined by name)
    ["--weight-strong", "bold", "fontWeight"],
    ["--font-family-base", "Inter, sans-serif", "fontFamily"],
    ["--shadow-card", "0 1px 2px #0003", "shadow"],
    ["--gradient-hero", "linear-gradient(#000, #fff)", "gradient"],
    ["--border-default", "1px solid #ccc", "border"],
    ["--ease-out", "cubic-bezier(0, 0, 0.2, 1)", "cubicBezier"],
    ["--label", "uppercase", "string"],
  ];
  it.each(cases)("inferType(%s, %s) === %s", (name, value, expected) => {
    expect(inferType(name, value)).toBe(expected);
  });
});

describe("tailwindTypeFromName — namespace prefix", () => {
  const cases: [string, TokenType | null][] = [
    ["--color-primary", "color"],
    ["--spacing-4", "dimension"],
    ["--space-2", "dimension"],
    ["--text-lg", "fontSize"],
    ["--font-weight-bold", "fontWeight"],
    ["--font-sans", "fontFamily"],
    ["--leading-snug", "lineHeight"],
    ["--tracking-tight", "letterSpacing"],
    ["--radius-md", "radius"],
    ["--shadow-lg", "shadow"],
    ["--inset-shadow-sm", "shadow"],
    ["--drop-shadow-xl", "shadow"],
    ["--blur-sm", "dimension"],
    ["--ease-in-out", "cubicBezier"],
    ["--breakpoint-md", null],
  ];
  it.each(cases)("tailwindTypeFromName(%s) === %s", (name, expected) => {
    expect(tailwindTypeFromName(name)).toBe(expected);
  });
});
