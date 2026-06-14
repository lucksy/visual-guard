import { readFileSync } from "node:fs";

export type DetectMode = "auto";

export interface StorybookTarget {
  type: "storybook";
  url: string;
  /** Instance label for the output/baseline path; defaults to the URL host:port (targets.ts). */
  name?: string;
  /** Explicit story ids to render; bypasses discovery when present (see targets.ts). */
  stories?: string[];
}

export interface AppTarget {
  type: "app";
  url: string;
  /** Instance label for the output/baseline path; defaults to the URL host:port (targets.ts). */
  name?: string;
  /** Explicit routes to render; bypasses discovery when present. */
  routes?: string[];
}

export type Target = StorybookTarget | AppTarget;

/**
 * Token source formats. The static formats parse without executing project code; the JS-eval
 * formats (`tailwind-config`, `js-theme`) run a project file and require `tokens.allowJsEval`.
 */
export type TokenFormat =
  | "css"
  | "dtcg"
  | "style-dictionary"
  | "tailwind"
  | "tokens-studio"
  | "scss"
  | "less"
  | "tailwind-config"
  | "js-theme";

export interface TokenSourceObject {
  /** Path (or glob) to the token file, relative to the consuming project root. */
  source: string;
  /** Adapter to use; "auto" detects by extension + content. Normalized output always sets it. */
  format: TokenFormat | "auto";
  /** Theme/mode to select from a multi-mode source (e.g. "dark"); omit = default/all. */
  mode?: string;
  /** Root font size (px) for rem→px equality on this source; defaults to 16 at use site. */
  rootFontSize?: number;
}

export interface TokensConfig {
  /** One or more token sources, merged into a single token set. */
  sources: TokenSourceObject[];
  /** Trivially-common values the drift scanner must never flag (e.g. "0", "auto", "none"). */
  ignoreValues?: string[];
  /** Opt-in to JS-eval adapters (executes project code in a child process). Default false. */
  allowJsEval?: boolean;
}

export interface Config {
  detect: DetectMode;
  targets: Target[];
  viewports: number[];
  states: string[];
  threshold: number;
  maxDiffRatio: number;
  baselineDir: string;
  uiGlobs: string[];
  tokens: TokensConfig;
}

const DEFAULTS = {
  detect: "auto" as DetectMode,
  viewports: [375, 768, 1280],
  states: ["default", "hover", "disabled"],
  threshold: 0.1,
  maxDiffRatio: 0.01,
  baselineDir: ".visual-baselines",
  uiGlobs: ["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss}"],
};

const DEFAULT_TOKEN_SOURCE = "src/styles/tokens.css";
const TOKEN_FORMATS: readonly (TokenFormat | "auto")[] = [
  "auto",
  "css",
  "dtcg",
  "style-dictionary",
  "tailwind",
  "tokens-studio",
  "scss",
  "less",
  "tailwind-config",
  "js-theme",
];
export const JS_EVAL_FORMATS: readonly TokenFormat[] = ["tailwind-config", "js-theme"];

