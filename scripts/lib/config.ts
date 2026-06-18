import { readFileSync } from "node:fs";
import { extractFigmaFileKey } from "./figma/url";

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

/**
 * A Ladle story explorer (the React harness Visual Guard can scaffold when a project has components but
 * no story explorer). Like {@link StorybookTarget} but Ladle exposes its manifest at `/meta.json` and
 * previews at `/?story=<id>&mode=preview` (see targets.ts). `managed: true` marks a Visual-Guard-scaffolded
 * harness whose dev server `/visual-check` starts and stops around capture (it isn't expected to be
 * already running).
 */
export interface LadleTarget {
  type: "ladle";
  url: string;
  /** Instance label for the output/baseline path; defaults to the URL host:port (targets.ts). */
  name?: string;
  /** Explicit story ids to render; bypasses discovery when present (see targets.ts). */
  stories?: string[];
  /** When true, /visual-check starts/stops this harness's dev server around capture (VG-scaffolded). */
  managed?: boolean;
}

export type Target = StorybookTarget | AppTarget | LadleTarget;

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

export interface FigmaFile {
  /** Non-secret Figma file key (committed in config; identifies one library file). */
  key: string;
  /** Optional human label, surfaced as the gallery's per-library filter. */
  label?: string;
}

/**
 * Additive Figma linkage (D10/D11). Absent → today's code-only behavior, byte-for-byte. There is
 * **no token here**: Figma is read through the Figma desktop MCP, so nothing secret is stored —
 * only the non-secret file key(s) and an optional name-mapping.
 */
export interface FigmaConfig {
  /** One or more Figma library files. A bare key string / `{ fileKey }` normalizes to one entry. */
  files: FigmaFile[];
  /** Optional Figma-name → code-name overrides for component matching (D7). */
  componentMap?: Record<string, string>;
}

/**
 * Component Studio retention/maintenance knobs (P5). Bounds DB + blob-cache growth for active design
 * systems. **Committed baseline PNGs are never affected** — only gitignored history rows / cache blobs.
 * Always present on `Config` (defaulted), so callers don't branch on its absence.
 */
export interface StudioConfig {
  /** Keep at most this many snapshots per (component, variant, source) lane (default 20). */
  retainPerSource: number;
  /** Keep at most this many `current` (live, unapproved) renders per lane (default 3). */
  retainCurrent: number;
  /** Sweep unreferenced `cache/blobs/*.png` during prune (default true). */
  pruneOrphanBlobs: boolean;
}

/**
 * Change-scoped capture knobs (Phase 3). Always present on `Config` (defaulted), so callers never
 * branch on absence. `globalGlobs` is merged with the engine's built-in global patterns — a change
 * to one forces a full sweep (use it to mark a project-specific global file, e.g. a theme provider
 * applied via a Storybook decorator that no story closure reaches).
 */
export interface ScopeConfig {
  /** Fraction of stories above which a changed file is a fan-out barrel → full sweep (0..1, default 0.4). */
  fanoutThreshold: number;
  /** Minimum library size (story count) before fan-out applies (default 8 — tiny libs always scope precisely). */
  fanoutMinStories: number;
  /** Extra "global" globs merged with the engine defaults; a change matching one forces a full sweep. */
  globalGlobs: string[];
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
  /** Optional design-system (Figma) linkage; absent = code-only mode. */
  figma?: FigmaConfig;
  /** Studio retention knobs (always defaulted). */
  studio: StudioConfig;
  /** Change-scoped capture knobs (always defaulted). */
  scope: ScopeConfig;
  /**
   * Capture-pool worker count. Absent → auto (cores-based). Raise it for large design systems to
   * capture more renders in parallel; the engine clamps it to the number of renders in a run.
   */
  concurrency?: number;
}

