import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./lib/config";
import { resolveTargets, type RenderTarget } from "./lib/targets";
import { buildImportGraph, graphComplete, type ImportGraph } from "./lib/graph/import-graph";
import { createResolver } from "./lib/graph/resolver";
import { loadGraphCache, saveGraphCache, sha1, withCache } from "./lib/graph/cache";
import {
  computeFingerprintsCurrent,
  resolveChromiumRevision,
  resolvePlaywrightVersion,
} from "./lib/fingerprint-emit";
import { FINGERPRINTS_VERSION, type FingerprintsFile } from "./lib/fingerprint-file";

/**
 * Change-scoped capture — the decision engine (Phase 0).
 *
 * Computes which components `/visual-check` needs to capture for the current change, instead of
 * sweeping every story every run. It collects the changed files (git diff + the `pending.json` the
 * PostToolUse hook records), maps them to story components with a filename heuristic, and writes a
 * `.visual-guard/scope.json` the capture step reads.
 *
 * The cardinal invariant (SPEC "honest contract"): NEVER silently skip a render that could have
 * changed. Every uncertain branch returns `mode: "all"` (full sweep): a global change (tokens,
 * global CSS, Storybook config, a lockfile), a changed file the heuristic can't tie to a known
 * story, an un-resolvable git state, or ANY internal error. Scoping only narrows when every
 * changed UI file maps cleanly to a known component. The full sweep is always the source of truth.
 *
 * Pure helpers are unit-tested; `main` (git + fs + a Storybook fetch) runs only when invoked
 * directly and never throws — on any failure it emits a conservative `mode: "all"` decision.
 *
 * Phase-0 honesty: the mapping is a filename heuristic with NO import graph, so it assumes a
 * component's own file (`Button.css`) only affects that component. If that file is imported by
 * ANOTHER component, a scoped run can miss the second one. This is why a scoped pass is reported as
 * "everything in scope passed" (never "all good"), and why CI / `--all` — which captures everything
 * — remains the source of truth and the backstop. Phase 1 replaces the heuristic with a real
 * dependency graph that closes this gap.
 */

const PREFIX = "Visual Guard scope";
const SCOPE_VERSION = 1;

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

