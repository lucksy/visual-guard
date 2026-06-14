/**
 * Type-aware value equality (T-16b) — the de-risker. A hardcoded literal "inlines" a token only
 * when their values are *truly* equal, which is type-dependent: `#fff` ≡ `#ffffff` ≡ `white`,
 * `8px` ≡ `0.5rem`, `200ms` ≡ `0.2s`, `bold` ≡ `700`. Each token type maps to an equality class;
 * `canonicalize` reduces a value to a `${class}:${value}` form so two values match iff they share
 * both. Context-relative units (`em`, `%`, `vh`…) can't be resolved statically, so they match only
 * conservatively and at reduced confidence — the auditor explains the uncertainty.
 */
import { formatHex, formatHex8, parse } from "culori";
import type { Token, TokenSet, TokenType } from "./tokens-model";

export type EqualityClass = "color" | "dimension" | "duration" | "fontWeight" | "number" | "string";
export type Confidence = "high" | "medium" | "low";

export interface Canonical {
  class: EqualityClass;
  /** Normalized value within the class (e.g. px magnitude for dimensions, sRGB hex for colors). */
  value: string;
  confidence: Confidence;
}

export interface CanonicalizeOptions {
  /** Root font size (px) for rem→px conversion. Defaults to 16. */
  rootFontSize?: number;
}

const DEFAULT_ROOT_FONT_SIZE = 16;

/** Absolute CSS length units and their px factor. Relative units are handled separately. */
const LENGTH_PX_FACTOR: Record<string, number> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 2.54 / 40,
};

/** Context-relative units: not statically convertible to px, so compared as-written (low confidence). */
const RELATIVE_UNITS = new Set([
  "%",
  "vh",
  "vw",
  "vmin",
  "vmax",
  "vi",
  "vb",
  "ch",
  "ex",
  "cap",
  "ic",
  "lh",
  "rlh",
  "fr",
  "svh",
  "svw",
  "lvh",
  "lvw",
  "dvh",
  "dvw",
]);

const FONT_WEIGHT_KEYWORDS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  "extra-light": 200,
  ultralight: 200,
  "ultra-light": 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  "semi-bold": 600,
  demibold: 600,
  "demi-bold": 600,
  bold: 700,
  extrabold: 800,
  "extra-bold": 800,
  ultrabold: 800,
  "ultra-bold": 800,
  black: 900,
  heavy: 900,
};

const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;
const NUMBER_UNIT_RE = /^(-?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)$/i;
const DURATION_RE = /^(-?(?:\d+\.?\d*|\.\d+))\s*(ms|s)$/i;

/** Map a semantic token type to its value-equality class. */
export function classOf(type: TokenType): EqualityClass {
  switch (type) {
    case "color":
      return "color";
    case "dimension":
    case "fontSize":
    case "radius":
    case "letterSpacing":
    case "lineHeight":
      return "dimension";
    case "duration":
      return "duration";
    case "fontWeight":
      return "fontWeight";
    case "opacity":
    case "zIndex":
    case "number":
      return "number";
    default:
      // fontFamily, cubicBezier, shadow, border, gradient, string, custom:* → exact-string match.
      return "string";
  }
}

