/**
 * DTCG adapter (T-16c) — the W3C Design Tokens Format Module. A token is any object with `$value`;
 * `$type` is declared on the token or inherited from an enclosing group; aliases are `{group.token}`.
 * Composite `$value`s (shadow/typography/…) are stringified for conservative string matching.
 */
import type { Token, TokenType } from "../tokens-model";
import { isPlainObject, resolveTokens, type RawToken } from "./json-common";
import { detailOf, type ParseContext } from "./types";

const DTCG_TYPE: Record<string, TokenType> = {
  color: "color",
  dimension: "dimension",
  fontFamily: "fontFamily",
  fontWeight: "fontWeight",
  fontSize: "fontSize",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  duration: "duration",
  cubicBezier: "cubicBezier",
  number: "number",
  shadow: "shadow",
  border: "border",
  gradient: "gradient",
  strokeStyle: "string",
  transition: "string",
  typography: "string",
};

function mapType(raw: unknown): TokenType | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  return DTCG_TYPE[raw] ?? (`custom:${raw}` as TokenType);
}

export function parseDtcg(contents: string, ctx: ParseContext): Token[] {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (err) {
    throw new Error(`could not parse DTCG token source "${ctx.source}": ${detailOf(err)}`);
  }

  const raws: RawToken[] = [];
  const walk = (node: unknown, path: string[], inherited: TokenType | undefined): void => {
    if (!isPlainObject(node)) {
      return;
    }
    if ("$value" in node) {
      raws.push({
        name: path.join("."),
        rawValue: node.$value,
        type: mapType(node.$type) ?? inherited,
      });
      return;
    }
    const groupType = mapType(node.$type) ?? inherited;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$")) {
        continue;
      }
      walk(child, [...path, key], groupType);
    }
  };
  walk(json, [], undefined);

  return resolveTokens(raws, ctx);
}
