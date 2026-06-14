/**
 * JS-eval token adapters (T-16e, opt-in). Resolve a project's `tailwind.config.{js,ts}` or a JS/TS
 * theme object into tokens by evaluating the file in a **sandboxed child process** (never in the
 * engine process) and flattening the resulting theme. Gated behind `tokens.allowJsEval` because it
 * executes project code. The flattening (`flattenThemeTokens`) is pure and unit-testable.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Token, TokenType } from "../tokens-model";
import type { ParseContext } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "eval-theme.mjs");
const requireFrom = createRequire(import.meta.url);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 32 * 1024 * 1024;

export type JsEvalMode = "tailwind-config" | "js-theme";

export interface JsEvalOptions {
  allowJsEval: boolean;
  timeoutMs?: number;
}

/** Locate the tsx CLI so the child can evaluate `.ts` config/theme files. */
function tsxCli(): string {
  const pkgPath = requireFrom.resolve("tsx/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.tsx;
  if (relative === undefined) {
    throw new Error(
      "Visual Guard tokens: could not locate the tsx runner for JS-eval token sources.",
    );
  }
  return resolve(dirname(pkgPath), relative);
}

/** Evaluate a JS/TS config/theme file in a sandboxed child process; returns the parsed theme. */
export function evalThemeFile(absPath: string, mode: JsEvalMode, options: JsEvalOptions): unknown {
  if (!options.allowJsEval) {
    throw new Error(
      `Visual Guard tokens: "${absPath}" is a JS-eval source (${mode}); set "tokens.allowJsEval": true to evaluate project code.`,
    );
  }
  const result = spawnSync(process.execPath, [tsxCli(), RUNNER, absPath, mode], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) {
    throw new Error(
      `Visual Guard tokens: failed to evaluate "${absPath}": ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim() || `exited with code ${result.status}`;
    throw new Error(`Visual Guard tokens: evaluating "${absPath}" failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`Visual Guard tokens: "${absPath}" did not produce a JSON-serializable theme.`);
  }
}

// --- Theme flattening (pure) ----------------------------------------------

/** Tailwind theme key → token type. */
const TAILWIND_KEY_TYPES: Record<string, TokenType> = {
  colors: "color",
  backgroundColor: "color",
  textColor: "color",
  borderColor: "color",
  spacing: "dimension",
  padding: "dimension",
  margin: "dimension",
  gap: "dimension",
  width: "dimension",
  height: "dimension",
  maxWidth: "dimension",
  minWidth: "dimension",
  inset: "dimension",
  borderRadius: "radius",
  borderWidth: "dimension",
  fontSize: "fontSize",
  fontWeight: "fontWeight",
  fontFamily: "fontFamily",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  boxShadow: "shadow",
  opacity: "opacity",
  zIndex: "zIndex",
  transitionDuration: "duration",
};

/** Theme UI / styled-system theme key → token type. */
const JS_THEME_KEY_TYPES: Record<string, TokenType> = {
  colors: "color",
  space: "dimension",
  sizes: "dimension",
  radii: "radius",
  borderWidths: "dimension",
  fontSizes: "fontSize",
  fontWeights: "fontWeight",
  fonts: "fontFamily",
  lineHeights: "lineHeight",
  letterSpacings: "letterSpacing",
  shadows: "shadow",
  opacities: "opacity",
  zIndices: "zIndex",
  durations: "duration",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten a theme object into typed tokens. Nested objects → dotted names; arrays are scales
 * (index → name) except Tailwind `fontSize` entries (`[size, config]` → size) and `fontFamily`
 * stacks (joined). Only keys present in `keyTypes` are walked, so non-token theme keys are ignored.
 */
export function flattenThemeTokens(
  theme: unknown,
  keyTypes: Record<string, TokenType>,
  ctx: ParseContext,
): Token[] {
  if (!isRecord(theme)) {
    return [];
  }
  const out: Token[] = [];
  const emit = (name: string, raw: unknown, type: TokenType): void => {
    if (typeof raw !== "string" && typeof raw !== "number") {
      return;
    }
    const value = String(raw);
    const token: Token = {
      name,
      value,
      raw: value,
      type,
      path: name.split("."),
      source: ctx.source,
    };
    if (ctx.mode !== undefined) {
      token.mode = ctx.mode;
    }
    out.push(token);
  };

  const walk = (node: unknown, path: string[], type: TokenType, fontSizeArrays: boolean): void => {
    if (Array.isArray(node)) {
      if (
        type === "fontFamily" &&
        node.every((x) => typeof x === "string" || typeof x === "number")
      ) {
        emit(path.join("."), node.join(", "), type);
        return;
      }
      if (fontSizeArrays && (typeof node[0] === "string" || typeof node[0] === "number")) {
        emit(path.join("."), node[0], type); // Tailwind fontSize: [size, { lineHeight }]
        return;
      }
      node.forEach((item, index) => walk(item, [...path, String(index)], type, false));
      return;
    }
    if (isRecord(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (key === "DEFAULT") {
          emit(path.join("."), child, type);
        } else {
          walk(child, [...path, key], type, fontSizeArrays);
        }
      }
      return;
    }
    emit(path.join("."), node, type);
  };

  for (const [key, type] of Object.entries(keyTypes)) {
    if (key in theme) {
      walk(theme[key], [key], type, key === "fontSize");
    }
  }
  return out;
}

/** Resolve `src` to an absolute path (relative paths resolve against the project cwd). */
function absolutize(source: string): string {
  return resolve(source);
}

export function parseTailwindConfigFile(
  source: string,
  ctx: ParseContext,
  options: JsEvalOptions,
): Token[] {
  const theme = evalThemeFile(absolutize(source), "tailwind-config", options);
  return flattenThemeTokens(theme, TAILWIND_KEY_TYPES, ctx);
}

export function parseJsThemeFile(
  source: string,
  ctx: ParseContext,
  options: JsEvalOptions,
): Token[] {
  const theme = evalThemeFile(absolutize(source), "js-theme", options);
  return flattenThemeTokens(theme, JS_THEME_KEY_TYPES, ctx);
}
