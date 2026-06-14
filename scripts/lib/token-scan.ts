/**
 * Literal scanner + drift detector (T-16d). Extracts hardcoded **value-position** literals from
 * changed UI files — CSS/SCSS/Less declaration values (PostCSS), JSX `style={{}}` props and
 * Tailwind utility classes with arbitrary values like `p-[8px]` / `text-[#fff]` (TypeScript AST) —
 * then flags any literal that equals a design token's value (the token was inlined). This is the
 * gate that catches what the luminance-normalized pixel diff cannot: recolors and sub-threshold
 * spacing inlined as raw values.
 */
import ts from "typescript";
import postcss, { type Root } from "postcss";
import scssSyntax from "postcss-scss";
import lessSyntax from "postcss-less";
import { canonicalize, canonicalizeAuto, type Confidence } from "./token-equality";
import type { Token, TokenSet, TokenType } from "./tokens-model";

export type LiteralSource = "css" | "jsx-style" | "tailwind-class";

export interface ScannedLiteral {
  file: string;
  line: number;
  /** CSS property / JSX style prop (kebab) / Tailwind utility prefix, for type + ranking context. */
  property?: string;
  value: string;
  /** Type implied by the property/utility context, if any (else canonicalized by shape). */
  typeHint?: TokenType;
  source: LiteralSource;
}

export interface DriftFinding {
  file: string;
  line: number;
  cssProperty?: string;
  literal: string;
  canonicalValue: string;
  type: TokenType;
  suggestedToken: string;
  alternatives: string[];
  confidence: Confidence;
  reason: string;
}

export interface DriftOptions {
  rootFontSize?: number;
  /** Trivially-common values never to flag (e.g. "0", "auto", "none"). Raw and canonical forms. */
  ignoreValues?: string[];
}

// --- CSS-property / Tailwind-utility → type context ------------------------

const LENGTH_TYPES = new Set<TokenType>(["dimension", "radius", "fontSize", "letterSpacing"]);

function typeForCssProperty(prop: string): TokenType | undefined {
  const p = prop.toLowerCase();
  if (
    p === "color" ||
    p === "fill" ||
    p === "stroke" ||
    p.endsWith("-color") ||
    p === "background"
  ) {
    return "color";
  }
  if (p === "border-radius" || p.endsWith("-radius")) {
    return "radius";
  }
  if (p === "font-size") {
    return "fontSize";
  }
  if (p === "font-weight") {
    return "fontWeight";
  }
  if (p === "line-height") {
    return "lineHeight";
  }
  if (p === "letter-spacing") {
    return "letterSpacing";
  }
  if (p === "z-index") {
    return "zIndex";
  }
  if (p === "opacity") {
    return "opacity";
  }
  if (p === "font-family") {
    return "fontFamily";
  }
  if (p === "box-shadow" || p === "text-shadow") {
    return "shadow";
  }
  if (/duration|delay/.test(p)) {
    return "duration";
  }
  if (
    /^(padding|margin|gap|width|height|top|right|bottom|left|inset|flex-basis|row-gap|column-gap|translate)/.test(
      p,
    ) ||
    p.startsWith("min-") ||
    p.startsWith("max-")
  ) {
    return "dimension";
  }
  return undefined;
}

const TW_DIMENSION_PREFIX =
  /^(p[xytrblse]?|m[xytrblse]?|gap(-[xy])?|space-[xy]|w|h|min-w|max-w|min-h|max-h|size|top|right|bottom|left|inset(-[xy])?|basis|indent|translate-[xy])$/;

/** Map a Tailwind arbitrary-value utility (`prefix-[value]`) to a token type. */
function typeForTailwindUtility(prefix: string, value: string): TokenType | undefined {
  const p = prefix.replace(/^-/, "");
  if (TW_DIMENSION_PREFIX.test(p)) {
    return "dimension";
  }
  if (p.startsWith("rounded")) {
    return "radius";
  }
  if (/^(bg|from|via|to|fill|stroke|caret|accent|decoration|ring|outline|divide)$/.test(p)) {
    return "color";
  }
  if (p === "text") {
    return canonicalizeAuto(value)?.class === "color" ? "color" : "fontSize";
  }
  if (p === "border" || /^border-[trblxyse]$/.test(p)) {
    return canonicalizeAuto(value)?.class === "color" ? "color" : "dimension";
  }
  if (p === "leading") {
    return "lineHeight";
  }
  if (p === "tracking") {
    return "letterSpacing";
  }
  if (p === "z") {
    return "zIndex";
  }
  if (p === "opacity") {
    return "opacity";
  }
  if (p === "duration" || p === "delay") {
    return "duration";
  }
  if (p === "font") {
    return "fontWeight";
  }
  if (p === "shadow") {
    return "shadow";
  }
  return undefined;
}

