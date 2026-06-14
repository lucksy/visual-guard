/**
 * Shared helpers for the JSON token formats (DTCG, Style Dictionary, Tokens Studio). They differ
 * in keys (`$value` vs `value`) and type vocab, but share group nesting, `{alias.references}`, and
 * the resolve-then-infer flow — captured here.
 */
import type { Token } from "../tokens-model";
import { inferType } from "./infer";
import type { ParseContext } from "./types";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten a scalar/composite raw value to a string the equality core can compare. */
export function scalarToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value); // composite (shadow/typography/…) → stable string
}

export interface RawToken {
  name: string;
  rawValue: unknown;
  /** Declared/mapped type, if the format provides one; else inferred after resolution. */
  type?: Token["type"];
}

/** The alias target inside `{...}`, or null if the value isn't a pure reference. */
function referenceOf(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") {
    return null;
  }
  const match = /^\{([^}]+)\}$/.exec(rawValue.trim());
  return match ? match[1]!.trim() : null;
}

interface ResolvedValue {
  value: string;
  reference?: string;
  type?: Token["type"];
}

function resolve(name: string, map: Map<string, RawToken>, seen: Set<string>): ResolvedValue {
  const entry = map.get(name);
  if (entry === undefined) {
    return { value: name };
  }
  const ref = referenceOf(entry.rawValue);
  if (ref !== null) {
    // Style Dictionary v3 references end in ".value"; DTCG/Studio/SD-v4 do not — try both.
    const targetName = [ref, ref.replace(/\.value$/, "")].find((candidate) => map.has(candidate));
    if (targetName !== undefined && !seen.has(name)) {
      seen.add(name);
      const target = resolve(targetName, map, seen);
      return { value: target.value, reference: targetName, type: entry.type ?? target.type };
    }
    return { value: entry.rawValue as string, type: entry.type }; // unresolved → keep literal
  }
  return { value: scalarToString(entry.rawValue), type: entry.type };
}

/** Resolve aliases and infer missing types, producing the normalized token list. */
export function resolveTokens(raws: RawToken[], ctx: ParseContext): Token[] {
  const map = new Map<string, RawToken>();
  for (const raw of raws) {
    map.set(raw.name, raw);
  }
  return raws.map((raw) => {
    const resolved = resolve(raw.name, map, new Set());
    const type = resolved.type ?? inferType(raw.name, resolved.value);
    const token: Token = {
      name: raw.name,
      value: resolved.value,
      raw: scalarToString(raw.rawValue),
      type,
      path: raw.name.split("."),
      source: ctx.source,
    };
    if (resolved.reference !== undefined) {
      token.reference = resolved.reference;
    }
    if (ctx.mode !== undefined) {
      token.mode = ctx.mode;
    }
    return token;
  });
}
