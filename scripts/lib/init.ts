import { basename, extname } from "node:path";
import {
  parseConfig,
  type Config,
  type FigmaConfig,
  type StorybookTarget,
  type AppTarget,
  type Target,
  type TokenFormat,
  type TokenSourceObject,
  type TokensConfig,
} from "./config";

/**
 * Scaffolding logic for `/visual-init` (T-24). Pure and side-effect free — no network, no fs —
 * so it is fully unit-testable. The impure shell in `scripts/init.ts` probes ports, scans the
 * cwd for token files, and writes the config; this module decides *what* config to write.
 *
 * A freshly-installed engineer's first `/visual-check` fails against the sample defaults
 * (`localhost:6006` storybook + `localhost:3000` app routes, `src/styles/tokens.css`). This
 * module turns whatever was actually detected on the machine into a minimal valid VisualConfig
 * that `parseConfig` accepts, so that first check "just works".
 */

const PREFIX = "Visual Guard init";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

/**
 * The localhost ports to readiness-probe, in priority order. Storybook's default (6006) is
 * first — it is the most common Visual Guard target — followed by the common app dev-server
 * defaults: 3000 (CRA/Next.js), 5173 (Vite), 8080 (webpack-dev-server/Express), 4321 (Astro).
 */
export function candidatePorts(): number[] {
  return [6006, 3000, 5173, 8080, 4321];
}

/** The default app routes suggested when a reachable origin isn't a Storybook (no auto-discovery). */
export const DEFAULT_APP_ROUTES = ["/"];

/** The fallback template target written when nothing on the machine is reachable. */
export const FALLBACK_STORYBOOK_URL = "http://localhost:6006";

/**
 * The outcome of probing one origin (filled in by the impure shell). `reachable` mirrors the R2
 * semantics from capture.ts: any HTTP response counts as reachable; only a refused/timed-out
 * connection is unreachable. `storyEntryCount` is the number of renderable Storybook entries
 * discovered at `<url>/index.json` (or `/stories.json`) — `undefined` when discovery wasn't run
 * or didn't yield a Storybook index, `0` for an empty (docs-only) Storybook.
 */
export interface ProbeResult {
  url: string;
  reachable: boolean;
  /** Renderable Storybook entries found, or undefined if this isn't a Storybook index. */
  storyEntryCount?: number;
  /** Routes to seed an app target with; defaults to {@link DEFAULT_APP_ROUTES}. */
  routes?: string[];
}

/**
 * Classify a reachable origin into a Visual Guard target. An origin is a **storybook** target
 * when story discovery found a Storybook index (`storyEntryCount` is defined — even `0`, since a
 * docs-only Storybook is still a Storybook); otherwise it is an **app** target seeded with the
 * probe's `routes` (or the default route, since Phase 0 cannot auto-discover app routes). Throws
 * on an unreachable probe — the caller decides what to do with those (template fallback).
 */
export function classifyTarget(probe: ProbeResult): Target {
  if (!probe.reachable) {
    fail(`refusing to classify an unreachable origin ${JSON.stringify(probe.url)}.`);
  }
  if (probe.storyEntryCount !== undefined) {
    const target: StorybookTarget = { type: "storybook", url: probe.url };
    return target;
  }
  const routes = probe.routes && probe.routes.length > 0 ? probe.routes : [...DEFAULT_APP_ROUTES];
  const target: AppTarget = { type: "app", url: probe.url, routes };
  return target;
}

// --- Design-system detection (component-native, for DS teams) ---------------

/**
 * Visual Guard is for **design-system teams**, and a design system is *components* (atomic design:
 * atoms → molecules → organisms), not application pages. The engine captures a component in isolation
 * only through a **story explorer** — Storybook / Ladle / Histoire — because that's what gives every
 * component a URL to visit. So the wizard must steer a DS team toward a harness + the component layer,
 * and treat app *routes* as the app-regression fallback (pages, NOT the design system).
 */

export type HarnessKind = "storybook" | "ladle" | "histoire";

export interface HarnessFacts {
  /** Config dirs/files present in the project (e.g. ".storybook", "ladle.config.ts"). */
  configs?: string[];
  /** Dependency + devDependency names across the project's package.json files. */
  deps?: string[];
}

/**
 * Detect a component story-explorer harness from static project facts (a config dir/file, or a
 * declared dependency). A harness is what makes per-component capture possible (one story = one URL),
 * so it is the **design-system-native** capture target. Returns the kind, or null when none is present.
 */
