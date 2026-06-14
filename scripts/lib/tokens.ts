/**
 * Token drift — public API (T-16d/e). `loadTokens` reads the configured sources into a `TokenSet`
 * via the format adapters; `auditTokens` scans changed UI files for hardcoded literals that inline
 * a token. Static sources use the injected `io`; JS-eval sources (`tailwind-config` / `js-theme`)
 * are evaluated from disk in a sandboxed child process (opt-in via `tokens.allowJsEval`).
 */
import type { Config } from "./config";
import {
  parseJsThemeFile,
  parseSource,
  parseTailwindConfigFile,
  type StaticFormat,
} from "./token-adapters";
import { buildTokenSet } from "./token-equality";
import type { Token, TokenSet } from "./tokens-model";
import { detectDrift, scanContent, type DriftFinding } from "./token-scan";

export type { DriftFinding } from "./token-scan";
export { detectDrift, scanContent } from "./token-scan";

export interface TokenIo {
  /** Read a file's text; should throw if missing (a missing static source is then skipped). */
  readFile: (path: string) => string;
}

/** Load + merge every configured token source into one indexed `TokenSet`. */
export function loadTokens(config: Config, io: TokenIo): TokenSet {
  const all: Token[] = [];
  const allowJsEval = config.tokens.allowJsEval === true;
  for (const src of config.tokens.sources) {
    const ctx =
      src.mode !== undefined ? { source: src.source, mode: src.mode } : { source: src.source };

    if (src.format === "tailwind-config" || src.format === "js-theme") {
      // JS-eval: evaluated from disk in a child process (opt-in); failures surface, not silently skipped.
      const tokens =
        src.format === "tailwind-config"
          ? parseTailwindConfigFile(src.source, ctx, { allowJsEval })
          : parseJsThemeFile(src.source, ctx, { allowJsEval });
      all.push(...tokens);
      continue;
    }

    let contents: string;
    try {
      contents = io.readFile(src.source);
    } catch {
      continue; // a missing static token source is non-fatal — just contributes nothing
    }
    all.push(...parseSource(src.source, contents, src.format as "auto" | StaticFormat, ctx));
  }
  const rootFontSize = config.tokens.sources.find(
    (s) => s.rootFontSize !== undefined,
  )?.rootFontSize;
  return buildTokenSet(all, rootFontSize !== undefined ? { rootFontSize } : undefined);
}

/**
 * Audit changed UI files for token drift: load the token set, scan each file for hardcoded
 * value-position literals, and return the findings (a hardcoded value that equals a token's value).
 */
export function auditTokens(config: Config, files: string[], io: TokenIo): DriftFinding[] {
  const set = loadTokens(config, io);
  if (set.tokens.length === 0) {
    return [];
  }
  const literals = files.flatMap((file) => {
    let contents: string;
    try {
      contents = io.readFile(file);
    } catch {
      return [];
    }
    return scanContent(file, contents);
  });
  const rootFontSize = config.tokens.sources.find(
    (s) => s.rootFontSize !== undefined,
  )?.rootFontSize;
  const options: { rootFontSize?: number; ignoreValues?: string[] } = {};
  if (rootFontSize !== undefined) {
    options.rootFontSize = rootFontSize;
  }
  if (config.tokens.ignoreValues !== undefined) {
    options.ignoreValues = config.tokens.ignoreValues;
  }
  return detectDrift(set, literals, options);
}
