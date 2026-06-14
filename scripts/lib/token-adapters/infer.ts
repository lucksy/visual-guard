/**
 * Token type inference (T-16c). Formats that don't declare a `$type` (CSS/SCSS/Less, plain JSON)
 * need their type inferred so the equality core picks the right canonicalization. We combine the
 * value's equality class (from `canonicalizeAuto`) with name hints; Tailwind v4 additionally
 * carries the type in its `--<namespace>-*` prefix, which is more reliable than inference.
 */
import { canonicalizeAuto } from "../token-equality";
import type { TokenType } from "../tokens-model";

/** Strip a `--` / `$` / `@` prefix and lowercase, for hint matching. */
function bareName(name: string): string {
  return name.replace(/^(--|\$|@)/, "").toLowerCase();
}

/** Infer a token's type from its name and value. */
export function inferType(name: string, value: string): TokenType {
  const bare = bareName(name);
  const cls = canonicalizeAuto(value)?.class;

  if (cls === "color") {
    return "color";
  }
  if (cls === "duration") {
    return "duration";
  }
  if (cls === "dimension") {
    if (/radius|rounded/.test(bare)) {
      return "radius";
    }
    if (/font-?size|fontsize/.test(bare)) {
      return "fontSize";
    }
    if (/letter-?spacing|tracking/.test(bare)) {
      return "letterSpacing";
    }
    if (/line-?height|leading/.test(bare)) {
      return "lineHeight";
    }
    return "dimension";
  }
  if (cls === "number") {
    if (/z-?index/.test(bare)) {
      return "zIndex";
    }
    if (/opacity|alpha/.test(bare)) {
      return "opacity";
    }
    if (/font-?weight|fontweight|weight/.test(bare)) {
      return "fontWeight";
    }
    if (/line-?height|leading/.test(bare)) {
      return "lineHeight";
    }
    return "number";
  }
  // string class — refine by name (weight before family: "font-weight" contains "font").
  if (/font-?weight|fontweight|weight/.test(bare)) {
    return "fontWeight";
  }
  if (/font-?famil|typeface|font-?stack/.test(bare)) {
    return "fontFamily";
  }
  if (/shadow|elevation/.test(bare)) {
    return "shadow";
  }
  if (/gradient/.test(bare)) {
    return "gradient";
  }
  if (/\bborder\b/.test(bare)) {
    return "border";
  }
  if (/ease|bezier|timing/.test(bare)) {
    return "cubicBezier";
  }
  return "string";
}

/** Tailwind v4 theme namespaces encode the type in the variable prefix (`--color-*`, `--text-*`…). */
export function tailwindTypeFromName(name: string): TokenType | null {
  const bare = bareName(name);
  if (bare.startsWith("color-")) {
    return "color";
  }
  if (bare.startsWith("spacing-") || bare.startsWith("space-")) {
    return "dimension";
  }
  if (bare.startsWith("text-")) {
    return "fontSize";
  }
  if (bare.startsWith("font-weight-")) {
    return "fontWeight";
  }
  if (bare.startsWith("font-")) {
    return "fontFamily";
  }
  if (bare.startsWith("leading-")) {
    return "lineHeight";
  }
  if (bare.startsWith("tracking-")) {
    return "letterSpacing";
  }
  if (bare.startsWith("radius-")) {
    return "radius";
  }
  if (
    bare.startsWith("shadow-") ||
    bare.startsWith("inset-shadow-") ||
    bare.startsWith("drop-shadow-")
  ) {
    return "shadow";
  }
  if (bare.startsWith("blur-")) {
    return "dimension";
  }
  if (bare.startsWith("ease-")) {
    return "cubicBezier";
  }
  return null;
}
