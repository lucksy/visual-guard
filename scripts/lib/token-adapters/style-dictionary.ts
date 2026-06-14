/**
 * Style Dictionary adapter (T-16c). v3 tokens are `{ "value": …, "type"? }` with `{a.b.value}`
 * references; v4 adopted DTCG's `$value`/`$type` with `{a.b}` references. This handles both. The
 * leading CTI segment (color/size/spacing/…) is a type hint when no explicit type is given.
 */
import type { Token, TokenType } from "../tokens-model";
import { isPlainObject, resolveTokens, type RawToken } from "./json-common";
import { detailOf, type ParseContext } from "./types";

const SD_TYPE: Record<string, TokenType> = {
  color: "color",
  dimension: "dimension",
  size: "dimension",
  spacing: "dimension",
  fontFamily: "fontFamily",
  fontWeight: "fontWeight",
  fontSize: "fontSize",
  fontSizes: "fontSize",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  duration: "duration",
  time: "duration",
  cubicBezier: "cubicBezier",
  number: "number",
  shadow: "shadow",
  border: "border",
  borderRadius: "radius",
  gradient: "gradient",
  opacity: "opacity",
  zIndex: "zIndex",
};

function mapType(raw: unknown): TokenType | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  return SD_TYPE[raw] ?? (`custom:${raw}` as TokenType);
}

/** A CTI category (the first path segment) → type hint, for v3 tokens with no explicit type. */
function typeFromCategory(path: string[]): TokenType | undefined {
  const category = path[0]?.toLowerCase();
  if (category === undefined) {
    return undefined;
  }
  if (/color|colour/.test(category)) {
    return "color";
  }
  if (/size|spacing|space|dimension/.test(category)) {
    return "dimension";
  }
  if (/radius/.test(category)) {
    return "radius";
  }
  return undefined;
}

export function parseStyleDictionary(contents: string, ctx: ParseContext): Token[] {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (err) {
    throw new Error(
      `could not parse Style Dictionary token source "${ctx.source}": ${detailOf(err)}`,
    );
  }

  const raws: RawToken[] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (!isPlainObject(node)) {
      return;
    }
    const hasValue = "$value" in node || "value" in node;
    if (hasValue) {
      const declared = mapType("$type" in node ? node.$type : node.type);
      raws.push({
        name: path.join("."),
        rawValue: "$value" in node ? node.$value : node.value,
        type: declared ?? typeFromCategory(path),
      });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$") || key === "comment" || key === "attributes") {
        continue;
      }
      walk(child, [...path, key]);
    }
  };
  walk(json, []);

  return resolveTokens(raws, ctx);
}
