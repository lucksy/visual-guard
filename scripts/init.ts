import { existsSync, mkdirSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildScaffoldConfig,
  candidatePorts,
  classifyTarget,
  detectTokenSources,
  scaffoldConfigObject,
  type ProbeResult,
} from "./lib/init";
import type { Target, TokensConfig } from "./lib/config";

/**
 * `/visual-init` CLI (T-24): the impure shell around `scripts/lib/init.ts`. It probes the common
 * localhost dev-server / Storybook ports using the SAME technique the capture engine uses (a
 * global `fetch` with an `AbortController` timeout; any HTTP response = reachable, only a refused
 * connection fails), classifies each reachable origin, scans the project for design-token files,
 * then assembles a minimal valid `visual.config.json` and writes it to the project root.
 *
 * Safety mirrors `baseline.ts`: it NEVER clobbers an existing config without `--force`, supports
 * `--dry-run` to preview without touching disk, and never crashes on an unreachable network — if
 * nothing answers it still scaffolds a sensible template (a Storybook target) and warns the user.
 */

const PREFIX = "Visual Guard init";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

// --- Reachability + Storybook discovery (impure; mirrors capture.ts / targets.ts) -----------

/**
 * Probe one origin with the engine's R2 semantics: any HTTP response means it is up; only a
 * refused/timed-out connection is unreachable. Unlike capture.ts's probe, an `AbortController`
 * timeout is added so an init scan never hangs on a slow/half-open port. If the origin answers,
 * try Storybook discovery (`/index.json` then `/stories.json`) to get a renderable story count.
 */
async function probePort(port: number, timeoutMs: number): Promise<ProbeResult> {
  const url = `http://localhost:${port}`;
  const reachable = await isReachable(url, timeoutMs);
  if (!reachable) {
    return { url, reachable: false };
  }
  const storyEntryCount = await discoverStoryCount(url, timeoutMs);
  const result: ProbeResult = { url, reachable: true };
  if (storyEntryCount !== undefined) {
    result.storyEntryCount = storyEntryCount;
  }
  return result;
}

/** Any HTTP response = reachable; a thrown fetch (ECONNREFUSED / abort) = unreachable. */
async function isReachable(origin: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(origin, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Count renderable Storybook entries at `<base>/index.json` (Storybook >= 7's `entries` shape),
 * falling back to `/stories.json`. `docs` entries aren't renders and are filtered out. Returns the
 * count (>= 0) when a Storybook index is found, or `undefined` when neither endpoint yields one —
 * which the classifier reads as "this is a plain app, not a Storybook".
 */
async function discoverStoryCount(base: string, timeoutMs: number): Promise<number | undefined> {
  for (const path of ["/index.json", "/stories.json"]) {
    const payload = await fetchJson(`${base}${path}`, timeoutMs);
    if (payload === null) {
      continue;
    }
    const count = countEntries(payload);
    if (count !== undefined) {
      return count;
    }
  }
  return undefined;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Renderable stories in a Storybook index — both the SB >= 7 `entries` shape and the legacy SB6
 * `/stories.json` `stories` shape (`docs` entries filtered out); `undefined` if the payload is
 * neither. Recognizing SB6 here (even though the capture engine rejects it) keeps a reachable SB6
 * origin classified as a *storybook*, so capture surfaces the canonical "upgrade Storybook" error
 * rather than mislabeling it as an app.
 */
function countEntries(payload: unknown): number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const index = isRecord(payload.entries)
    ? payload.entries
    : isRecord(payload.stories)
      ? payload.stories
      : undefined;
  if (index === undefined) {
    return undefined;
  }
  let count = 0;
  for (const value of Object.values(index)) {
    if (isRecord(value) && value.type === "docs") {
      continue;
    }
    count += 1;
  }
  return count;
}

// --- Token-file scan (impure; bounded recursive walk of the project) ------------------------

// `.tokens.json` is matched here via `.json` and then reclassified to dtcg by formatForPath — keep
// `.json` in this list so the compound DTCG suffix keeps being surfaced by the scan.
const TOKEN_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".json", ".tokens"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".visual-guard",
  ".visual-baselines",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "out",
]);

/**
 * Recursively list candidate token files under `root` (POSIX-relative paths), skipping heavy /
 * generated directories and symlinks (so a broken link / cycle can't crash the scan). Bounded by
 * `maxDepth` so a deep tree never blows up init. Mirrors `compare.ts` `walkPngFiles`: lstat-based,
 * never throws on an unreadable entry. The caller hands the result to `detectTokenSources`.
 */
export function scanTokenFiles(root: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const walk = (current: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      // Heavy/generated dirs and any dotfile/dotdir are never token sources — drop them up front.
      // (Dot-prefixed token files like `.theme.css` are intentionally not auto-detected.)
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
        continue;
      }
      const full = join(current, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth >= maxDepth) {
          continue;
        }
        walk(full, depth + 1);
      } else if (stat.isFile() && TOKEN_EXTENSIONS.some((ext) => entry.toLowerCase().endsWith(ext))) {
        found.push(toPosix(relative(root, full)));
      }
    }
  };
  walk(root, 0);
  return found.sort();
}

const toPosix = (path: string): string => path.split(sep).join("/");

// --- Detection orchestration (impure I/O around the pure lib) -------------------------------