// --- Glob matching (minimal; mirrors detect-ui-change.mjs / report.ts) -----

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** Convert a minimal glob (`**`, `*`, `?`, `{a,b}`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += "[^]*";
        i++;
        if (glob[i + 1] === "/") {
          i++;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        continue;
      }
      re += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map(escapeLiteral)
        .join("|")})`;
      i = end;
    } else {
      re += escapeLiteral(ch as string);
    }
  }
  // Case-INSENSITIVE: file CLASSIFICATION (UI / token / global / ignorable) must not be fooled by a
  // casing variant (`tokens.CSS` vs `tokens.css`) on the case-insensitive filesystems this engine
  // targets — a dropped global/token file would silently narrow the run. Component-name mapping is
  // case-folded separately (candidateComponentNames + byLowerName).
  return new RegExp(`^${re}$`, "i");
}

/** Does `file` (a posix project-relative path) match any of the globs (case-insensitively)? */
export function matchesAnyGlob(file: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

// --- Types -----------------------------------------------------------------

export type ScopeMode = "all" | "scoped" | "none";

/** The `.visual-guard/scope.json` artifact the capture step reads. */
export interface ScopeDecision {
  version: number;
  mode: ScopeMode;
  /** Component names in scope (mode === "scoped"); the capture filter matches `RenderTarget.name`. */
  components: string[];
  /** Exact story ids in scope (reserved for the Phase-1 import graph; empty in Phase 0). */
  storyIds: string[];
  /** Human-readable reasons for the decision (always populated; surfaced by the command). */
  reasons: string[];
  /** The UI/token-relevant changed files that drove the decision. */
  changedFiles: string[];
  /** Total renders a full sweep would capture (for the "N of M" scope line). */
  totalRenders: number;
  /** Renders this scoped decision captures (mode === "scoped"; 0 for none, full for all). */
  scopedRenders: number;
}

/**
 * A change to one of these fans out to a FULL sweep — they can affect any render. Token sources
 * (from config) are added on top of this list. Kept deliberately broad: missing a global file and
 * scoping narrowly is the one outcome we must avoid.
 */
export const DEFAULT_GLOBAL_GLOBS = [
  "**/.storybook/**",
  "**/.ladle/**",
  "**/preview.{ts,tsx,js,jsx}",
  "**/manager.{ts,tsx,js,jsx}",
  "**/preview-head.html",
  "**/manager-head.html",
  "**/*.global.{css,scss,less}",
  "**/global.{css,scss,less}",
  "**/globals.{css,scss,less}",
  "**/reset.{css,scss,less}",
  "**/base.{css,scss,less}",
  "**/typography.{css,scss,less}",
  "**/index.css",
  "**/app.css",
  "**/styles.css",
  // Theme / token PROVIDERS are commonly applied globally (a theme provider / token module wraps every
  // story), so a change fans out to a full sweep rather than scoping to importers. Conservative by
  // design: over-capture is always safe; a token recolor that the import graph would scope narrowly is
  // still correctly a full sweep here.
  "**/theme.{ts,tsx,js,jsx}",
  "**/*.theme.{ts,tsx,js,jsx}",
  "**/tokens.{css,scss,less,ts,tsx,js,jsx}",
  "**/designTokens.{ts,tsx,js,jsx}",
  // Build / bundler / tooling config: a Vite `define`, a Babel plugin, a PostCSS plugin, an SVGR option
  // etc. can shift EVERY render. Without these a changed `vite.config.ts` mapped to no story under a
  // complete graph → "affects no story" → captured NOTHING (an under-capture the adversarial audit
  // surfaced). Marking them global closes that hole.
  "**/tailwind.config.{ts,js,cjs,mjs}",
  "**/postcss.config.{ts,js,cjs,mjs}",
  "**/vite.config.{ts,js,cjs,mjs,mts,cts}",
  "**/vitest.config.{ts,js,cjs,mjs}",
  "**/webpack.config.{ts,js,cjs,mjs}",
  "**/rollup.config.{ts,js,cjs,mjs}",
  "**/babel.config.{js,cjs,mjs,json}",
  "**/.babelrc",
  "**/.babelrc.{js,cjs,mjs,json}",
  "**/components.json",
  "**/.npmrc",
  "**/.env",
  "**/.env.*",
  // Dependency manifests + in-place patch state (patch-package / yarn patches): an installed
  // dependency's rendered output can change via a patch without the lockfile moving.
  "**/package.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/patches/**",
  "**/.yarn/patches/**",
  // Static-serve roots (Storybook staticDirs / Vite public): assets served by URL, referenced by no
  // import edge, so a swapped logo/font/background is invisible to the graph — treat as global.
  "**/public/**",
  "**/static/**",
];

/**
 * Provably non-rendering files. A change confined to these contributes NOTHING to the visual run
 * (they can be the difference between "none" and a sweep). Kept deliberately tight: anything NOT on
 * this list is "considered" and — failing to map to one component — forces a full sweep. Being too
 * broad here is the one risk (it could ignore something visual), so only docs, tests, editor/CI
 * config, and our own run artifacts are listed.
 */
export const IGNORABLE_GLOBS = [
  "**/*.{md,mdx,markdown,txt,rst,adoc}",
  "**/LICENSE*",
  "**/CHANGELOG*",
  "**/AUTHORS*",
  "**/.gitignore",
  "**/.gitattributes",
  "**/.editorconfig",
  "**/.eslintrc*",
  "**/eslint.config.*",
  "**/.prettierrc*",
  "**/prettier.config.*",
  "**/.prettierignore",
  "**/*.{test,spec}.{ts,tsx,js,jsx}",
  // Directory ignorables are EXTENSION-QUALIFIED so a broad `<dir>/**` can never swallow a
  // renderable file colocated under them (a story discovered via the live index lives by module,
  // not path — a `.stories.tsx` under `__tests__/` IS rendered). Only obviously non-rendering files
  // under these dirs are ignored; anything else stays "considered" → widens to a full sweep.
  "**/.github/**/*.{yml,yaml,md,json}",
  "**/.gitlab/**/*.{yml,yaml,md,json}",
  "**/__snapshots__/**/*.snap",
  "**/.visual-guard/**",
  "**/.visual-baselines/**",
];

/**
 * Story-defining files. These directly produce renders, so they must NEVER be classified ignorable
 * — even if colocated under an ignorable directory or carrying an ignorable-looking extension
 * (e.g. `Button.stories.mdx` would otherwise match the markdown rule). A structural backstop against
 * any present-or-future ignorable rule being too broad.
 */
