/**
 * Adapter registry + format detection (T-16c). `detectFormat` sniffs a file by extension and
 * content; `parseSource` dispatches to the right static adapter (an explicit format overrides
 * detection). Auto-detection between DTCG and Style Dictionary v4 (both `$value`) favors DTCG —
 * set `format` explicitly when that's wrong.
 */
import { extname } from "node:path";
import type { Token } from "../tokens-model";
import { parseCssFamily } from "./css";
import { parseDtcg } from "./dtcg";
import { isPlainObject } from "./json-common";
import { parseStyleDictionary } from "./style-dictionary";
import { parseTokensStudio } from "./tokens-studio";
import type { ParseContext, StaticFormat } from "./types";

export { parseCssFamily } from "./css";
export { parseDtcg } from "./dtcg";
export { parseStyleDictionary } from "./style-dictionary";
export { parseTokensStudio } from "./tokens-studio";
export {
  evalThemeFile,
  flattenThemeTokens,
  parseJsThemeFile,
  parseTailwindConfigFile,
} from "./js-eval";
export type { JsEvalMode, JsEvalOptions } from "./js-eval";
export type { ParseContext, StaticFormat, TokenAdapter } from "./types";

const STUDIO_ONLY_TYPES = new Set([
  "spacing",
  "sizing",
  "borderRadius",
  "fontFamilies",
  "fontWeights",
  "fontSizes",
  "lineHeights",
  "boxShadow",
  "paragraphSpacing",
]);

const THEME_AT_RULE = /(^|[^\w])@theme\b/;

/** Distinguish the three JSON token formats by their key conventions. */
function sniffJson(contents: string): StaticFormat | null {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!isPlainObject(json)) {
    return null;
  }
  if ("$themes" in json || "$metadata" in json) {
    return "tokens-studio";
  }
  let hasDollarValue = false;
  let hasValue = false;
  let hasStudioType = false;
  const visit = (node: unknown): void => {
    if (!isPlainObject(node)) {
      return;
    }
    if ("$value" in node) {
      hasDollarValue = true;
    }
    if ("value" in node) {
      hasValue = true;
      if ("type" in node && typeof node.type === "string" && STUDIO_ONLY_TYPES.has(node.type)) {
        hasStudioType = true;
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$")) {
        continue;
      }
      visit(child);
    }
  };
  visit(json);
  if (hasStudioType) {
    return "tokens-studio";
  }
  if (hasDollarValue) {
    return "dtcg";
  }
  if (hasValue) {
    return "style-dictionary";
  }
  return null;
}

/** Best-effort format detection by extension, then content. Null = couldn't tell. */
export function detectFormat(path: string, contents: string): StaticFormat | null {
  const ext = extname(path).toLowerCase();
  if (ext === ".css") {
    return THEME_AT_RULE.test(contents) ? "tailwind" : "css";
  }
  if (ext === ".scss" || ext === ".sass") {
    return "scss";
  }
  if (ext === ".less") {
    return "less";
  }
  if (ext === ".json" || ext === ".tokens" || path.toLowerCase().endsWith(".tokens.json")) {
    return sniffJson(contents);
  }
  // Unknown extension — fall back to content sniffing.
  if (THEME_AT_RULE.test(contents)) {
    return "tailwind";
  }
  const json = sniffJson(contents);
  if (json) {
    return json;
  }
  if (/--[\w-]+\s*:/.test(contents)) {
    return "css";
  }
  if (/\$[\w-]+\s*:/.test(contents)) {
    return "scss";
  }
  if (/@[\w-]+\s*:/.test(contents)) {
    return "less";
  }
  return null;
}

/** Parse one source's contents into normalized tokens, detecting the format if `auto`. */
export function parseSource(
  path: string,
  contents: string,
  format: "auto" | StaticFormat,
  ctx: ParseContext,
): Token[] {
  const resolved = format === "auto" ? detectFormat(path, contents) : format;
  if (resolved === null) {
    throw new Error(
      `Visual Guard tokens: could not detect the format of "${path}" — set tokens.sources[].format explicitly.`,
    );
  }
  switch (resolved) {
    case "css":
    case "tailwind":
    case "scss":
    case "less":
      return parseCssFamily(contents, ctx, resolved);
    case "dtcg":
      return parseDtcg(contents, ctx);
    case "style-dictionary":
      return parseStyleDictionary(contents, ctx);
    case "tokens-studio":
      return parseTokensStudio(contents, ctx);
  }
}
