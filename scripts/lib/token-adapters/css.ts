/**
 * CSS-family token adapters (T-16c): CSS custom properties, Tailwind v4 `@theme`, SCSS `$vars`,
 * and Less `@vars`. All four are parsed with PostCSS (plus the scss/less syntaxes), differing only
 * in how a variable declaration is spelled and how its type is inferred. Modes (light/dark) are
 * read from the enclosing selector / `@media (prefers-color-scheme)`; `var()` / `$x` / `@x` aliases
 * are resolved against the selected mode.
 */
import postcss, { type AtRule, type Node, type Root, type Rule } from "postcss";
import scssSyntax from "postcss-scss";
import lessSyntax from "postcss-less";
import type { Token } from "../tokens-model";
import { inferType, tailwindTypeFromName } from "./infer";
import { detailOf, type ParseContext } from "./types";

export type CssFamily = "css" | "tailwind" | "scss" | "less";

interface RawEntry {
  name: string;
  value: string;
  mode: string; // "" = base
}

/** Strip Sass `!default` / `!global` flags from a value. */
function stripFlags(value: string): string {
  return value.replace(/\s*!(default|global)\b/gi, "").trim();
}

function modeOfSelector(selector: string): string | null {
  const attr = /\[data-(?:theme|mode|color-scheme)\s*=\s*["']?([\w-]+)["']?\]/i.exec(selector);
  if (attr) {
    return attr[1]!.toLowerCase();
  }
  const themeClass = /\.theme-([\w-]+)/i.exec(selector);
  if (themeClass) {
    return themeClass[1]!.toLowerCase();
  }
  const darkLight = /(?:^|[\s>~+])\.(dark|light)\b/i.exec(selector);
  if (darkLight) {
    return darkLight[1]!.toLowerCase();
  }
  return null;
}

function modeOfAtRule(name: string, params: string): string | null {
  if (name.toLowerCase() === "media") {
    const match = /prefers-color-scheme\s*:\s*(dark|light)/i.exec(params);
    if (match) {
      return match[1]!.toLowerCase();
    }
  }
  return null;
}

/** The mode of a node = the first themed ancestor selector / media query, else "" (base). */
function modeFromContext(node: Node): string {
  let current: Node | undefined = node.parent as Node | undefined;
  while (current) {
    if (current.type === "rule") {
      const mode = modeOfSelector((current as Rule).selector);
      if (mode) {
        return mode;
      }
    } else if (current.type === "atrule") {
      const atRule = current as AtRule;
      const mode = modeOfAtRule(atRule.name, atRule.params);
      if (mode) {
        return mode;
      }
    }
    current = current.parent as Node | undefined;
  }
  return "";
}

function collectEntries(root: Root, family: CssFamily): RawEntry[] {
  const entries: RawEntry[] = [];
  if (family === "less") {
    root.walkAtRules((atRule) => {
      const less = atRule as AtRule & { variable?: boolean; value?: string };
      if (less.variable === true) {
        entries.push({
          name: `@${atRule.name}`,
          value: stripFlags(less.value ?? atRule.params),
          mode: modeFromContext(atRule),
        });
      }
    });
    return entries;
  }
  root.walkDecls((decl) => {
    const isVar = family === "scss" ? decl.prop.startsWith("$") : decl.prop.startsWith("--");
    if (!isVar) {
      return;
    }
    entries.push({ name: decl.prop, value: stripFlags(decl.value), mode: modeFromContext(decl) });
  });
  return entries;
}

function pathOf(name: string): string[] {
  return name
    .replace(/^(--|\$|@)/, "")
    .split(/[-.]/)
    .filter(Boolean);
}

/** A single whole-value alias reference for each family, or null if the value isn't a pure alias. */
function aliasTarget(value: string, family: CssFamily): string | null {
  const trimmed = value.trim();
  if (family === "scss") {
    const match = /^\$([\w-]+)$/.exec(trimmed);
    return match ? `$${match[1]}` : null;
  }
  if (family === "less") {
    const match = /^@([\w-]+)$/.exec(trimmed);
    return match ? `@${match[1]}` : null;
  }
  const match = /^var\(\s*(--[\w-]+)\s*\)$/.exec(trimmed);
  return match ? match[1]! : null;
}

interface Resolved {
  value: string;
  reference?: string;
}

/** Resolve a single-reference alias chain against the effective map (cycle- and miss-safe). */
function resolveValue(
  name: string,
  map: Map<string, string>,
  family: CssFamily,
  seen: Set<string>,
): Resolved {
  const raw = map.get(name);
  if (raw === undefined) {
    return { value: name };
  }
  const target = aliasTarget(raw, family);
  if (target === null || seen.has(name) || !map.has(target)) {
    return { value: raw };
  }
  seen.add(name);
  const resolved = resolveValue(target, map, family, seen);
  return { value: resolved.value, reference: target };
}

export function parseCssFamily(contents: string, ctx: ParseContext, family: CssFamily): Token[] {
  let root: Root;
  try {
    root =
      family === "scss"
        ? (scssSyntax.parse(contents) as Root)
        : family === "less"
          ? lessSyntax.parse(contents)
          : postcss.parse(contents);
  } catch (err) {
    throw new Error(`could not parse ${family} token source "${ctx.source}": ${detailOf(err)}`);
  }

  const entries = collectEntries(root, family);

  const base = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const entry of entries) {
    if (entry.mode === "") {
      base.set(entry.name, entry.value);
    } else if (ctx.mode && entry.mode === ctx.mode) {
      overrides.set(entry.name, entry.value);
    }
  }
  const effective = new Map<string, string>(base);
  for (const [name, value] of overrides) {
    effective.set(name, value);
  }

  const tokens: Token[] = [];
  for (const [name, rawValue] of effective) {
    const resolved = resolveValue(name, effective, family, new Set());
    const type =
      family === "tailwind"
        ? (tailwindTypeFromName(name) ?? inferType(name, resolved.value))
        : inferType(name, resolved.value);
    const token: Token = {
      name,
      value: resolved.value,
      raw: rawValue,
      type,
      path: pathOf(name),
      source: ctx.source,
    };
    if (resolved.reference !== undefined) {
      token.reference = resolved.reference;
    }
    if (overrides.has(name) && ctx.mode) {
      token.mode = ctx.mode;
    }
    tokens.push(token);
  }
  return tokens;
}