export const STORY_FILE_GLOBS = ["**/*.stories.*", "**/*.story.*"];

// --- Pure decision logic ---------------------------------------------------

/**
 * Heuristic candidate component names for a changed file (Phase 0, no import graph). Returns the
 * basename without extension (stripping `.stories`/`.test`/`.spec`) AND the parent directory name —
 * so both `Button/Button.css` and `Button/index.tsx` map to "Button". Matching is later done
 * case-insensitively against the KNOWN story components; an unknown candidate means a conservative
 * full sweep, never a guess.
 */
export function candidateComponentNames(file: string): string[] {
  const parts = toPosix(file)
    .split("/")
    .filter((p) => p.length > 0);
  const base = parts[parts.length - 1] ?? "";
  const noExt = base
    .replace(/\.(stories|story|test|spec)\.[^/.]+$/i, "")
    .replace(/\.[^/.]+$/, "");
  const parent = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  const names = new Set<string>();
  if (noExt.length > 0) {
    names.add(noExt);
  }
  if (parent !== undefined && parent.length > 0) {
    names.add(parent);
  }
  return [...names];
}

/** A change here affects everything → full sweep. (global globs ∪ the project's token sources). */
export function isGlobalFile(file: string, globalGlobs: string[], tokenGlobs: string[]): boolean {
  return matchesAnyGlob(file, globalGlobs) || matchesAnyGlob(file, tokenGlobs);
}

export interface DecideInput {
  /** All changed files (project-relative posix), from git + pending.json, pre-union. */
  changedFiles: string[];
  /**
   * Did we actually determine the changed set? `false` (e.g. not a git repo AND no pending markers)
   * means an EMPTY `changedFiles` can't be trusted as "nothing changed" → conservative full sweep.
   */
  gitResolved: boolean;
  /** `--all` was requested. */
  forceAll: boolean;
  uiGlobs: string[];
  /** Token source paths from config (a change here is global). */
  tokenGlobs: string[];
  globalGlobs: string[];
  /** The resolved render list — supplies the known-component universe and the render counts. */
  targets: RenderTarget[];
  /**
   * Phase-1 import graph (built from story-file roots). When present and `built`, decideScope maps
   * changed files to stories via real imports instead of the filename heuristic. Absent / not built
   * → the Phase-0 heuristic runs (the conservative fallback). Pure: the graph is built by the I/O
   * shell (main) and injected, so decideScope stays unit-testable.
   */
  graph?: ImportGraph;
  /** Fan-out fraction (config `scope.fanoutThreshold`); default {@link FANOUT_THRESHOLD}. */
  fanoutThreshold?: number;
  /** Fan-out min library size (config `scope.fanoutMinStories`); default {@link FANOUT_MIN_STORIES}. */
  fanoutMinStories?: number;
}

/**
 * Decide the capture scope. Pure. Returns a {@link ScopeDecision}; the only `mode: "scoped"` path
 * is when EVERY relevant changed file maps cleanly to a known story component and nothing global
 * changed. Everything else widens to `"all"` (the invariant).
 */
/** Assemble a {@link ScopeDecision}; `storyIds` defaults empty (set only on the Phase-1 scoped path). */
function makeDecision(
  totalRenders: number,
  mode: ScopeMode,
  components: string[],
  reasons: string[],
  changedFiles: string[],
  scopedRenders: number,
  storyIds: string[] = [],
): ScopeDecision {
  return {
    version: SCOPE_VERSION,
    mode,
    components,
    storyIds,
    reasons,
    changedFiles,
    totalRenders,
    scopedRenders,
  };
}

/**
 * Phase-0 mapping (the conservative fallback): filename heuristic. ONLY a UI file maps — to a known
 * component by name; any other considered file is "unmapped" → full sweep, because a filename can't
 * prove it affects one component. Used when there is no import graph (app/ladle-only runs, explicit
 * story lists, no tsconfig, or a failed/over-budget graph build).
 */