export function detectHarness(facts: HarnessFacts): HarnessKind | null {
  const configs = (facts.configs ?? []).map((c) => c.toLowerCase());
  const deps = new Set(facts.deps ?? []);
  const hasDep = (pred: (d: string) => boolean) => [...deps].some(pred);
  const hasConfig = (pred: (c: string) => boolean) => configs.some(pred);

  if (
    hasConfig((c) => c.endsWith(".storybook") || c.includes(".storybook/") || c.startsWith("storybook.config")) ||
    hasDep((d) => d === "storybook" || d.startsWith("@storybook/"))
  ) {
    return "storybook";
  }
  if (hasConfig((c) => c.endsWith(".ladle") || c.includes(".ladle/") || c.startsWith("ladle.config")) ||
    hasDep((d) => d === "@ladle/react")) {
    return "ladle";
  }
  if (hasConfig((c) => c.startsWith("histoire.config")) ||
    hasDep((d) => d === "histoire" || d.startsWith("@histoire/"))) {
    return "histoire";
  }
  return null;
}

export interface ComponentDir {
  /** Project-relative POSIX path of a candidate component directory. */
  path: string;
  /** Count of UI component files (.tsx/.jsx/.vue/.svelte) in its subtree. */
  fileCount: number;
}

export interface ComponentLibrary {
  /** The most populated component directory — the project's design-system layer. */
  dir: string;
  fileCount: number;
  /** True when atomic-design subfolders (atoms/molecules/organisms) were seen. */
  atomic: boolean;
}

/**
 * Pick the project's component library from candidate component dirs: the most populated one, breaking
 * ties toward a `…/components/ui` then `…/components` path, then alphabetically. Returns null when no
 * candidate holds any component files — i.e. there is no design-system layer in code to review.
 */
export function detectComponentLibrary(
  dirs: ComponentDir[],
  atomic = false,
): ComponentLibrary | null {
  const score = (p: string) => (/components\/ui$/i.test(p) ? 2 : /components$/i.test(p) ? 1 : 0);
  const best = dirs
    .filter((d) => d.fileCount > 0)
    .sort(
      (a, b) => b.fileCount - a.fileCount || score(b.path) - score(a.path) || a.path.localeCompare(b.path),
    )[0];
  if (best === undefined) {
    return null;
  }
  return { dir: best.path, fileCount: best.fileCount, atomic };
}

export type ProjectKind = "harness" | "component-library" | "app" | "empty";

/**
 * Classify the project to drive the wizard's flow:
 *  - **harness** — a story explorer is present (static config/dep) OR a reachable Storybook was probed
 *    → capture components (the design-system path); never ask about routes.
 *  - **component-library** — a component library exists in code but there's NO harness → the "design
 *    system, but no story explorer" branch (guide the user to a harness; routes ≠ their design system).
 *  - **app** — no harness, no component library, but a reachable app → routes (app *pages*).
 *  - **empty** — nothing detected → a sensible template.
 */
export function classifyProjectKind(opts: {
  harness: HarnessKind | null;
  reachableStorybook: boolean;
  componentLibrary: ComponentLibrary | null;
  reachableApp: boolean;
}): ProjectKind {
  if (opts.harness !== null || opts.reachableStorybook) {
    return "harness";
  }
  if (opts.componentLibrary !== null) {
    return "component-library";
  }
  if (opts.reachableApp) {
    return "app";
  }
  return "empty";
}

// --- Token-source detection ------------------------------------------------

/**
 * Map a file path to its token {@link TokenFormat} by extension alone — deterministic and
 * conservative (no content sniffing here; `parseConfig` keeps `format: "auto"` for the engine's
 * own content-aware detection when we can't be certain). Mirrors the extension precedence in
 * `scripts/lib/token-adapters/index.ts`:
 *   .css → css · .scss/.sass → scss · .less → less · .tokens/.tokens.json → dtcg.
 * `.json` is left to `auto` (DTCG vs Style-Dictionary vs Tokens-Studio can't be told apart by
 * extension), and the JS-eval formats (tailwind-config / js-theme) are never auto-selected — they
 * require opt-in (`tokens.allowJsEval`) and an explicit format. Returns null when unknown.
 */
function formatForPath(path: string): TokenFormat | "auto" | null {
  const lower = path.toLowerCase();
  // `.tokens.json` and `.tokens` are the DTCG community convention — match before bare `.json`.
  if (lower.endsWith(".tokens.json") || lower.endsWith(".tokens")) {
    return "dtcg";
  }
  const ext = extname(lower);
  switch (ext) {
    case ".css":
      return "css";
    case ".scss":
    case ".sass":
      return "scss";
    case ".less":
      return "less";
    case ".json":
      // DTCG / Style-Dictionary / Tokens-Studio share `.json`; defer to content auto-detection.
      return "auto";
    default:
      return null;
  }
}