// --- CSS / SCSS / Less scanning -------------------------------------------

/** Split a CSS value into top-level tokens (respecting parentheses), e.g. "1px solid #ccc". */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth--;
      current += ch;
    } else if ((ch === " " || ch === ",") && depth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

const SKIP_FUNCTIONS = /^(var|calc|env|min|max|clamp|attr|counter|url)\(/i;

function extractCssLiterals(value: string, family: "css" | "scss" | "less"): string[] {
  return splitTopLevel(value).filter((tok) => {
    if (SKIP_FUNCTIONS.test(tok)) {
      return false;
    }
    if (family === "scss" && (tok.startsWith("$") || tok.includes("#{"))) {
      return false;
    }
    if (family === "less" && tok.startsWith("@")) {
      return false;
    }
    return true;
  });
}

function scanCss(
  contents: string,
  file: string,
  family: "css" | "scss" | "less",
): ScannedLiteral[] {
  let root: Root;
  try {
    root =
      family === "scss"
        ? (scssSyntax.parse(contents) as Root)
        : family === "less"
          ? lessSyntax.parse(contents)
          : postcss.parse(contents);
  } catch {
    return []; // unparseable file — scan nothing rather than abort the audit
  }

  const out: ScannedLiteral[] = [];
  root.walkDecls((decl) => {
    if (decl.prop.startsWith("--") || decl.prop.startsWith("$")) {
      return; // token *definitions*, not usages
    }
    const literals = extractCssLiterals(decl.value, family);
    const line = decl.source?.start?.line ?? 0;
    // A single-value declaration gets its property's type context; a shorthand uses shape inference.
    const typeHint = literals.length === 1 ? typeForCssProperty(decl.prop) : undefined;
    for (const literal of literals) {
      out.push({ file, line, property: decl.prop, value: literal, typeHint, source: "css" });
    }
  });
  return out;
}

// --- JSX / TS scanning (style props + Tailwind classes) -------------------

function camelToKebab(name: string): string {
  return name.replace(/([A-Z])/g, "-$1").toLowerCase();
}

const TW_ARBITRARY = /^-?([a-z][a-z0-9-]*?)-\[([^\]]+)\]$/;

function parseTailwindClasses(text: string, file: string, line: number): ScannedLiteral[] {
  const out: ScannedLiteral[] = [];
  for (const cls of text.split(/\s+/)) {
    const match = TW_ARBITRARY.exec(cls);
    if (!match) {
      continue;
    }
    const prefix = match[1]!;
    const value = match[2]!.replace(/_/g, " "); // Tailwind uses _ for spaces in arbitrary values
    out.push({
      file,
      line,
      property: prefix,
      value,
      typeHint: typeForTailwindUtility(prefix, value),
      source: "tailwind-class",
    });
  }
  return out;
}

function scanJsx(contents: string, file: string): ScannedLiteral[] {
  const out: ScannedLiteral[] = [];
  const sf = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const scanStyleObject = (obj: ts.ObjectLiteralExpression): void => {
    for (const member of obj.properties) {
      if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) {
        continue;
      }
      const prop = camelToKebab(member.name.text);
      const typeHint = typeForCssProperty(prop);
      const init = member.initializer;
      if (ts.isStringLiteralLike(init)) {
        out.push({
          file,
          line: lineOf(member),
          property: prop,
          value: init.text,
          typeHint,
          source: "jsx-style",
        });
      } else if (ts.isNumericLiteral(init)) {
        // React numeric style values are px for length props, unitless otherwise.
        const value = typeHint && LENGTH_TYPES.has(typeHint) ? `${init.text}px` : init.text;
        out.push({
          file,
          line: lineOf(member),
          property: prop,
          value,
          typeHint,
          source: "jsx-style",
        });
      }
    }
  };

  const collectStrings = (node: ts.Node, into: { text: string; line: number }[]): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      into.push({ text: node.text, line: lineOf(node) });
    }
    ts.forEachChild(node, (child) => collectStrings(child, into));
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (name === "style") {
        const expr = ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
        if (expr && ts.isObjectLiteralExpression(expr)) {
          scanStyleObject(expr);
        }
      } else if (name === "className" || name === "class") {
        const strings: { text: string; line: number }[] = [];
        collectStrings(node.initializer, strings);
        for (const { text, line } of strings) {
          out.push(...parseTailwindClasses(text, file, line));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Scan one file's contents into literals, dispatching by extension. */
export function scanContent(file: string, contents: string): ScannedLiteral[] {
  const lower = file.toLowerCase();
  if (lower.endsWith(".css")) {
    return scanCss(contents, file, "css");
  }
  if (lower.endsWith(".scss") || lower.endsWith(".sass")) {
    return scanCss(contents, file, "scss");
  }
  if (lower.endsWith(".less")) {
    return scanCss(contents, file, "less");
  }
  if (/\.(tsx|jsx|ts|js|mjs|cjs)$/.test(lower)) {
    return scanJsx(contents, file);
  }
  return [];
}

// --- Drift detection ------------------------------------------------------

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

function weakest(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

interface TypeKeywords {
  primary: string[];
  secondary: string[];
}

const TYPE_KEYWORDS: Partial<Record<TokenType, TypeKeywords>> = {
  color: {
    primary: ["color", "colour"],
    secondary: ["bg", "background", "fg", "brand", "surface"],
  },
  dimension: {
    primary: ["space", "spacing", "gap"],
    secondary: ["size", "sizing", "pad", "margin", "inset", "width", "height"],
  },
  radius: { primary: ["radius", "rounded"], secondary: ["corner"] },
  fontSize: { primary: ["fontsize", "font-size", "text-size"], secondary: ["font", "text"] },
  fontWeight: { primary: ["weight", "font-weight"], secondary: ["font"] },
  lineHeight: { primary: ["leading", "line-height"], secondary: ["line"] },
  letterSpacing: { primary: ["tracking", "letter-spacing"], secondary: ["letter"] },
  shadow: { primary: ["shadow"], secondary: ["elevation"] },
  duration: { primary: ["duration"], secondary: ["motion", "transition", "delay"] },
  zIndex: { primary: ["zindex", "z-index"], secondary: ["layer", "z"] },
  opacity: { primary: ["opacity"], secondary: ["alpha"] },
};

/**
 * Rank value-equal token candidates by how well their name/path matches the literal's context:
 * an exact property-name part (weight 3) beats a primary type keyword (2) beats a secondary one (1),
 * so `padding: 8px` prefers `--space-md` over `--font-size-xs`. Ties break alphabetically.
 */
function rankCandidates(candidates: Token[], literal: ScannedLiteral): Token[] {
  const propParts = (literal.property ?? "").toLowerCase().split(/[-_]/).filter(Boolean);
  const keywords = literal.typeHint ? TYPE_KEYWORDS[literal.typeHint] : undefined;
  const score = (token: Token): number => {
    const haystack = `${token.name} ${token.path.join(" ")}`.toLowerCase();
    let total = 0;
    for (const part of propParts) {
      if (haystack.includes(part)) {
        total += 3;
      }
    }
    if (keywords) {
      for (const primary of keywords.primary) {
        if (haystack.includes(primary)) {
          total += 2;
        }
      }
      for (const secondary of keywords.secondary) {
        if (haystack.includes(secondary)) {
          total += 1;
        }
      }
    }
    return total;
  };
  return [...candidates].sort((a, b) => {
    const delta = score(b) - score(a);
    return delta !== 0 ? delta : a.name.localeCompare(b.name);
  });
}

/** Flag scanned literals that inline a token's value. Pure — golden against a TokenSet. */
export function detectDrift(
  set: TokenSet,
  literals: ScannedLiteral[],
  options?: DriftOptions,
): DriftFinding[] {
  const opts =
    options?.rootFontSize !== undefined ? { rootFontSize: options.rootFontSize } : undefined;
  const ignoreRaw = new Set((options?.ignoreValues ?? []).map((v) => v.trim()));
  const ignoreKeys = new Set<string>();
  for (const v of options?.ignoreValues ?? []) {
    const c = canonicalizeAuto(v, opts);
    if (c) {
      ignoreKeys.add(`${c.class}:${c.value}`);
    }
  }

  const findings: DriftFinding[] = [];
  for (const literal of literals) {
    if (ignoreRaw.has(literal.value.trim())) {
      continue;
    }
    const canon = literal.typeHint
      ? canonicalize(literal.value, literal.typeHint, opts)
      : canonicalizeAuto(literal.value, opts);
    if (canon === null) {
      continue;
    }
    const key = `${canon.class}:${canon.value}`;
    if (ignoreKeys.has(key)) {
      continue;
    }
    const candidates = set.byCanonicalValue.get(key);
    if (candidates === undefined || candidates.length === 0) {
      continue;
    }
    const ranked = rankCandidates(candidates, literal);
    const best = ranked[0]!;
    const tokenCanon = canonicalize(best.value, best.type, opts);
    const confidence = weakest(canon.confidence, tokenCanon?.confidence ?? "high");
    const prefix = literal.property ? `${literal.property}: ` : "";
    findings.push({
      file: literal.file,
      line: literal.line,
      cssProperty: literal.property,
      literal: literal.value,
      canonicalValue: canon.value,
      type: best.type,
      suggestedToken: best.name,
      alternatives: ranked.slice(1).map((t) => t.name),
      confidence,
      reason: `hardcoded ${prefix}${literal.value} inlines token ${best.name}`,
    });
  }
  return findings;
}