function phase0Map(input: DecideInput, considered: string[], totalRenders: number): ScopeDecision {
  const byLowerName = new Map<string, string>();
  for (const target of input.targets) {
    byLowerName.set(target.name.toLowerCase(), target.name);
  }
  const inScope = new Set<string>();
  const reasons: string[] = [];
  const unmapped: string[] = [];
  for (const file of considered) {
    const matched = matchesAnyGlob(file, input.uiGlobs)
      ? candidateComponentNames(file)
          .map((candidate) => byLowerName.get(candidate.toLowerCase()))
          .filter((name): name is string => name !== undefined)
      : [];
    if (matched.length === 0) {
      unmapped.push(file);
    } else {
      for (const name of matched) {
        inScope.add(name);
      }
      reasons.push(`changed: ${file} → ${matched.join(", ")}`);
    }
  }
  if (unmapped.length > 0) {
    return makeDecision(
      totalRenders,
      "all",
      [],
      unmapped.map((file) => `unmapped change: ${file} (couldn't tie it to one story) → full sweep`),
      considered,
      totalRenders,
    );
  }
  const components = [...inScope].sort();
  const scopedRenders = input.targets.filter((target) => inScope.has(target.name)).length;
  return makeDecision(totalRenders, "scoped", components, reasons, considered, scopedRenders);
}

/**
 * Phase 2 — a changed file imported by more than this fraction of all stories is treated as a
 * fan-out barrel (a shared primitive / barrel re-export): scoping to ~the whole library is pointless
 * and noisy, so widen to a full sweep instead. Only applied above a minimum library size, so a tiny
 * library (where one component importing another is trivially a high fraction — the headline
 * cross-import case) still scopes precisely. This can only WIDEN (capture more), so it never
 * threatens the invariant. (Config knob deferred to Phase 3 / `/visual-config`.)
 */
const FANOUT_THRESHOLD = 0.4;
const FANOUT_MIN_STORIES = 8;

/**
 * Phase-1 mapping: real import graph. Maps each considered file to the story FILES whose transitive
 * import closure reaches it (closing Phase-0's cross-import gap — a file imported by N components
 * scopes to all N). A file reaching ZERO stories may contribute "none" ONLY when the graph is
 * provably complete; otherwise it widens to a full sweep (it could sit in an unmapped subtree).
 * A file reaching MOST stories is a fan-out barrel → full sweep (Phase 2). Every graph-incomplete
 * story (an untrustworthy closure) is captured in EVERY scoped run.
 */
function phase1Map(input: DecideInput, considered: string[], totalRenders: number): ScopeDecision {
  const graph = input.graph as ImportGraph;
  const fanoutThreshold = input.fanoutThreshold ?? FANOUT_THRESHOLD;
  const fanoutMinStories = input.fanoutMinStories ?? FANOUT_MIN_STORIES;
  const totalStoryFiles = graph.storyIncomplete.size; // every rooted story is in this map
  const inScopeStoryFiles = new Set<string>(); // lowercased story-file rel-posix
  const reasons: string[] = [];
  for (const file of considered) {
    const stories = graph.fileToStoryFiles.get(file.toLowerCase());
    if (stories !== undefined && stories.size > 0) {
      // Phase 2 fan-out: a barrel/primitive imported by most of a non-trivial library → full sweep,
      // not a huge scoped set. (Widening only — invariant-safe by construction.)
      if (totalStoryFiles >= fanoutMinStories && stories.size / totalStoryFiles > fanoutThreshold) {
        const pct = Math.round((stories.size / totalStoryFiles) * 100);
        return makeDecision(
          totalRenders,
          "all",
          [],
          [...reasons, `fan-out: ${file} reaches ${stories.size}/${totalStoryFiles} stories (${pct}%) → full sweep`],
          considered,
          totalRenders,
        );
      }
      for (const storyFile of stories) {
        inScopeStoryFiles.add(storyFile);
      }
      reasons.push(`changed: ${file} → ${stories.size} story file(s)`);
    } else if (graphComplete(graph)) {
      // Provably affects no story (graph fully resolved) — contributes nothing.
      reasons.push(`changed: ${file} → affects no story (graph complete)`);
    } else {
      // Zero-resolution under an incomplete graph: could be an unmapped subtree → full sweep.
      return makeDecision(
        totalRenders,
        "all",
        [],
        [...reasons, `unmapped change: ${file} (graph incomplete — may be used unmapped) → full sweep`],
        considered,
        totalRenders,
      );
    }
  }

  // Invariant: a story whose import closure isn't fully trustworthy is captured in EVERY scoped run.
  for (const [storyFile, incomplete] of graph.storyIncomplete) {
    if (incomplete) {
      inScopeStoryFiles.add(storyFile);
    }
  }

  // Expand the in-scope story FILES → storyIds + component names via the index data on `targets`.
  const storyIds = new Set<string>();
  const components = new Set<string>();
  for (const target of input.targets) {
    if (
      target.storyId !== undefined &&
      target.storyFile !== undefined &&
      inScopeStoryFiles.has(target.storyFile.toLowerCase())
    ) {
      storyIds.add(target.storyId);
      components.add(target.name);
    }
  }
  if (storyIds.size === 0) {
    return makeDecision(totalRenders, "none", [], ["no story affected since base (import graph)"], [], 0);
  }
  const scopedRenders = input.targets.filter(
    (target) => target.storyId !== undefined && storyIds.has(target.storyId),
  ).length;
  return makeDecision(
    totalRenders,
    "scoped",
    [...components].sort(),
    reasons,
    considered,
    scopedRenders,
    [...storyIds].sort(),
  );
}

