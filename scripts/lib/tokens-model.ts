/**
 * Normalized token model (T-16b). The format adapters (T-16c) parse every supported source into
 * `Token`s; the equality core (`token-equality.ts`) canonicalizes their values so the drift
 * scanner (T-16d) can tell when a hardcoded literal inlines a token. Types only — no I/O, no logic.
 */

/**
 * A token's semantic kind. Drives the value-equality class used to compare it against a literal.
 * `custom:<name>` preserves a source `$type` we don't model yet (so unknown types aren't dropped).
 */
export type TokenType =
  | "color"
  | "dimension"
  | "fontFamily"
  | "fontWeight"
  | "fontSize"
  | "lineHeight"
  | "letterSpacing"
  | "duration"
  | "cubicBezier"
  | "shadow"
  | "border"
  | "gradient"
  | "radius"
  | "opacity"
  | "zIndex"
  | "number"
  | "string"
  | `custom:${string}`;

export interface Token {
  /** Canonical dotted/prefixed name, e.g. "color.brand.primary" or "--space-md". */
  name: string;
  /** Resolved value as written (alias already resolved); canonicalization is the equality core's job. */
  value: string;
  /** The value exactly as it appeared in the source (pre-resolution), for reporting. */
  raw: string;
  type: TokenType;
  /** Group path leading to the token, for context-aware ranking (e.g. ["color","brand"]). */
  path: string[];
  /** Theme/mode this value belongs to (e.g. "dark"), if the source is multi-mode. */
  mode?: string;
  /** Identifier of the source (file path / format) that produced the token. */
  source: string;
  /** If this token aliases another, the referenced token name (already resolved into `value`). */
  reference?: string;
}

export interface TokenSet {
  tokens: Token[];
  /** name → token (last write wins on a duplicate name). */
  byName: Map<string, Token>;
  /** `${equalityClass}:${canonicalValue}` → tokens sharing that value (a collision = candidates). */
  byCanonicalValue: Map<string, Token[]>;
}
