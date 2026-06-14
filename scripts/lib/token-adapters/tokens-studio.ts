/**
 * Tokens Studio for Figma adapter (T-16c). Tokens are `{ "value": …, "type": <studio-type> }`
 * nested under token sets; `$themes` / `$metadata` are skipped. The studio type vocabulary maps to
 * our token types; `{set.token}` references resolve via the shared resolver (math expressions stay
 * literal).
 */
import type { Token, TokenType } from "../tokens-model";
import { isPlainObject, resolveTokens, type RawToken } from "./json-common";
import { detailOf, type ParseContext } from "./types";

const STUDIO_TYPE: Record<string, TokenType> = {
  color: "color",
  spacing: "dimension",
  sizing: "dimension",
  dimension: "dimension",
  borderWidth: "dimension",
  paragraphSpacing: "dimension",
  borderRadius: "radius",
  fontFamilies: "fontFamily",
  fontWeights: "fontWeight",
  fontSizes: "fontSize",
  lineHeights: "lineHeight",
  letterSpacing: "letterSpacing",
  opacity: "opacity",
  boxShadow: "shadow",
  border: "border",
  typography: "string",
  textCase: "string",
  textDecoration: "string",
};

function mapType(raw: unknown): TokenType {
  if (typeof raw !== "string") {
    return "string";
  }
  return STUDIO_TYPE[raw] ?? (`custom:${raw}` as TokenType);
}

export function parseTokensStudio(contents: string, ctx: ParseContext): Token[] {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (err) {
    throw new Error(`could not parse Tokens Studio source "${ctx.source}": ${detailOf(err)}`);
  }

  const raws: RawToken[] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (!isPlainObject(node)) {
      return;
    }
    if ("value" in node && "type" in node) {
      raws.push({ name: path.join("."), rawValue: node.value, type: mapType(node.type) });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "$themes" || key === "$metadata") {
        continue;
      }
      walk(child, [...path, key]);
    }
  };
  walk(json, []);

  return resolveTokens(raws, ctx);
}