const PREFIX = "Visual Guard config";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRatio(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    fail(`"${field}" must be a number between 0 and 1 (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`"${field}" must be a non-empty string.`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`"${field}" must be an array of strings.`);
  }
  return value as string[];
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    fail(`"${field}" must be a boolean.`);
  }
  return value;
}

function asPositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !(value > 0)) {
    fail(`"${field}" must be a positive number.`);
  }
  return value;
}

function asPositiveNumberArray(value: unknown, field: string): number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "number" || !(item > 0))
  ) {
    fail(`"${field}" must be a non-empty array of positive numbers.`);
  }
  return value as number[];
}

function parseTarget(raw: unknown, index: number): Target {
  if (!isObject(raw)) {
    fail(`targets[${index}] must be an object.`);
  }
  const { type, url } = raw;
  if (type !== "storybook" && type !== "app") {
    fail(`targets[${index}].type must be "storybook" or "app" (got ${JSON.stringify(type)}).`);
  }
  const validUrl = asNonEmptyString(url, `targets[${index}].url`);

  let name: string | undefined;
  if (raw.name !== undefined) {
    name = asNonEmptyString(raw.name, `targets[${index}].name`);
  }

  if (type === "storybook") {
    const target: StorybookTarget = { type, url: validUrl };
    if (name !== undefined) {
      target.name = name;
    }
    if (raw.stories !== undefined) {
      target.stories = asStringArray(raw.stories, `targets[${index}].stories`);
    }
    return target;
  }

  const target: AppTarget = { type, url: validUrl };
  if (name !== undefined) {
    target.name = name;
  }
  if (raw.routes !== undefined) {
    target.routes = asStringArray(raw.routes, `targets[${index}].routes`);
  }
  return target;
}

/** Validate one token source (a bare string path, or a `{ source, format?, mode?, ... }`). */
function parseTokenSource(raw: unknown, label: string, allowJsEval: boolean): TokenSourceObject {
  if (typeof raw === "string") {
    return { source: asNonEmptyString(raw, label), format: "auto" };
  }
  if (!isObject(raw)) {
    fail(`${label} must be a string path or an object with a "source".`);
  }

  const source = asNonEmptyString(raw.source, `${label}.source`);

  let format: TokenFormat | "auto" = "auto";
  if (raw.format !== undefined) {
    if (
      typeof raw.format !== "string" ||
      !TOKEN_FORMATS.includes(raw.format as TokenFormat | "auto")
    ) {
      fail(
        `${label}.format must be one of ${TOKEN_FORMATS.join(", ")} (got ${JSON.stringify(raw.format)}).`,
      );
    }
    format = raw.format as TokenFormat | "auto";
    if (JS_EVAL_FORMATS.includes(format as TokenFormat) && !allowJsEval) {
      fail(
        `${label}.format "${format}" executes project code; set "tokens.allowJsEval": true to use it.`,
      );
    }
  }

  const result: TokenSourceObject = { source, format };
  if (raw.mode !== undefined) {
    result.mode = asNonEmptyString(raw.mode, `${label}.mode`);
  }
  if (raw.rootFontSize !== undefined) {
    result.rootFontSize = asPositiveNumber(raw.rootFontSize, `${label}.rootFontSize`);
  }
  return result;
}

/**
 * Normalize `config.tokens` into a `TokensConfig`. Accepts a bare string path, the legacy
 * `{ source }` form, or the full `{ sources: [...] }` form — all flatten to `{ sources }`,
 * so Phase 0 configs keep working. Extensibility (custom types / custom adapters) is deferred.
 */
function parseTokens(raw: unknown): TokensConfig {
  if (raw === undefined) {
    return { sources: [{ source: DEFAULT_TOKEN_SOURCE, format: "auto" }] };
  }
  if (typeof raw === "string") {
    return { sources: [parseTokenSource(raw, "tokens", false)] };
  }
  if (!isObject(raw)) {
    fail(`"tokens" must be a string path or an object.`);
  }

  const allowJsEval =
    raw.allowJsEval === undefined ? false : asBoolean(raw.allowJsEval, "tokens.allowJsEval");

  if (raw.source !== undefined && raw.sources !== undefined) {
    fail(`"tokens" must not set both "source" and "sources" — use one.`);
  }

  let sources: TokenSourceObject[];
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
      fail(`"tokens.sources" must be a non-empty array.`);
    }
    sources = raw.sources.map((entry, index) =>
      parseTokenSource(entry, `tokens.sources[${index}]`, allowJsEval),
    );
  } else if (raw.source !== undefined) {
    sources = [parseTokenSource(raw.source, "tokens", allowJsEval)]; // legacy { source } form
  } else {
    sources = [{ source: DEFAULT_TOKEN_SOURCE, format: "auto" }];
  }

  const result: TokensConfig = { sources };
  if (raw.ignoreValues !== undefined) {
    result.ignoreValues = asStringArray(raw.ignoreValues, "tokens.ignoreValues");
  }
  if (allowJsEval) {
    result.allowJsEval = true;
  }
  return result;
}

/**
 * Validate a parsed config object and fill defaults. Pure — no I/O. Throws an actionable
 * error that names the offending field on any invalid or missing-required input.
 */
export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) {
    fail(`expected a JSON object, got ${raw === null ? "null" : typeof raw}.`);
  }

  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    fail(`"targets" is required and must be a non-empty array.`);
  }
  const targets = raw.targets.map((target, index) => parseTarget(target, index));

  const detect = raw.detect ?? DEFAULTS.detect;
  if (detect !== "auto") {
    fail(`"detect" must be "auto" (got ${JSON.stringify(detect)}).`);
  }

  const tokens = parseTokens(raw.tokens);

  return {
    detect,
    targets,
    viewports:
      raw.viewports === undefined
        ? [...DEFAULTS.viewports]
        : asPositiveNumberArray(raw.viewports, "viewports"),
    states: raw.states === undefined ? [...DEFAULTS.states] : asStringArray(raw.states, "states"),
    threshold:
      raw.threshold === undefined ? DEFAULTS.threshold : asRatio(raw.threshold, "threshold"),
    maxDiffRatio:
      raw.maxDiffRatio === undefined
        ? DEFAULTS.maxDiffRatio
        : asRatio(raw.maxDiffRatio, "maxDiffRatio"),
    baselineDir:
      raw.baselineDir === undefined
        ? DEFAULTS.baselineDir
        : asNonEmptyString(raw.baselineDir, "baselineDir"),
    uiGlobs:
      raw.uiGlobs === undefined ? [...DEFAULTS.uiGlobs] : asStringArray(raw.uiGlobs, "uiGlobs"),
    tokens,
  };
}

/** Read, JSON-parse, validate, and default a config file. Throws an actionable error. */
export function loadConfig(path: string): Config {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    return fail(`could not read config file at "${path}" (${detailOf(err)}).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    return fail(`config file at "${path}" is not valid JSON (${detailOf(err)}).`);
  }

  return parseConfig(parsed);
}