export interface DetectionResult {
  /** Probe outcome per candidate port (reachable + Storybook story count when applicable). */
  probes: ProbeResult[];
  /** The reachable probes that became config targets. */
  targets: Target[];
  /** Detected token sources, or undefined when none were recognized (engine default applies). */
  tokenSources?: TokensConfig;
  /** True when nothing was reachable and a fallback template target was used. */
  usedFallback: boolean;
  /** Token-file candidates the scan surfaced (for the preview), recognized or not. */
  tokenCandidates: string[];
}

/** Probe every candidate port, classify the reachable ones, and scan for token files. */
export async function detectProject(cwd: string, timeoutMs: number): Promise<DetectionResult> {
  const probes: ProbeResult[] = [];
  for (const port of candidatePorts()) {
    probes.push(await probePort(port, timeoutMs));
  }

  const targets: Target[] = [];
  for (const probe of probes) {
    if (probe.reachable) {
      targets.push(classifyTarget(probe));
    }
  }

  const usedFallback = targets.length === 0;
  if (usedFallback) {
    // Nothing answered — scaffold a sensible template so the file is still valid and editable.
    targets.push({ type: "storybook", url: "http://localhost:6006" });
  }

  const tokenCandidates = scanTokenFiles(cwd);
  const tokenSources = detectTokenSources(tokenCandidates);

  const result: DetectionResult = { probes, targets, usedFallback, tokenCandidates };
  if (tokenSources !== undefined) {
    result.tokenSources = tokenSources;
  }
  return result;
}

// --- Config discovery + safe write ----------------------------------------------------------

/** The config paths init considers "already present" — never clobbered without `--force`. */
export function existingConfigPath(cwd: string): string | null {
  for (const rel of ["visual.config.json", join("config", "visual.config.json")]) {
    const abs = join(cwd, rel);
    if (existsSync(abs)) {
      return abs;
    }
  }
  return null;
}

/**
 * The config a write to `configPath` would clobber: the destination itself when it already exists,
 * otherwise any config already present in the discovery precedence (`visual.config.json` /
 * `config/visual.config.json`). Either one blocks the write without `--force` — so a custom
 * `--config <path>` pointed at an existing file can never be silently overwritten.
 */
export function blockingConfigPath(cwd: string, configPath: string): string | null {
  const dest = resolve(configPath);
  if (existsSync(dest)) {
    return dest;
  }
  return existingConfigPath(cwd);
}

/** Hard guard: the destination must resolve inside the project root, never outside it. */
function assertUnder(childAbs: string, parentAbs: string): void {
  const child = resolve(childAbs);
  const parent = resolve(parentAbs);
  if (child !== parent && !child.startsWith(parent + sep)) {
    fail(`refusing to write ${childAbs} outside the project root ${parentAbs}.`);
  }
}

export interface InitOptions {
  cwd?: string;
  /** Explicit output path; defaults to `<cwd>/visual.config.json`. */
  configPath?: string;
  force?: boolean;
  dryRun?: boolean;
  /** Per-port probe timeout in ms; defaults to 5000. */
  timeoutMs?: number;
  /** Injection seam (tests): the project detector; defaults to {@link detectProject}. */
  detect?: (cwd: string, timeoutMs: number) => Promise<DetectionResult>;
}

export interface InitResult {
  detection: DetectionResult;
  /** The config object that was (or would be) written. */
  config: { targets: Target[]; tokens?: TokensConfig };
  /** Absolute path written (or that would be written). */
  configPath: string;
  /** An existing config that blocked the write (when not --force and not --dry-run). */
  existingPath: string | null;
  written: boolean;
  dryRun: boolean;
}

/**
 * Detect the project, assemble the scaffold, and (unless dry-run / blocked) write it. Writing is
 * gated: an existing `visual.config.json` (or `config/visual.config.json`) is never overwritten
 * without `--force`. Returns a structured result so the command can preview what was detected and
 * what (would have) happened.
 */
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? join(cwd, "visual.config.json");
  const timeoutMs = options.timeoutMs ?? 5000;

  const detect = options.detect ?? detectProject;
  const detection = await detect(cwd, timeoutMs);
  const config = scaffoldConfigObject({
    targets: detection.targets,
    tokenSources: detection.tokenSources,
  });

  // Gate on the ACTUAL destination (not just the default locations): a custom --config that
  // points at an existing file must be protected by --force too.
  const existingPath = blockingConfigPath(cwd, configPath);

  if (options.dryRun) {
    return { detection, config, configPath, existingPath, written: false, dryRun: true };
  }

  // Never clobber a config the user already has without an explicit --force.
  if (existingPath !== null && !options.force) {
    return { detection, config, configPath, existingPath, written: false, dryRun: false };
  }

  assertUnder(configPath, cwd);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { detection, config, configPath, existingPath, written: true, dryRun: false };
}

// --- CLI ------------------------------------------------------------------------------------

export interface InitCliArgs {
  configPath?: string;
  force: boolean;
  dryRun: boolean;
}

/** Parse `--config <path> --force --dry-run`; unknown flags / missing values throw (baseline.ts idiom). */
export function parseArgs(argv: string[]): InitCliArgs {
  let configPath: string | undefined;
  let force = false;
  let dryRun = false;

  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined) {
      fail(`missing value for ${flag}.`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--config":
        configPath = value(++i, "--config");
        break;
      case "--force":
        force = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  return { configPath, force, dryRun };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const result = await runInit({
    configPath: args.configPath,
    force: args.force,
    dryRun: args.dryRun,
  });
  // Validate the final shape one more time (defense in depth) before we claim success.
  buildScaffoldConfig({ targets: result.config.targets, tokenSources: result.config.tokens });
  // Machine-readable so the /visual-init command can preview detection + the write decision.
  console.log(JSON.stringify(result));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