export function decideScope(input: DecideInput): ScopeDecision {
  const totalRenders = input.targets.length;

  if (input.forceAll) {
    return makeDecision(totalRenders, "all", [], ["--all requested → full sweep"], input.changedFiles, totalRenders);
  }

  // (Invariant) If we could not even establish the changed set — not a git repo, a bad `--since`
  // ref, git unavailable — an empty OR partial list can't be trusted. Widen to a full sweep BEFORE
  // any narrowing, so a successful `git ls-files` (untracked) can't yield a scoped run off a set
  // that's missing the whole `git diff`.
  if (!input.gitResolved) {
    return makeDecision(
      totalRenders,
      "all",
      [],
      ["could not determine changed files (no git diff / not a git repo / bad base) → full sweep"],
      input.changedFiles,
      totalRenders,
    );
  }

  // Classify by EXCLUSION, not inclusion: a file is "considered" unless it is provably ignorable
  // (docs, tests, editor/CI config, our artifacts). An unrecognized changed file must never silently
  // vanish — it stays "considered" and, failing to map, forces a full sweep. Story-defining + global
  // files are ALWAYS protected from the ignore rule (a `.stories.tsx` under tests, a `tokens.CSS`).
  const isProtected = (file: string): boolean =>
    matchesAnyGlob(file, STORY_FILE_GLOBS) || isGlobalFile(file, input.globalGlobs, input.tokenGlobs);
  const considered = input.changedFiles.filter(
    (file) => isProtected(file) || !matchesAnyGlob(file, IGNORABLE_GLOBS),
  );

  if (considered.length === 0) {
    return makeDecision(totalRenders, "none", [], ["no rendering-relevant files changed since base"], [], 0);
  }

  // Any global change (tokens, global CSS, Storybook/build config, a lockfile) → full sweep.
  const globalHits = considered.filter((file) =>
    isGlobalFile(file, input.globalGlobs, input.tokenGlobs),
  );
  if (globalHits.length > 0) {
    return makeDecision(
      totalRenders,
      "all",
      [],
      globalHits.map((file) => `global change: ${file} → full sweep`),
      considered,
      totalRenders,
    );
  }

  // Phase 1 (import graph) when available + built; otherwise the Phase-0 filename heuristic. Both
  // honor the SAME early exits above; the graph only ever finds MORE stories per file, never fewer,
  // so Phase 1 strictly improves precision without ever under-capturing.
  return input.graph !== undefined && input.graph.built
    ? phase1Map(input, considered, totalRenders)
    : phase0Map(input, considered, totalRenders);
}

/** A one-line, human-readable summary of a decision (the command surfaces this to the user). */
export function summarize(decision: ScopeDecision): string {
  switch (decision.mode) {
    case "none":
      return (
        `${PREFIX}: no UI changes — nothing to check. ` +
        `Run /visual-check --all to sweep all ${decision.totalRenders} renders.`
      );
    case "all": {
      const why = decision.reasons[0] ?? "full sweep";
      return `${PREFIX}: full sweep — ${decision.totalRenders} renders (${why}).`;
    }
    case "scoped": {
      const outOfScope = decision.totalRenders - decision.scopedRenders;
      return (
        `${PREFIX}: scoped — ${decision.components.length} component(s), ` +
        `${decision.scopedRenders} of ${decision.totalRenders} renders ` +
        `(${outOfScope} out of scope). Full sweep: /visual-check --all.`
      );
    }
  }
}

