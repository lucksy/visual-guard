import { readFileSync } from "node:fs";

export type DetectMode = "auto";

export interface StorybookTarget {
  type: "storybook";
  url: string;
  /** Explicit story ids to render; bypasses discovery when present (see targets.ts). */
  stories?: string[];
}

export interface AppTarget {
  type: "app";
  url: string;
  /** Explicit routes to render; bypasses discovery when present. */
  routes?: string[];
}

export type Target = StorybookTarget | AppTarget;

export interface Config {
  detect: DetectMode;
  targets: Target[];
  viewports: number[];
  states: string[];
  threshold: number;
  maxDiffRatio: number;
  baselineDir: string;
  uiGlobs: string[];
  tokens: { source: string };
}

const DEFAULTS = {
  detect: "auto" as DetectMode,
  viewports: [375, 768, 1280],
  states: ["default", "hover", "disabled"],
  threshold: 0.1,
  maxDiffRatio: 0.01,
  baselineDir: ".visual-baselines",
  uiGlobs: ["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss}"],
  tokens: { source: "src/styles/tokens.css" },
};

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

  if (type === "storybook") {
    const target: StorybookTarget = { type, url: validUrl };
    if (raw.stories !== undefined) {
      target.stories = asStringArray(raw.stories, `targets[${index}].stories`);
    }
    return target;
  }

  const target: AppTarget = { type, url: validUrl };
  if (raw.routes !== undefined) {
    target.routes = asStringArray(raw.routes, `targets[${index}].routes`);
  }
  return target;
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

  let tokens = { ...DEFAULTS.tokens };
  if (raw.tokens !== undefined) {
    if (!isObject(raw.tokens) || typeof raw.tokens.source !== "string") {
      fail(`"tokens.source" must be a string path to the token source.`);
    }
    tokens = { source: raw.tokens.source };
  }

  return {
    detect,
    targets,
    viewports:
      raw.viewports === undefined
        ? [...DEFAULTS.viewports]
        : asPositiveNumberArray(raw.viewports, "viewports"),
    states: raw.states === undefined ? [...DEFAULTS.states] : asStringArray(raw.states, "states"),
    threshold: raw.threshold === undefined ? DEFAULTS.threshold : asRatio(raw.threshold, "threshold"),
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