/**
 * Prefer the most token-like file when several candidates exist: a path whose basename contains
 * "token" sorts first, then by the format-priority order, then alphabetically — so a deterministic
 * single source is chosen for the scaffold (the user can add more by hand).
 */
const FORMAT_RANK: Record<TokenFormat | "auto", number> = {
  css: 0,
  tailwind: 1,
  scss: 2,
  less: 3,
  dtcg: 4,
  "style-dictionary": 5,
  "tokens-studio": 6,
  "tailwind-config": 7,
  "js-theme": 8,
  auto: 9,
};

function looksLikeTokenFile(path: string): boolean {
  return /token/i.test(basename(path));
}

/**
 * Turn a list of on-disk token-file candidates into a {@link TokensConfig}, deterministically.
 * Each recognized path maps to a `{ source, format }`; unknown extensions are dropped. The result
 * is ordered: token-named files first, then by format priority, then alphabetically — so the same
 * inputs always yield the same config. Returns `undefined` when nothing is recognized, so the
 * caller can omit `tokens` entirely and let `parseConfig` fall back to its default source.
 */
export function detectTokenSources(filePaths: string[]): TokensConfig | undefined {
  const recognized: { source: TokenSourceObject; rank: number; named: boolean }[] = [];
  for (const path of filePaths) {
    const format = formatForPath(path);
    if (format === null) {
      continue;
    }
    recognized.push({
      source: { source: path, format },
      rank: FORMAT_RANK[format],
      named: looksLikeTokenFile(path),
    });
  }
  if (recognized.length === 0) {
    return undefined;
  }
  recognized.sort((a, b) => {
    if (a.named !== b.named) {
      return a.named ? -1 : 1; // token-named files first
    }
    if (a.rank !== b.rank) {
      return a.rank - b.rank; // then by format priority
    }
    return a.source.source.localeCompare(b.source.source); // then stable alphabetical
  });
  return { sources: recognized.map((entry) => entry.source) };
}

// --- Config assembly -------------------------------------------------------

export interface ScaffoldInput {
  /** Targets to write (Storybook/app); must be non-empty (the one required config field). */
  targets: Target[];
  /** Detected token sources; omitted → `parseConfig` defaults to `src/styles/tokens.css`. */
  tokenSources?: TokensConfig;
  /** Optional Figma linkage from the wizard's "Design system (Figma)" step; omitted → code-only. */
  figma?: FigmaConfig;
}

/**
 * Build a complete, valid {@link Config} from detected targets + token sources. Only `targets`
 * (and optionally `tokens`) are written; every other field is left to `parseConfig` so the
 * repo's hardcoded DEFAULTS (viewports, states, threshold, maxDiffRatio, baselineDir, uiGlobs)
 * are the single source of truth. Validates by round-tripping through `parseConfig` — so a
 * scaffold can never be written that the engine would later reject.
 */
export function buildScaffoldConfig(input: ScaffoldInput): Config {
  if (input.targets.length === 0) {
    fail(`"targets" is required — at least one storybook or app target must be scaffolded.`);
  }
  const raw: Record<string, unknown> = { targets: input.targets };
  if (input.tokenSources !== undefined) {
    raw.tokens = input.tokenSources;
  }
  if (input.figma !== undefined) {
    raw.figma = input.figma;
  }
  return parseConfig(raw);
}

/**
 * The minimal config object to serialize for a scaffold: just the `targets` and (when provided)
 * `tokens`. Everything else is intentionally omitted so the file stays small and the engine's
 * DEFAULTS apply — `parseConfig` fills them at load time. The fields are taken from the **validated,
 * normalized** {@link buildScaffoldConfig} output (not the raw input), so unknown/extra keys are
 * stripped and the bytes written are exactly what `parseConfig` accepted.
 */
export function scaffoldConfigObject(input: ScaffoldInput): {
  targets: Target[];
  tokens?: TokensConfig;
  figma?: FigmaConfig;
} {
  const validated = buildScaffoldConfig(input); // throws on an invalid scaffold; normalizes the rest
  const obj: { targets: Target[]; tokens?: TokensConfig; figma?: FigmaConfig } = {
    targets: validated.targets,
  };
  if (input.tokenSources !== undefined) {
    obj.tokens = validated.tokens; // the normalized token config, only when the caller provided one
  }
  if (input.figma !== undefined) {
    obj.figma = validated.figma; // the normalized figma config (keys extracted), only when provided
  }
  return obj;
}