// --- CLI -------------------------------------------------------------------

export interface ScopeArgs {
  config: string;
  cwd: string;
  out: string;
  since?: string;
  all: boolean;
}

/** Parse `--config --cwd --out --since --all`; unknown flags / missing values throw. */
export function parseScopeArgs(argv: string[], defaultCwd: string): ScopeArgs {
  let config = "config/visual.config.json";
  let cwd = defaultCwd;
  let out = "";
  let since: string | undefined;
  let all = false;

  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined) {
      throw new Error(`${PREFIX}: missing value for ${flag}.`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--config":
        config = value(++i, "--config");
        break;
      case "--cwd":
        cwd = value(++i, "--cwd");
        break;
      case "--out":
        out = value(++i, "--out");
        break;
      case "--since":
        since = value(++i, "--since");
        break;
      case "--all":
        all = true;
        break;
      default:
        throw new Error(`${PREFIX}: unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  if (out === "") {
    out = join(cwd, ".visual-guard", "scope.json");
  }
  return { config, cwd, out, since, all };
}

/** Run a git command in `cwd`, returning stdout, or null when git fails (not a repo, bad ref, …). */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Read the PostToolUse hook's pending UI-file markers for a project (best-effort). */
function readPendingFiles(cwd: string): string[] {
  const pendingPath = join(cwd, ".visual-guard", "pending.json");
  try {
    if (!existsSync(pendingPath)) {
      return [];
    }
    const parsed = JSON.parse(readFileSync(pendingPath, "utf8")) as { files?: unknown };
    return Array.isArray(parsed.files)
      ? parsed.files.filter((file): file is string => typeof file === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Collect the union of changed files (project-relative posix). `--relative` keeps git's paths
 * relative to `cwd` (so they match `uiGlobs`/token paths even when the project is a monorepo subdir).
 * `gitResolved` is true iff `git diff` actually ran — so the caller can distinguish "nothing changed"
 * (trustworthy empty) from "couldn't tell" (conservative full sweep).
 */
export function collectChangedFiles(cwd: string, since: string | undefined): {
  files: string[];
  gitResolved: boolean;
} {
  const base = since ?? "HEAD";
  const diff = git(cwd, ["diff", "--name-only", "--relative", base]);
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const gitResolved = diff !== null;

  const set = new Set<string>();
  const add = (out: string | null): void => {
    if (out === null) {
      return;
    }
    for (const line of out.split("\n")) {
      const file = line.trim();
      if (file.length > 0) {
        set.add(toPosix(file));
      }
    }
  };
  add(diff);
  add(untracked);
  for (const file of readPendingFiles(cwd)) {
    set.add(toPosix(file));
  }
  return { files: [...set], gitResolved };
}

/**
 * Build the Phase-1 import graph for a run, or undefined to fall back to the Phase-0 heuristic. The
 * graph is used ONLY when it can cover the ENTIRE render universe with cwd-internal roots, because
 * `graphComplete` only attests to the ROOTED stories' closures: if any target is NOT rooted (Ladle,
 * app routes, explicit story lists — no `storyFile`) or a root escapes cwd (so its keys can never
 * match git `--relative` paths), a zero-resolution change would falsely read as "affects no story"
 * and silently drop that render. So EVERY target must carry a cwd-internal `storyFile`, else we
 * return undefined (full Phase-0 fallback). No tsconfig or any build error → undefined too. Never
 * throws. `readFile` is injectable for tests.
 */
export function buildProjectGraph(
  cwd: string,
  targets: RenderTarget[],
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ImportGraph | undefined {
  if (targets.length === 0) {
    return undefined;
  }
  // Coverage + path-space alignment: EVERY target must be rooted by a cwd-internal posix story file.
  const storyFileSet = new Set<string>();
  for (const target of targets) {
    const file = target.storyFile;
    // Require BOTH a storyId and a cwd-internal storyFile on EVERY target: phase1Map expands story
    // files → storyIds via (storyId, storyFile), so a target missing either can't be graph-modeled
    // and must force the Phase-0 fallback rather than be silently dropped.
    if (
      target.storyId === undefined ||
      file === undefined ||
      file.length === 0 ||
      file.startsWith("/") ||
      file.split("/").includes("..")
    ) {
      return undefined;
    }
    storyFileSet.add(file);
  }
  try {
    const resolver = createResolver(cwd, readFile);
    if (!resolver.tsconfigFound) {
      return undefined; // no tsconfig → can't trust alias resolution → Phase-0 fallback (CS-D2)
    }
    const cwdResolved = resolve(cwd);
    const roots: string[] = [];
    for (const file of storyFileSet) {
      const abs = resolve(cwd, file);
      // Defensive: a root must stay under cwd so its lowercased-rel-posix keys match git paths.
      if (abs !== cwdResolved && !abs.startsWith(cwdResolved + sep)) {
        return undefined;
      }
      roots.push(abs);
    }
    // Persistent cache: reuse unchanged files' edges across runs. The key folds in the resolution
    // options AND a tree fingerprint (the git file list), because an add/delete/rename can shift an
    // extensionless import's resolution WITHOUT changing any importer's content — so the whole cache
    // must drop on a tree change. No git tree → skip the cache and build fresh, never risk staleness.
    const tracked = git(cwd, ["ls-files"]);
    const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
    // `--deleted` lists tracked files removed from the working tree but NOT yet staged — `ls-files`
    // still reports them, so without this an unstaged deletion would leave the tree fingerprint
    // unchanged and the cache could serve a stale edge (defense-in-depth: the missing file would also
    // trip the incompleteness→full-sweep fallback, but we close the blind spot directly).
    const deleted = git(cwd, ["ls-files", "--deleted"]);
    const treeFingerprint =
      tracked !== null && untracked !== null && deleted !== null
        ? sha1(`${tracked}\n${untracked}\n${deleted}`)
        : null;
    if (treeFingerprint === null) {
      return buildImportGraph(cwd, roots, resolver); // uncached
    }
    const cacheKey = `${resolver.optionsHash}:${treeFingerprint}`;
    const cachePath = join(cwd, ".visual-guard", "graph.json");
    const cache = loadGraphCache(cachePath, cacheKey);
    const graph = buildImportGraph(cwd, roots, withCache(resolver, cache, readFile));
    saveGraphCache(cachePath, cacheKey, cache);
    return graph;
  } catch {
    return undefined; // any graph build failure → Phase-0 fallback, never block the run
  }
}

/**
 * Emit the run's CURRENT per-render fingerprints for capture fingerprint-skip (Phase B2c) to
 * `<outDir>/fingerprints-current.json`. BEST-EFFORT and FAIL-CLOSED: any error, an absent/unbuilt
 * graph, or an untrustworthy global set leaves NO file (or no entry for a render) → capture skips
 * nothing. This NEVER affects the scope decision (its own try/catch swallows everything). The global
 * roots are the working-tree files matching the SAME global globs the scope decision uses, so a global
 * change busts every fingerprint exactly as it forces a full scoped sweep.
 */
function writeCurrentFingerprints(
  cwd: string,
  outDir: string,
  targets: RenderTarget[],
  graph: ImportGraph | undefined,
  globalGlobs: string[],
  tokenGlobs: string[],
): void {
  const outPath = join(outDir, "fingerprints-current.json");
  try {
    // Clear any prior run's fingerprints FIRST: "emit nothing on doubt" must mean "leave no file to
    // trust", not "leave the stale one". The path is fixed (not run-scoped), so a leftover from a
    // previous run could otherwise be mistaken for this run's by a future `--fingerprints` wiring.
    rmSync(outPath, { force: true });
    if (graph === undefined || !graph.built) return; // no trustworthy graph → emit nothing → never skip
    const tracked = git(cwd, ["ls-files"]);
    if (tracked === null) return; // not a git repo / git unavailable → can't enumerate globals → never skip
    const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
    const treeFiles = new Set<string>();
    for (const out of [tracked, untracked]) {
      if (out === null) continue;
      for (const line of out.split("\n")) {
        const file = line.trim();
        if (file.length > 0) treeFiles.add(toPosix(file));
      }
    }
    const matchGlobs = [...globalGlobs, ...tokenGlobs];
    const globalRoots = [...treeFiles]
      .filter((file) => matchesAnyGlob(file, matchGlobs))
      .map((file) => resolve(cwd, file));

    const { fps, inputs } = computeFingerprintsCurrent({
      cwd,
      targets,
      storyGraph: graph,
      globalRoots,
      playwrightVersion: resolvePlaywrightVersion(cwd),
      chromiumRevision: resolveChromiumRevision(cwd),
    });

    // Only WRITE when there is something to skip — an empty `fps` map means "skip nothing", which the
    // cleared file (absent) already conveys; this avoids leaving an empty file that reads as "ran".
    if (Object.keys(fps).length === 0) return;
    const file: FingerprintsFile = {
      version: FINGERPRINTS_VERSION,
      renders: Object.fromEntries(Object.entries(fps).map(([key, fp]) => [key, { fp }])),
      inputs, // capture re-hashes these after screenshotting to catch a mid-run source edit (TOCTOU)
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`);
  } catch {
    /* best-effort: a fingerprint failure must never break the run, narrow scope, or cause a wrong skip */
  }
}