const DEFAULTS = {
  detect: "auto" as DetectMode,
  viewports: [375, 768, 1280],
  states: ["default", "hover", "disabled"],
  threshold: 0.1,
  maxDiffRatio: 0.01,
  baselineDir: ".visual-baselines",
  uiGlobs: ["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss,sass,less,styl,pcss}"],
};

const STUDIO_DEFAULTS: StudioConfig = {
  retainPerSource: 20,
  retainCurrent: 3,
  pruneOrphanBlobs: true,
};

const SCOPE_DEFAULTS: ScopeConfig = {
  fanoutThreshold: 0.4,
  fanoutMinStories: 8,
  globalGlobs: [],
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
  if (type !== "storybook" && type !== "app" && type !== "ladle") {
    fail(
      `targets[${index}].type must be "storybook", "app", or "ladle" (got ${JSON.stringify(type)}).`,
    );
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

  if (type === "ladle") {
    const target: LadleTarget = { type, url: validUrl };
    if (name !== undefined) {
      target.name = name;
    }
    if (raw.stories !== undefined) {
      target.stories = asStringArray(raw.stories, `targets[${index}].stories`);
    }
    if (raw.managed !== undefined) {
      target.managed = asBoolean(raw.managed, `targets[${index}].managed`);
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
 * Normalize a pasted Figma reference into a stored file **key**: a full Figma URL is reduced to its
 * key, and a bare value must itself be a valid key. `extractFigmaFileKey` returns a shape-valid key
 * (base62, 16–128) or null for *both* forms, so arbitrary input is **never** trusted verbatim — a
 * typo or a hostile string (e.g. `../../etc/passwd`) can't become the stored key, which SPEC §7/§11
 * later use as a filesystem path segment and a Figma deep-link href. Fails naming the field.
 */
function normalizeFigmaKey(value: unknown, field: string): string {
  const str = asNonEmptyString(value, field).trim();
  if (str.length === 0) {
    fail(`"${field}" must be a non-empty string.`);
  }
  const key = extractFigmaFileKey(str);
  if (key !== null) {
    return key;
  }
  if (/figma\.(?:com|site)\//i.test(str)) {
    fail(`"${field}" looks like a Figma URL but no valid file key could be extracted from it.`);
  }
  fail(`"${field}" must be a Figma file URL or a bare file key (base62, 16–128 chars).`);
}

/** Validate one Figma file entry: a bare key/URL string, or `{ key, label? }`. */
function parseFigmaFile(raw: unknown, label: string): FigmaFile {
  if (typeof raw === "string") {
    return { key: normalizeFigmaKey(raw, label) };
  }
  if (!isObject(raw)) {
    fail(`${label} must be a string key/URL or an object with a "key".`);
  }
  const file: FigmaFile = { key: normalizeFigmaKey(raw.key, `${label}.key`) };
  if (raw.label !== undefined) {
    file.label = asNonEmptyString(raw.label, `${label}.label`);
  }
  return file;
}

/** Validate the optional Figma→code name override map (every value a non-empty string). */
function parseComponentMap(raw: unknown): Record<string, string> {
  if (!isObject(raw)) {
    fail(`"figma.componentMap" must be an object mapping Figma names to code names.`);
  }
  const map: Record<string, string> = {};
  for (const [from, to] of Object.entries(raw)) {
    if (from.length === 0) {
      fail(`"figma.componentMap" keys must be non-empty strings.`);
    }
    if (typeof to !== "string" || to.length === 0) {
      fail(`"figma.componentMap.${from}" must be a non-empty string.`);
    }
    map[from] = to;
  }
  return map;
}

/**
 * Normalize `config.figma` into a {@link FigmaConfig} (mirrors {@link parseTokens}). Accepts a bare
 * file-key/URL string, a single-file `{ fileKey }` shorthand, or the full `{ files: [...] }` form.
 * Absent → `undefined`, so a config with no `figma` keeps today's code-only behavior byte-for-byte.
 * **No token is ever read or written** — Figma access is via the MCP.
 */
export function parseFigma(raw: unknown): FigmaConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "string") {
    return { files: [parseFigmaFile(raw, "figma")] };
  }
  if (!isObject(raw)) {
    fail(`"figma" must be a string file key/URL or an object.`);
  }

  if (raw.fileKey !== undefined && raw.files !== undefined) {
    fail(`"figma" must not set both "fileKey" and "files" — use one.`);
  }

  let files: FigmaFile[];
  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files) || raw.files.length === 0) {
      fail(`"figma.files" must be a non-empty array.`);
    }
    files = raw.files.map((entry, index) => parseFigmaFile(entry, `figma.files[${index}]`));
  } else if (raw.fileKey !== undefined) {
    files = [parseFigmaFile(raw.fileKey, "figma.fileKey")];
  } else {
    fail(`"figma" must set "files" (or a single "fileKey").`);
  }

  const result: FigmaConfig = { files };
  if (raw.componentMap !== undefined) {
    result.componentMap = parseComponentMap(raw.componentMap);
  }
  return result;
}

function asPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`"${field}" must be a positive integer (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/**
 * Normalize `config.studio` into a {@link StudioConfig}, field-by-field defaulted (mirrors the additive
 * pattern of {@link parseFigma}). Absent → all defaults, so a config with no `studio` block behaves
 * exactly as before. Each present field is validated; unknown extras are ignored.
 */
export function parseStudio(raw: unknown): StudioConfig {
  if (raw === undefined) {
    return { ...STUDIO_DEFAULTS };
  }
  if (!isObject(raw)) {
    fail(`"studio" must be an object.`);
  }
  return {
    retainPerSource:
      raw.retainPerSource === undefined
        ? STUDIO_DEFAULTS.retainPerSource
        : asPositiveInteger(raw.retainPerSource, "studio.retainPerSource"),
    retainCurrent:
      raw.retainCurrent === undefined
        ? STUDIO_DEFAULTS.retainCurrent
        : asPositiveInteger(raw.retainCurrent, "studio.retainCurrent"),
    pruneOrphanBlobs:
      raw.pruneOrphanBlobs === undefined
        ? STUDIO_DEFAULTS.pruneOrphanBlobs
        : asBoolean(raw.pruneOrphanBlobs, "studio.pruneOrphanBlobs"),
  };
}

/**
 * Normalize `config.scope` into a {@link ScopeConfig}, field-by-field defaulted (additive — absent
 * → all defaults, so today's behavior is unchanged). Each present field is validated; unknown extras
 * are ignored.
 */
export function parseScope(raw: unknown): ScopeConfig {
  if (raw === undefined) {
    return { ...SCOPE_DEFAULTS };
  }
  if (!isObject(raw)) {
    fail(`"scope" must be an object.`);
  }
  return {
    fanoutThreshold:
      raw.fanoutThreshold === undefined
        ? SCOPE_DEFAULTS.fanoutThreshold
        : asRatio(raw.fanoutThreshold, "scope.fanoutThreshold"),
    fanoutMinStories:
      raw.fanoutMinStories === undefined
        ? SCOPE_DEFAULTS.fanoutMinStories
        : asPositiveInteger(raw.fanoutMinStories, "scope.fanoutMinStories"),
    globalGlobs:
      raw.globalGlobs === undefined
        ? []
        : asStringArray(raw.globalGlobs, "scope.globalGlobs"),
  };
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
  const figma = parseFigma(raw.figma);
  const studio = parseStudio(raw.studio);
  const scope = parseScope(raw.scope);
  const concurrency =
    raw.concurrency === undefined ? undefined : asPositiveInteger(raw.concurrency, "concurrency");

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
    // Only attach `figma` when present, so a config without it stays byte-identical to before (D10).
    ...(figma !== undefined ? { figma } : {}),
    studio,
    scope,
    // Likewise additive: absent `concurrency` keeps the config shape unchanged (engine auto-sizes).
    ...(concurrency !== undefined ? { concurrency } : {}),
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
