import postcss, { type Root } from "postcss";
import scssSyntax from "postcss-scss";
import lessSyntax from "postcss-less";

/**
 * CSS import extraction for the change-scope graph (Phase 3). The TS extractor (`preProcessFile`)
 * only sees JS/TS imports, so a `.css` reached via `Button.tsx → Button.css` is treated as a leaf —
 * its `@import './shared.css'` is invisible, and editing `shared.css` would map to no story (a
 * silent miss). This parses CSS/SCSS/LESS for `@import` / `@use` / `@forward` targets and CSS-Modules
 * `composes … from`, so those become real graph edges. Pure (text in → specifiers out); the resolver
 * resolves the returned specifiers to files.
 */

const CSS_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".styl", ".pcss"]);

/** Is `file` a stylesheet the CSS extractor should handle (by extension)? */
export function isCssFile(file: string): boolean {
  const dot = file.lastIndexOf(".");
  return dot >= 0 && CSS_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

/**
 * Classify a raw `url(...)` target. A relative file path is an `asset` edge (content-hashed into the
 * closure); an interpolated / `var()` path is `dynamic` (can't follow → importer incomplete); a
 * fragment (`#id`), remote (`http(s)://`, `//`), `data:`, or ABSOLUTE (`/logo.png`) target is `skip`
 * — not a story-local closure edge. (Absolute paths are static-serve assets served from a `public/` /
 * `staticDirs` root: covered by the global globs + the static enumeration in `G`, not by `S`.)
 */
export function classifyUrlTarget(raw: string): "asset" | "dynamic" | "skip" {
  const value = raw.trim();
  if (value.length === 0) return "skip";
  // SCSS/LESS interpolation or a CSS `var()` inside the path — the asset is computed → can't follow.
  if (/[#@$]\{/.test(value) || /\bvar\(/i.test(value)) return "dynamic";
  if (value.startsWith("#")) return "skip"; // in-document fragment reference (url(#gradient))
  if (/^(?:https?:)?\/\//i.test(value)) return "skip"; // remote / protocol-relative
  if (/^data:/i.test(value)) return "skip"; // inline data URI
  if (value.startsWith("/")) return "skip"; // absolute → static-serve root (global, not a closure edge)
  return "asset"; // a relative path: ./bg.png, ../fonts/Brand.woff2, images/sprite.png
}

/** Every `url(...)` target in a declaration value, in order (handles quotes + whitespace + multiples). */
function urlTargets(value: string): string[] {
  const out: string[] = [];
  for (const match of value.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    const raw = match[2];
    if (raw !== undefined) out.push(raw);
  }
  return out;
}

/**
 * Extract import-like specifiers from a stylesheet: `@import` / `@use` / `@forward` targets and
 * CSS-Modules `composes … from` (→ `specifiers`, resolved as CSS imports), PLUS `url(...)` asset
 * references in declaration values (→ `assets`, resolved by exact path — fonts/images that change a
 * render's pixels). `dynamic` is true when the file can't be parsed OR has an at-rule/url whose target
 * isn't a static local path (an interpolated `@import "#{$x}"` / `url(var(--x))`) — the importer is
 * then marked graph-incomplete (captured every run, never skipped) rather than silently missing it.
 */
export function extractCssSpecifiers(text: string, ext: string): {
  specifiers: string[];
  assets: string[];
  dynamic: boolean;
} {
  const lower = ext.toLowerCase();
  let root: Root;
  try {
    if (lower === ".scss" || lower === ".sass") {
      root = scssSyntax.parse(text);
    } else if (lower === ".less") {
      root = lessSyntax.parse(text);
    } else {
      root = postcss.parse(text);
    }
  } catch {
    return { specifiers: [], assets: [], dynamic: true }; // unparseable → conservative incomplete
  }

  const specifiers: string[] = [];
  const assets: string[] = [];
  let dynamic = false;
  const add = (raw: string | null): void => {
    if (raw === null) {
      dynamic = true; // an @import we can't read statically (bare identifier)
      return;
    }
    // SCSS/LESS interpolation inside the path (`#{$x}`, `@{x}`, `${x}`) — can't follow → incomplete.
    if (/[#@$]\{/.test(raw)) {
      dynamic = true;
      return;
    }
    // Remote / inline stylesheets are not local graph edges.
    if (/^(?:https?:)?\/\//i.test(raw) || raw.startsWith("data:")) {
      return;
    }
    specifiers.push(raw);
  };
  const addAsset = (raw: string): void => {
    const cls = classifyUrlTarget(raw);
    if (cls === "dynamic") {
      dynamic = true;
    } else if (cls === "asset") {
      assets.push(raw.trim());
    }
    // "skip" → remote / data / absolute / fragment: not a story-local closure edge.
  };

  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase();
    if (name === "import") {
      // `@import` can carry MULTIPLE comma-separated targets. Layer/supports/media clauses contain
      // no quoted strings or url()s, so every string/url in the params is a real import target.
      const targets = allImportTargets(rule.params);
      if (targets.length === 0 && rule.params.trim().length > 0) {
        add(null); // params we couldn't read any target from (bare/interpolated) → incomplete
      } else {
        for (const target of targets) {
          add(target);
        }
      }
    } else if (name === "use" || name === "forward") {
      add(firstStringParam(rule.params)); // SCSS @use/@forward take a single module
    }
  });
  root.walkDecls((decl) => {
    // CSS Modules `composes: x from "./other.css"` — every `from "<path>"` clause is an edge (a
    // single declaration may have several); `composes: base` (same file) / `from global` carry none.
    if (decl.prop.toLowerCase() === "composes") {
      for (const match of decl.value.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        add(match[1] ?? null);
      }
      return;
    }
    // `url(...)` asset references in ANY declaration value — @font-face `src`, `background`, `mask`,
    // `cursor`, `list-style-image`, `border-image`, custom properties. A re-subset font or swapped
    // image changes the rendered pixels, so these must be content-hashed closure nodes (else a skip
    // would copy a stale baseline forward). (@import url() is an at-rule, handled above — no overlap.)
    for (const target of urlTargets(decl.value)) {
      addAsset(target);
    }
  });

  return { specifiers, assets, dynamic };
}

/**
 * Every string / `url(...)` target in an `@import`'s params, in order. A media-query / `layer(...)` /
 * `supports(...)` clause contains no quoted strings or `url()`s, so every match is a real import
 * target — correctly handling both a single import-with-media and a comma-separated multi-import,
 * and recovering the path from LESS option syntax like `@import (reference) "./x.less"`.
 */
function allImportTargets(params: string): string[] {
  const targets: string[] = [];
  const pattern = /url\(\s*(["']?)([^"')]+)\1\s*\)|(["'])([^"']+)\3/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(params)) !== null) {
    const value = match[2] ?? match[4];
    if (value !== undefined) {
      targets.push(value);
    }
  }
  return targets;
}

/**
 * Pull the first static path from an at-rule's params — a quoted string or a `url(...)` target —
 * ignoring trailing media queries / SCSS `as`/`with` clauses. Returns null when the param isn't a
 * static string (a bare identifier or `#{…}` interpolation), so the caller marks the file incomplete.
 */
function firstStringParam(params: string): string | null {
  const trimmed = params.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const urlMatch = /^url\(\s*(["']?)([^"')]+)\1\s*\)/i.exec(trimmed);
  if (urlMatch && urlMatch[2] !== undefined) {
    return urlMatch[2];
  }
  const stringMatch = /^(["'])([^"']+)\1/.exec(trimmed);
  if (stringMatch && stringMatch[2] !== undefined) {
    return stringMatch[2];
  }
  return null; // bare / interpolated → can't follow statically
}