async function main(argv: string[]): Promise<void> {
  // The default out path matches what /visual-check reads, so even if ARG PARSING itself throws
  // (a mis-quoted `--since <ref>` arriving as one token under zsh) we still leave a conservative
  // decision on disk rather than nothing — never a stale read. parseScopeArgs is INSIDE the try.
  let outPath = join(process.cwd(), ".visual-guard", "scope.json");
  // Clear any prior run's fingerprints BEFORE doing anything that can throw. writeCurrentFingerprints
  // also clears+rewrites them, but it runs only AFTER resolveTargets/buildProjectGraph/decideScope — so
  // a throw there (e.g. a transient dev-server flake) would otherwise leave a STALE file that capture
  // persists and /visual-baseline records as an approved fp paired with a fresh PNG → a silent wrong
  // skip. Clearing up front makes the emit-nothing-on-doubt contract hold on EVERY failure path.
  const clearStaleFingerprints = (path: string): void => {
    try {
      rmSync(join(dirname(path), "fingerprints-current.json"), { force: true });
    } catch {
      /* best-effort */
    }
  };
  clearStaleFingerprints(outPath);
  let decision: ScopeDecision;
  try {
    const args = parseScopeArgs(argv, process.cwd());
    outPath = args.out;
    clearStaleFingerprints(outPath); // re-clear if --out pointed at a different dir
    const config = loadConfig(args.config);
    const { files, gitResolved } = collectChangedFiles(args.cwd, args.since);
    const tokenGlobs = config.tokens.sources.map((source) => source.source);
    // resolveTargets needs the dev server / Storybook; if it's down this throws and we fall back to
    // a full sweep below — capture is the authority on server reachability (it probes + errors).
    const targets = await resolveTargets(config);
    // Phase 1: build the import graph from story-file roots (undefined → Phase-0 heuristic).
    const graph = buildProjectGraph(args.cwd, targets);
    decision = decideScope({
      changedFiles: files,
      gitResolved,
      forceAll: args.all,
      uiGlobs: config.uiGlobs,
      tokenGlobs,
      // Config `scope.globalGlobs` extends the built-ins (a project-specific global file → full sweep).
      globalGlobs: [...DEFAULT_GLOBAL_GLOBS, ...config.scope.globalGlobs],
      targets,
      graph,
      fanoutThreshold: config.scope.fanoutThreshold,
      fanoutMinStories: config.scope.fanoutMinStories,
    });
    // Emit the run's CURRENT fingerprints (capture fingerprint-skip) alongside scope.json. Best-effort
    // + fail-closed: it never throws out of here and never touches `decision` (a wrong scope is far
    // worse than no skip). Capture only skips when `--skip-unchanged` is passed AND these match the
    // committed approved fingerprints, so a plain run/sweep is unaffected.
    writeCurrentFingerprints(
      args.cwd,
      dirname(outPath),
      targets,
      graph,
      [...DEFAULT_GLOBAL_GLOBS, ...config.scope.globalGlobs],
      tokenGlobs,
    );
  } catch (err) {
    // The invariant under failure: never narrow. Any error → full sweep, capture proceeds normally.
    decision = {
      version: SCOPE_VERSION,
      mode: "all",
      components: [],
      storyIds: [],
      reasons: [`scope computation failed (${detailOf(err)}) → full sweep`],
      changedFiles: [],
      totalRenders: 0,
      scopedRenders: 0,
    };
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(decision, null, 2)}\n`);
  process.stdout.write(`${summarize(decision)}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // Never fail the /visual-check run on a scope hiccup — main already degrades to a full sweep.
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${PREFIX}: ${detailOf(err)}\n`);
    process.exit(0);
  });
}
