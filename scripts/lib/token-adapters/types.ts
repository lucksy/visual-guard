import type { Token } from "../tokens-model";

/** The statically-parseable token formats (the JS-eval formats live in T-16e). */
export type StaticFormat =
  | "css"
  | "tailwind"
  | "scss"
  | "less"
  | "dtcg"
  | "style-dictionary"
  | "tokens-studio";

export interface ParseContext {
  /** Identifier of the source file (becomes `Token.source`). */
  source: string;
  /** Mode/theme to select from a multi-mode source; omit = base/default only. */
  mode?: string;
}

export interface TokenAdapter {
  id: StaticFormat;
  /** Whether this adapter handles the file (extension + content sniff). */
  detect(path: string, contents: string): boolean;
  /** Parse file contents into normalized tokens; throws an actionable error on malformed input. */
  parse(contents: string, ctx: ParseContext): Token[];
}

export function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
