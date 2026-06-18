import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./lib/config";
import { resolveTargets, type RenderTarget } from "./lib/targets";

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
  "**/*.global.{css,scss,less}",
  "**/global.{css,scss,less}",
  "**/globals.{css,scss,less}",
  "**/index.css",
  "**/app.css",
  "**/styles.css",
  "**/tailwind.config.{ts,js,cjs,mjs}",
  "**/postcss.config.{ts,js,cjs,mjs}",
  "**/theme.{ts,tsx,js,jsx}",
  "**/package.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
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
}

/**
 * Decide the capture scope. Pure. Returns a {@link ScopeDecision}; the only `mode: "scoped"` path
 * is when EVERY relevant changed file maps cleanly to a known story component and nothing global
 * changed. Everything else widens to `"all"` (the invariant).
 */
export function decideScope(input: DecideInput): ScopeDecision {
  const totalRenders = input.targets.length;
  const make = (
    mode: ScopeMode,
    components: string[],
    reasons: string[],
    changedFiles: string[],
    scopedRenders: number,
  ): ScopeDecision => ({
    version: SCOPE_VERSION,
    mode,
    components,
    storyIds: [],
    reasons,
    changedFiles,
    totalRenders,
    scopedRenders,
  });

  if (input.forceAll) {
    return make("all", [], ["--all requested → full sweep"], input.changedFiles, totalRenders);
  }

  // (Invariant) If we could not even establish the changed set — not a git repo, a bad `--since`
  // ref, git unavailable — an empty OR partial list can't be trusted. Widen to a full sweep BEFORE
  // any narrowing logic, so a successful `git ls-files` (untracked) can't produce a scoped run off
  // a change set that's missing the whole `git diff`.
  if (!input.gitResolved) {
    return make(
      "all",
      [],
      ["could not determine changed files (no git diff / not a git repo / bad base) → full sweep"],
      input.changedFiles,
      totalRenders,
    );
  }

  // Classify by EXCLUSION, not inclusion. A file is "considered" unless it is provably ignorable
  // (docs, tests, editor/CI config, our own artifacts). This is the invariant's backbone: an
  // UNRECOGNIZED changed file must never silently vanish — it stays "considered" and, failing to
  // map cleanly below, forces a full sweep. (A positive include-filter would silently drop anything
  // it didn't recognize — e.g. `Button.less`, `tokens.CSS` — the exact under-capture we guard.)
  // A story-defining or global file is ALWAYS protected from the ignore rule (structural backstop
  // against an over-broad ignorable matching a renderable file, e.g. a `.stories.tsx` under tests).
  const isProtected = (file: string): boolean =>
    matchesAnyGlob(file, STORY_FILE_GLOBS) ||
    isGlobalFile(file, input.globalGlobs, input.tokenGlobs);
  const considered = input.changedFiles.filter(
    (file) => isProtected(file) || !matchesAnyGlob(file, IGNORABLE_GLOBS),
  );

  if (considered.length === 0) {
    return make("none", [], ["no rendering-relevant files changed since base"], [], 0);
  }

  // Any global change (tokens, global CSS, Storybook/build config, a lockfile) can affect every
  // render → full sweep.
  const globalHits = considered.filter((file) =>
    isGlobalFile(file, input.globalGlobs, input.tokenGlobs),
  );
  if (globalHits.length > 0) {
    return make(
      "all",
      [],
      globalHits.map((file) => `global change: ${file} → full sweep`),
      considered,
      totalRenders,
    );
  }

  // Map each considered file to a KNOWN story component. ONLY a UI file (a component's own
  // .tsx/.css) is eligible; any other considered file (a shared .ts, an imported asset, an
  // unrecognized config) is "unmapped" → full sweep, because filename can't prove it affects one
  // component. Component matching is case-insensitive.
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
    return make(
      "all",
      [],
      unmapped.map((file) => `unmapped change: ${file} (couldn't tie it to one story) → full sweep`),
      considered,
      totalRenders,
    );
  }

  const components = [...inScope].sort();
  const scopedRenders = input.targets.filter((target) => inScope.has(target.name)).length;
  return make("scoped", components, reasons, considered, scopedRenders);
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

async function main(argv: string[]): Promise<void> {
  // The default out path matches what /visual-check reads, so even if ARG PARSING itself throws
  // (a mis-quoted `--since <ref>` arriving as one token under zsh) we still leave a conservative
  // decision on disk rather than nothing — never a stale read. parseScopeArgs is INSIDE the try.
  let outPath = join(process.cwd(), ".visual-guard", "scope.json");
  let decision: ScopeDecision;
  try {
    const args = parseScopeArgs(argv, process.cwd());
    outPath = args.out;
    const config = loadConfig(args.config);
    const { files, gitResolved } = collectChangedFiles(args.cwd, args.since);
    const tokenGlobs = config.tokens.sources.map((source) => source.source);
    // resolveTargets needs the dev server / Storybook; if it's down this throws and we fall back to
    // a full sweep below — capture is the authority on server reachability (it probes + errors).
    const targets = await resolveTargets(config);
    decision = decideScope({
      changedFiles: files,
      gitResolved,
      forceAll: args.all,
      uiGlobs: config.uiGlobs,
      tokenGlobs,
      globalGlobs: DEFAULT_GLOBAL_GLOBS,
      targets,
    });
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