/** Round to 4 dp and stringify, collapsing -0 → 0 and stripping trailing zeros. */
function fmtNum(n: number): string {
  const rounded = Math.round(n * 1e4) / 1e4;
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * culori's `parse` accepts bare hex digits with no `#` (e.g. "700" → #770000), which would make
 * plain numbers match color tokens. Require real CSS color syntax — a `#`, a color function, or a
 * letter-leading name (named colors / hex-without-# that can't be a number) — before parsing.
 */
function looksLikeColor(v: string): boolean {
  return (
    v.startsWith("#") ||
    /^[a-z][a-z0-9]*$/i.test(v) ||
    /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i.test(v)
  );
}

function canonicalizeColor(v: string): Canonical | null {
  if (!looksLikeColor(v)) {
    return null;
  }
  const parsed = parse(v) as { mode: string; alpha?: number } | undefined;
  if (!parsed) {
    return null;
  }
  const alpha = parsed.alpha ?? 1;
  const hex = alpha === 1 ? formatHex(parsed) : formatHex8(parsed);
  if (!hex) {
    return null;
  }
  // sRGB-native inputs are exact; perceptual / wide-gamut inputs are gamut-mapped → less certain.
  const exactModes = new Set(["rgb", "hsl", "hwb"]);
  const confidence: Confidence = exactModes.has(parsed.mode) ? "high" : "medium";
  return { class: "color", value: hex.toLowerCase(), confidence };
}

function canonicalizeDimension(v: string, root: number): Canonical | null {
  const match = NUMBER_UNIT_RE.exec(v);
  if (!match) {
    return null;
  }
  const num = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  // Zero is unit-agnostic: 0 ≡ 0px ≡ 0rem ≡ 0%.
  if (
    num === 0 &&
    (unit === "" ||
      unit === "rem" ||
      unit === "em" ||
      unit in LENGTH_PX_FACTOR ||
      RELATIVE_UNITS.has(unit))
  ) {
    return { class: "dimension", value: "0", confidence: "high" };
  }
  if (unit === "") {
    return null; // unitless non-zero is not a dimension; caller may treat it as a number
  }
  if (unit === "rem") {
    return { class: "dimension", value: fmtNum(num * root), confidence: "high" };
  }
  if (unit === "em") {
    // Element-relative: we assume root, so a match is plausible but not certain.
    return { class: "dimension", value: fmtNum(num * root), confidence: "medium" };
  }
  const factor = LENGTH_PX_FACTOR[unit];
  if (factor !== undefined) {
    return { class: "dimension", value: fmtNum(num * factor), confidence: "high" };
  }
  if (RELATIVE_UNITS.has(unit)) {
    // Keep the unit so 8% only matches 8%, never 8px; can't resolve to px.
    return { class: "dimension", value: `${fmtNum(num)}${unit}`, confidence: "low" };
  }
  return null;
}

function canonicalizeDuration(v: string): Canonical | null {
  const match = DURATION_RE.exec(v);
  if (!match) {
    return null;
  }
  const num = parseFloat(match[1]!);
  const ms = match[2]!.toLowerCase() === "s" ? num * 1000 : num;
  return { class: "duration", value: fmtNum(ms), confidence: "high" };
}

function canonicalizeNumber(v: string): Canonical | null {
  if (!NUMBER_RE.test(v)) {
    return null;
  }
  return { class: "number", value: fmtNum(parseFloat(v)), confidence: "high" };
}

function canonicalizeFontWeight(v: string): Canonical | null {
  if (NUMBER_RE.test(v)) {
    return { class: "fontWeight", value: fmtNum(parseFloat(v)), confidence: "high" };
  }
  const mapped = FONT_WEIGHT_KEYWORDS[v.toLowerCase()];
  if (mapped !== undefined) {
    return { class: "fontWeight", value: String(mapped), confidence: "high" };
  }
  return null;
}

function canonicalizeString(v: string): Canonical {
  return { class: "string", value: v.replace(/\s+/g, " ").trim(), confidence: "high" };
}

/**
 * Reduce a value to its canonical `${class}:${value}` form. When `type` is given its equality class
 * is used (the common path: a token's declared type, or a literal's CSS-property context). Without a
 * type, the class is inferred from the value's shape (`canonicalizeAuto`). Returns null only for an
 * empty value.
 */
export function canonicalize(
  value: string,
  type?: TokenType,
  options?: CanonicalizeOptions,
): Canonical | null {
  const v = value.trim();
  if (v === "") {
    return null;
  }
  const root = options?.rootFontSize ?? DEFAULT_ROOT_FONT_SIZE;

  if (type === undefined) {
    return canonicalizeAuto(v, options);
  }

  switch (classOf(type)) {
    case "color":
      return canonicalizeColor(v) ?? canonicalizeString(v);
    case "fontWeight":
      return canonicalizeFontWeight(v) ?? canonicalizeString(v);
    case "duration":
      return canonicalizeDuration(v) ?? canonicalizeString(v);
    case "number":
      return canonicalizeNumber(v) ?? canonicalizeString(v);
    case "dimension": {
      const dimension = canonicalizeDimension(v, root);
      if (dimension) {
        return dimension;
      }
      // A unitless value under a dimension type (e.g. a unitless line-height) is a number.
      return canonicalizeNumber(v) ?? canonicalizeString(v);
    }
    default:
      return canonicalizeString(v);
  }
}

/** Canonicalize by value shape when no type context is available. */
export function canonicalizeAuto(value: string, options?: CanonicalizeOptions): Canonical | null {
  const v = value.trim();
  if (v === "") {
    return null;
  }
  const root = options?.rootFontSize ?? DEFAULT_ROOT_FONT_SIZE;
  return (
    canonicalizeColor(v) ??
    canonicalizeDimension(v, root) ??
    canonicalizeDuration(v) ??
    canonicalizeNumber(v) ??
    canonicalizeString(v)
  );
}

/** True iff `a` and `b` are the same value under the given type (or inferred shape). */
export function valuesEqual(
  a: string,
  b: string,
  type?: TokenType,
  options?: CanonicalizeOptions,
): boolean {
  const ca = canonicalize(a, type, options);
  const cb = canonicalize(b, type, options);
  return ca !== null && cb !== null && ca.class === cb.class && ca.value === cb.value;
}

/** The reverse-index key a value resolves to, or null if it doesn't canonicalize. */
export function canonicalKey(
  value: string,
  type?: TokenType,
  options?: CanonicalizeOptions,
): string | null {
  const c = canonicalize(value, type, options);
  return c === null ? null : `${c.class}:${c.value}`;
}

/**
 * Index a list of tokens by name and by canonical value. Tokens that share a canonical value land
 * in the same bucket (the drift scanner ranks those candidates by CSS-property context).
 */
export function buildTokenSet(tokens: Token[], options?: CanonicalizeOptions): TokenSet {
  const byName = new Map<string, Token>();
  const byCanonicalValue = new Map<string, Token[]>();
  for (const token of tokens) {
    byName.set(token.name, token);
    const key = canonicalKey(token.value, token.type, options);
    if (key === null) {
      continue;
    }
    const bucket = byCanonicalValue.get(key);
    if (bucket) {
      bucket.push(token);
    } else {
      byCanonicalValue.set(key, [token]);
    }
  }
  return { tokens, byName, byCanonicalValue };
}
