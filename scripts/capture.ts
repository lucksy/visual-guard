import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { loadConfig, type Config } from "./lib/config";
import {
  renderRelPath,
  resolveTargets,
  sanitizePathSegment,
  type FetchLike,
  type RenderTarget,
} from "./lib/targets";
import { FREEZE_INIT_SCRIPT, FREEZE_STYLE, SETTLE_SCRIPT, contextOptions } from "./lib/browser";
import {
  FINGERPRINTS_VERSION,
  type FingerprintEntry,
  type FingerprintsFile,
} from "./lib/fingerprint-file";
import { managedLadleTargets } from "./lib/harness/serve-plan";

/**
 * Capture engine (T-07): resolve a config into renders, fail fast if a target server is
 * unreachable (R2), then screenshot every render with Playwright under the R1 determinism
 * settings into `.visual-guard/runs/<id>/current/<instance>/<target>/<state>@<viewport>.png`.
 *
 * Pure helpers (parseArgs, renderRelPath, makeRunId, filterTargets, probeOrigins) are unit
 * tested; the Playwright I/O is exercised by the opt-in CP3 determinism integration test.
 * Browser launch / fetch / fs are injectable so the orchestration is testable without a
 * real browser.
 */

const PREFIX = "Visual Guard capture";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultFetch: FetchLike = (url) => globalThis.fetch(url);

// --- Pure helpers ---------------------------------------------------------

export interface CliArgs {
  config: string;
  target?: string;
  runId?: string;
  /** Capture pool size override (`--concurrency N`); falls back to config, then auto. */
  concurrency?: number;
  /** Path to a `.visual-guard/scope.json` (`--scope-file`); restricts capture to the scoped set. */
  scopeFile?: string;
  /** Path to the run's current fingerprints.json (`--fingerprints`); pairs with `--skip-unchanged`. */
  fingerprintsFile?: string;
  /** Enable fingerprint-skip (`--skip-unchanged`); opt-in, no-op without `--fingerprints`. */
  skipUnchanged?: boolean;
}

/** Parse `--config <path> --target <name> --run <id> --concurrency <n> --scope-file <path> --fingerprints <path> --skip-unchanged`; unknown flags / missing values throw. */
export function parseArgs(argv: string[]): CliArgs {
  let config = "config/visual.config.json";
  let target: string | undefined;
  let runId: string | undefined;
  let concurrency: number | undefined;
  let scopeFile: string | undefined;
  let fingerprintsFile: string | undefined;
  let skipUnchanged = false;

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
        config = value(++i, "--config");
        break;
      case "--target":
        target = value(++i, "--target");
        break;
      case "--run":
        runId = value(++i, "--run");
        break;
      case "--concurrency": {
        const raw = value(++i, "--concurrency");
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          fail(`--concurrency must be a positive integer (got ${JSON.stringify(raw)}).`);
        }
        concurrency = parsed;
        break;
      }
      case "--scope-file":
        scopeFile = value(++i, "--scope-file");
        break;
      case "--fingerprints":
        fingerprintsFile = value(++i, "--fingerprints");
        break;
      case "--skip-unchanged":
        skipUnchanged = true;
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  return { config, target, runId, concurrency, scopeFile, fingerprintsFile, skipUnchanged };
}

/** A capture scope: components and/or exact story ids to keep (the change-scoped subset). */
export interface CaptureScope {
  components: string[];
  storyIds: string[];
}

/**
 * Restrict renders to the change-scoped subset: keep a render whose component `name` is in
 * `scope.components` (case-insensitive) OR whose `storyId` is in `scope.storyIds`. An empty scope
 * keeps nothing — callers only apply this for a `mode: "scoped"` decision (never for "all").
 */
export function filterByScope(targets: RenderTarget[], scope: CaptureScope): RenderTarget[] {
  const names = new Set(scope.components.map((name) => name.toLowerCase()));
  const ids = new Set(scope.storyIds);
  return targets.filter(
    (target) =>
      names.has(target.name.toLowerCase()) ||
      (target.storyId !== undefined && ids.has(target.storyId)),
  );
}

/**
 * Read a `scope.json` and return the {@link CaptureScope} to apply, or null when capture must NOT
 * narrow (mode "all"/"none", a missing/malformed file, or an empty scoped set). Best-effort: any
 * read/parse error returns null → a full sweep, upholding the never-narrow-on-uncertainty invariant.
 */
export function readScopeFile(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): CaptureScope | null {
  try {
    const parsed = JSON.parse(read(path)) as {
      mode?: unknown;
      components?: unknown;
      storyIds?: unknown;
    };
    if (parsed.mode !== "scoped") {
      return null; // "all"/"none"/unknown → no narrowing
    }
    const components = Array.isArray(parsed.components)
      ? parsed.components.filter((c): c is string => typeof c === "string")
      : [];
    const storyIds = Array.isArray(parsed.storyIds)
      ? parsed.storyIds.filter((s): s is string => typeof s === "string")
      : [];
    if (components.length === 0 && storyIds.length === 0) {
      return null; // a "scoped" decision with nothing to keep → fall back to full (never capture 0)
    }
    return { components, storyIds };
  } catch {
    return null;
  }
}

/**
 * Resolve the capture pool's worker count. An explicit request (config `concurrency` or
 * `--concurrency`) wins, floored to an integer ≥ 1. Otherwise default to a modest fraction of the
 * machine's cores (cores − 1, clamped to 2..8): enough to be several times faster than serial
 * without overwhelming a dev server or RAM. Design systems with thousands of components can raise
 * it explicitly. The caller clamps the result down to the number of renders.
 */
export function resolveConcurrency(requested: number | undefined, cores: number): number {
  if (requested !== undefined && Number.isFinite(requested) && requested >= 1) {
    return Math.floor(requested);
  }
  const usableCores = Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 4;
  return Math.min(Math.max(usableCores - 1, 2), 8);
}

// `renderRelPath` now lives in lib/targets.ts (so scope.ts can key fingerprints by it without
// importing Playwright via this module); re-exported here for back-compat with existing importers.
export { renderRelPath };

/** A sortable, filesystem-safe run id from a timestamp, e.g. "20260613-080905" (UTC). */
export function makeRunId(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** Filter renders by a `--target` value matching the component name, instance, or "instance/name". */
export function filterTargets(targets: RenderTarget[], filter?: string): RenderTarget[] {
  if (filter === undefined) {
    return targets;
  }
  const wanted = filter.toLowerCase();
  return targets.filter(
    (target) =>
      target.name.toLowerCase() === wanted ||
      target.instance.toLowerCase() === wanted ||
      `${target.instance}/${target.name}`.toLowerCase() === wanted,
  );
}

/** The distinct origins (scheme://host:port) to readiness-probe before capturing. */
export function probeOrigins(targets: RenderTarget[]): string[] {
  const origins = new Set<string>();
  for (const target of targets) {
    origins.add(new URL(target.url).origin);
  }
  return [...origins];
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read a PNG's pixel dimensions straight from its IHDR header — no full decode. A valid PNG is
 * an 8-byte signature followed by the IHDR chunk, whose width/height are big-endian uint32s at
 * byte offsets 16 and 20. Returns null for anything that isn't a well-formed PNG (a truncated
 * buffer, a non-PNG, or a 0-sized image), so capture never throws on an odd screenshot buffer.
 */
export function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  if (buffer.toString("latin1", 12, 16) !== "IHDR") {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

// --- Browser I/O boundary (injectable; real Chromium in production) -------

export interface PageLike {
  goto(
    url: string,
    options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number },
  ): Promise<unknown>;
  addStyleTag(options: { content: string }): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
  close(): Promise<void>;
}

export interface ContextLike {
  /** Register a script to run at document start of every page (used to freeze before load). */
  addInitScript(script: string): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newContext(options?: unknown): Promise<ContextLike>;
  close(): Promise<void>;
}

export type Launcher = () => Promise<BrowserLike>;

const launchChromium: Launcher = async () => {
  const browser = await chromium.launch({ headless: true });
  return browser as unknown as BrowserLike;
};

function writeFileDefault(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export interface CaptureOptions {
  /** `--target` filter (component name, instance, or "instance/name"). */
  target?: string;
  /** Run id; defaults to a UTC timestamp. */
  runId?: string;
  /** Output root; defaults to ".visual-guard". */
  outRoot?: string;
  /** Per-navigation timeout in ms; defaults to 15000. */
  navTimeoutMs?: number;
  /**
   * Abort the whole run on the first render that fails to load/screenshot (default true — a plain
   * `/visual-check` against the user's own server should fail loudly). When false, a failed render is
   * recorded (`RenderRecord.error`), no PNG is written, and capture continues — used by the managed-
   * harness + Studio-sync paths, where one auto-generated story must not nuke the entire run.
   */
  failFast?: boolean;
  /**
   * Capture-pool worker count. Absent → auto (cores-based, see {@link resolveConcurrency}). Each
   * worker owns an isolated browser context; the R1 determinism settings are per-context, so the
   * pool size never changes a single render's pixels — only how many render in parallel.
   */
  concurrency?: number;
  /**
   * Change-scoped subset to capture (from a `scope.json`, mode "scoped"). Absent → capture all
   * resolved renders (a full sweep). Applied AFTER the `--target` filter.
   */
  scope?: CaptureScope;
  /**
   * Enable capture fingerprint-skip (opt-in, OFF by default; the command NEVER auto-enables it under
   * a plain `--all` sweep — that stays a true full capture). When true AND {@link fingerprintsFile} is
   * set, a render whose current input fingerprint byte-equals its approved one (and whose baseline PNG
   * is intact) is copied forward instead of screenshotted. Any gap → captured normally.
   */
  skipUnchanged?: boolean;
  /** Path to the run's CURRENT fingerprints.json (scope-emitted). Required for {@link skipUnchanged} to engage. */
  fingerprintsFile?: string;
  /** Committed baseline root (holds the baseline PNGs + the approved fingerprints.json). Defaults to config.baselineDir. */
  baselineDir?: string;
  /**
   * Rotating forced-recapture quota: how many skip-eligible renders to physically re-shoot this run
   * (the safety bound — see {@link selectRotatingRecapture}). Absent → `ceil(sqrt(N))`; `0` disables
   * forced recapture (every eligible render copied forward). The command leaves it at the default.
   */
  skipForceSample?: number;
}

export interface CaptureDeps {
  fetch: FetchLike;
  launch: Launcher;
  writeFile: (path: string, data: Buffer) => void;
  /** Read a file's bytes (baseline PNGs + fingerprints.json for fingerprint-skip). Injectable for tests. */
  readFile: (path: string) => Buffer;
  now: () => Date;
}

export interface CaptureResult {
  runId: string;
  runDir: string;
  currentDir: string;
  /** Relative paths (under currentDir) written, in capture order. */
  written: string[];
}

/**
 * What capture persists per render in `renders.json` (manifest v2, T-13): enough to let the
 * `visual-reviewer` re-render the live element via Playwright/Chrome-DevTools MCP to
 * disambiguate a diff. The Storybook story id is recoverable from `url`, so it is not stored.
 */
export interface RenderRecord {
  /** Fully-resolved URL the render was captured from. */
  url: string;
  /** Origin kind — tells the reviewer how the render is realized. */
  kind: RenderTarget["kind"];
  /** Viewport width the render was captured at. */
  viewport: number;
  /** Pixel dimensions of the captured PNG, or null when they couldn't be read. */
  currentDimensions: { width: number; height: number } | null;
  /**
   * Set only when this render FAILED to capture (load/screenshot threw) under `failFast: false` — no
   * PNG was written, so compare never sees it; report surfaces this as an `error`-status manifest image.
   */
  error?: string;
  /**
   * True when this render's pixels were COPIED from the approved baseline (its input fingerprint was
   * byte-identical to approval time), NOT screenshotted — capture fingerprint-skip. The copied bytes
   * still land under current/, so compare diffs them to 0 → `pass`; this flag keeps the report honest
   * ("trusted the baseline", never silently folded into "all good"). Additive: report reads tolerantly.
   */
  skipped?: boolean;
}

/** The `renders.json` artifact: render records keyed by the shared `renderRelPath` key. */
export interface RendersFile {
  version: number;
  renders: Record<string, RenderRecord>;
}

const RENDERS_VERSION = 1;

// The fingerprints.json schema lives in lib/fingerprint-file.ts (dependency-free, shared with scope.ts
// so scope can emit fingerprints without importing Playwright via this module). Re-exported for callers.
export { FINGERPRINTS_VERSION, type FingerprintEntry, type FingerprintsFile };

/** sha1 hex of a buffer (a baseline PNG's bytes for tamper-evidence). */
function sha1Bytes(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex");
}

/**
 * Rotating forced-recapture (the safety bound on fingerprint-skip): choose which skip-eligible renders
 * to physically RE-SHOOT this run rather than copy forward. A deterministic window of `ceil(sqrt(N))`
 * keys, offset by a hash of the run id so a DIFFERENT subset is re-shot each run. This converts the
 * irreducible blind spots a fingerprint can't witness (host-font fallback, the Chromium binary, remote/
 * CDN assets, shell-injected env) from PERMANENT into bounded-latency: over ~sqrt(N) runs every baseline
 * is re-verified. Stateless (works on a fresh CI checkout). `N ≤ ceil(sqrt(N))` → re-shoot them all.
 */
export function selectRotatingRecapture(keys: string[], runId: string, sample?: number): Set<string> {
  const n = keys.length;
  if (n === 0) return new Set();
  const k = sample ?? Math.ceil(Math.sqrt(n)); // default quota: ceil(sqrt(N)) (configurable; 0 disables)
  if (k <= 0) return new Set();
  if (k >= n) return new Set(keys);
  const sorted = [...keys].sort();
  const offset = parseInt(createHash("sha1").update(runId).digest("hex").slice(0, 8), 16) % n;
  const out = new Set<string>();
  for (let i = 0; i < k; i++) {
    out.add(sorted[(offset + i) % n] as string);
  }
  return out;
}

/**
 * Read a fingerprints.json into a `{ renderRelPath: FingerprintEntry }` map. Best-effort: a missing
 * file, wrong version, or any parse error → `{}` (skip NOTHING) — upholding the never-skip-on-
 * uncertainty invariant. Reads through the injected `read` so capture stays testable without the fs.
 */
export function readFingerprints(
  path: string,
  read: (p: string) => Buffer,
): Record<string, FingerprintEntry> {
  try {
    const parsed = JSON.parse(read(path).toString("utf8")) as Partial<FingerprintsFile>;
    if (
      parsed.version !== FINGERPRINTS_VERSION ||
      typeof parsed.renders !== "object" ||
      parsed.renders === null
    ) {
      return {};
    }
    const out: Record<string, FingerprintEntry> = {};
    for (const [key, entry] of Object.entries(parsed.renders)) {
      if (entry !== null && typeof entry === "object" && typeof entry.fp === "string") {
        out[key] = { fp: entry.fp, ...(typeof entry.png === "string" ? { png: entry.png } : {}) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Read the `inputs` content-hash map (relPosix → byte-hash) scope emitted alongside the fps — the source
 * files behind the fps, used for the approve-time TOCTOU guard. `{}` on any error / wrong version.
 */
export function readFingerprintInputs(path: string, read: (p: string) => Buffer): Record<string, string> {
  try {
    const parsed = JSON.parse(read(path).toString("utf8")) as Partial<FingerprintsFile>;
    if (parsed.version !== FINGERPRINTS_VERSION || typeof parsed.inputs !== "object" || parsed.inputs === null) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, hash] of Object.entries(parsed.inputs)) {
      if (typeof hash === "string") {
        out[key] = hash;
      }
    }
    return out;
  } catch {
    return {};
  }
}

const defaultDeps: CaptureDeps = {
  fetch: defaultFetch,
  launch: launchChromium,
  writeFile: writeFileDefault,
  readFile: (path) => readFileSync(path),
  now: () => new Date(),
};

/** Readiness probe (R2): any HTTP response means the server is up; only a refused connection fails. */
async function probeOrigin(origin: string, fetchImpl: FetchLike): Promise<void> {
  try {
    await fetchImpl(origin);
  } catch (err) {
    fail(
      `could not reach ${origin} (${detailOf(err)}). Start your dev server / Storybook on ` +
        `${origin} and retry.`,
    );
  }
}

/**
 * Resolve, probe, and capture every matching render. Probes all target origins before
 * launching a browser so a down server fails fast (R2) instead of mid-capture.
 */
export async function captureAll(
  config: Config,
  options: CaptureOptions = {},
  deps: CaptureDeps = defaultDeps,
): Promise<CaptureResult> {
  let targets = filterTargets(await resolveTargets(config, deps.fetch), options.target);
  if (options.scope !== undefined) {
    targets = filterByScope(targets, options.scope);
  }
  if (targets.length === 0) {
    fail(
      options.scope !== undefined
        ? `no renders matched the change scope (${options.scope.components.join(", ") || "none"}).`
        : options.target === undefined
          ? `no render targets resolved from config.`
          : `no targets matched ${JSON.stringify(options.target)}.`,
    );
  }

  for (const origin of probeOrigins(targets)) {
    await probeOrigin(origin, deps.fetch);
  }

  // `--run` is user-controlled and becomes a directory name — sanitize so it can't escape outRoot.
  const runId = sanitizePathSegment(options.runId ?? makeRunId(deps.now()));
  // outRoot defaults to ".visual-guard"; per SPEC boundaries run artifacts live only there.
  const runDir = join(options.outRoot ?? ".visual-guard", "runs", runId);
  const currentDir = join(runDir, "current");
  const navTimeoutMs = options.navTimeoutMs ?? 15000;
  const failFast = options.failFast ?? true;

  const written: string[] = [];
  const renders: Record<string, RenderRecord> = {};

  type Slot = { rel: string; record: RenderRecord; wrote: boolean };
  const slots: Array<Slot | null> = new Array(targets.length).fill(null);

  // ---- Fingerprint-skip plan (opt-in via --skip) -------------------------------------------------
  // A render whose CURRENT input fingerprint byte-equals its APPROVED one (and whose baseline PNG
  // exists) cannot have changed pixels → copy the baseline forward, no browser. OFF unless --skip AND
  // a --fingerprints file are supplied; ANY gap (no current fp, no approved fp, mismatch, unreadable
  // baseline) → capture normally. The copied bytes land under current/, so compare diffs them to 0 →
  // `pass`, keeping compare/report unchanged. `skipped:true` keeps the report honest (see RenderRecord).
  const baselineDir = options.baselineDir ?? config.baselineDir;
  // Read the run's CURRENT fingerprints whenever a --fingerprints file is given — INDEPENDENT of
  // --skip-unchanged — because they are persisted run-scoped below so /visual-baseline can record the
  // approved fingerprint that pairs with each approved PNG. They drive a SKIP only under --skip-unchanged
  // (so the approved file is read, and a render is copied forward, only then).
  const currentFps =
    options.fingerprintsFile !== undefined
      ? readFingerprints(options.fingerprintsFile, deps.readFile)
      : {};
  // The source-file content hashes scope computed F from — re-verified AFTER the pool (the TOCTOU guard).
  const currentInputs =
    options.fingerprintsFile !== undefined
      ? readFingerprintInputs(options.fingerprintsFile, deps.readFile)
      : {};
  const approvedFps =
    options.skipUnchanged === true && Object.keys(currentFps).length > 0
      ? readFingerprints(join(baselineDir, "fingerprints.json"), deps.readFile)
      : {};

  // PASS 1 — classify each target as skip-ELIGIBLE (inputs byte-identical to an intact approved
  // baseline) or must-capture. Skip ONLY when: current input fp === approved input fp, AND the approved
  // entry carries a baseline PNG hash (tamper-evidence — fail closed if absent), AND the live baseline
  // PNG still hashes to it (a corrupted/edited baseline must never be laundered forward), AND it reads.
  const captureIndices: number[] = [];
  const skipEligible: Array<{ index: number; rel: string; bytes: Buffer }> = [];
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (target === undefined) {
      continue;
    }
    const rel = renderRelPath(target);
    const cur = currentFps[rel];
    const appr = approvedFps[rel];
    let baselineBytes: Buffer | null = null;
    if (cur !== undefined && appr !== undefined && cur.fp === appr.fp && appr.png !== undefined) {
      try {
        const bytes = deps.readFile(join(baselineDir, rel)); // missing/unreadable baseline → capture
        baselineBytes = sha1Bytes(bytes) === appr.png ? bytes : null; // tamper mismatch → capture
      } catch {
        baselineBytes = null;
      }
    }
    if (baselineBytes !== null) {
      skipEligible.push({ index: i, rel, bytes: baselineBytes });
    } else {
      captureIndices.push(i);
    }
  }

  // PASS 2 — rotating forced recapture: physically re-shoot a rotating sample of the skip-eligible set
  // (so no blind spot a fingerprint can't see is permanent), and COPY the rest forward (no browser).
  // `skipForceSample` is NOT parsed by the CLI and is absent from the config schema — it exists only so
  // tests can disable the rotation (sample 0). Do NOT wire a production knob to 0: that removes the only
  // bound on the fingerprint's invisible-input blind spots (host fonts, Chromium binary, CDN, env).
  const forced = selectRotatingRecapture(
    skipEligible.map((entry) => entry.rel),
    runId,
    options.skipForceSample,
  );
  for (const { index, rel, bytes } of skipEligible) {
    if (forced.has(rel)) {
      captureIndices.push(index); // re-verify this baseline this run (captured normally, not skipped)
      continue;
    }
    const target = targets[index] as RenderTarget;
    deps.writeFile(join(currentDir, rel), bytes);
    slots[index] = {
      rel,
      wrote: true,
      record: {
        url: target.url,
        kind: target.kind,
        viewport: target.viewport,
        currentDimensions: readPngDimensions(bytes),
        skipped: true,
      },
    };
  }

  // Bounded-concurrency capture of the NON-skipped renders: a pool of workers pulls off a shared
  // cursor, each owning an isolated browser context (the R1 determinism settings are per-context, so
  // running many in parallel never changes a single render's pixels). Results are slotted by the
  // target's ORIGINAL index, so `written`/`renders` stay in config/target order regardless of which
  // worker finishes first. With failFast, the first failure stops new work being pulled and is
  // rethrown after the in-flight renders drain and the browser closes.
  const cores = availableParallelism?.() ?? cpus().length;
  const workerCount = Math.min(resolveConcurrency(options.concurrency, cores), captureIndices.length);

  let nextCursor = 0;
  let aborted = false;
  let firstError: unknown = null;

  // Launch the browser ONLY when something needs screenshotting — an all-unchanged sweep (the CI
  // source-of-truth with nothing changed) copies every baseline forward and never starts Chromium.
  if (captureIndices.length > 0) {
    const browser = await deps.launch();

    /** Capture one render end-to-end in its own context. Throws (failFast) or returns an error slot. */
    const captureOne = async (target: RenderTarget): Promise<Slot> => {
      const rel = renderRelPath(target);
      const context = await browser.newContext(contextOptions(target.viewport));
      try {
        // Freeze animations/transitions BEFORE any page CSS/JS runs, so a load-time animation is
        // never captured mid-flight (R1).
        await context.addInitScript(FREEZE_INIT_SCRIPT);
        const page = await context.newPage();
        try {
          try {
            await page.goto(target.url, { waitUntil: "networkidle", timeout: navTimeoutMs });
            // Belt-and-suspenders freeze for any style inserted late, then wait for fonts / images
            // to settle and reset scroll before the shot.
            await page.addStyleTag({ content: FREEZE_STYLE });
            await page.evaluate(SETTLE_SCRIPT);
            const buffer = await page.screenshot({ fullPage: true });
            deps.writeFile(join(currentDir, rel), buffer);
            // Persist the render's identity + dimensions for manifest v2 (T-13), keyed by the same
            // relative path compare/report key on — so the reviewer can re-render it live.
            return {
              rel,
              wrote: true,
              record: {
                url: target.url,
                kind: target.kind,
                viewport: target.viewport,
                currentDimensions: readPngDimensions(buffer),
              },
            };
          } catch (err) {
            // failFast (default): a down/broken render aborts the run loudly. Tolerant mode (managed
            // harness / Studio sync): record the error, write NO png, and keep going so a single bad
            // story can't nuke the whole capture — report surfaces it from renders.json.
            if (failFast) {
              fail(`failed to capture ${target.instance}/${target.name} (${target.url}): ${detailOf(err)}`);
            }
            return {
              rel,
              wrote: false,
              record: {
                url: target.url,
                kind: target.kind,
                viewport: target.viewport,
                currentDimensions: null,
                error: detailOf(err),
              },
            };
          }
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    };

    const worker = async (): Promise<void> => {
      while (!aborted) {
        const cursor = nextCursor++;
        if (cursor >= captureIndices.length) {
          return;
        }
        const index = captureIndices[cursor];
        if (index === undefined) {
          return;
        }
        const target = targets[index];
        if (target === undefined) {
          return;
        }
        try {
          slots[index] = await captureOne(target);
        } catch (err) {
          // failFast: captureOne threw — keep the FIRST error and stop the pool pulling new work.
          if (firstError === null) {
            firstError = err;
          }
          aborted = true;
          return;
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.max(1, workerCount) }, () => worker()));
    } finally {
      await browser.close();
    }

    // failFast: rethrow the first failure only after the browser is closed (no leaked Chromium).
    if (firstError !== null) {
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
  }

  // Flatten per-index slots in target order so written[]/renders are deterministic regardless of
  // worker completion order.
  for (const slot of slots) {
    if (slot === null) {
      continue;
    }
    renders[slot.rel] = slot.record;
    if (slot.wrote) {
      written.push(slot.rel);
    }
  }

  // Sidecar the resolved render list next to compare.json/manifest.json so report.ts can
  // attach each image's renderTarget + currentDimensions (manifest v2). Written through the
  // injected writeFile so the orchestration stays testable without touching the real fs.
  const rendersFile: RendersFile = { version: RENDERS_VERSION, renders };
  deps.writeFile(
    join(runDir, "renders.json"),
    Buffer.from(`${JSON.stringify(rendersFile, null, 2)}\n`),
  );

  // Persist the run's CURRENT input fingerprints (when scope supplied them) RUN-SCOPED, so
  // /visual-baseline records the approved fingerprint that pairs with each approved PNG — never the
  // stale, fixed-path fingerprints-current.json (which a later run may have overwritten).
  if (options.fingerprintsFile !== undefined) {
    // Approve-time TOCTOU guard: scope byte-hashed the SOURCE to compute these fps BEFORE this run
    // screenshotted the live-server PIXELS. If any of those source inputs changed during the run (an
    // editor / format-on-save / watch task / slow build writing mid-capture), the fps no longer describe
    // the captured PNGs — DROP them all so /visual-baseline can't record a poisoned fp↔PNG pair. The
    // safe direction: those renders just stay non-skip-eligible until re-approved from a clean run.
    let changed = false;
    for (const [rel, hash] of Object.entries(currentInputs)) {
      let now: string | null;
      try {
        now = sha1Bytes(deps.readFile(resolve(rel)));
      } catch {
        now = null; // an input deleted/unreadable mid-run is a change
      }
      if (now !== hash) {
        changed = true;
        break;
      }
    }
    const persistedFps = changed ? {} : currentFps;
    const fpsFile: FingerprintsFile = { version: FINGERPRINTS_VERSION, renders: persistedFps };
    deps.writeFile(
      join(runDir, "fingerprints.json"),
      Buffer.from(`${JSON.stringify(fpsFile, null, 2)}\n`),
    );
  }

  return { runId, runDir, currentDir, written };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig(args.config);
  // A managed (VG-scaffolded) harness renders auto-generated stories that can error individually — be
  // tolerant so one bad story can't abort the whole run. A user's own server stays fail-fast (loud).
  const failFast = managedLadleTargets(config).length === 0;
  // `--scope-file` narrows to the change-scoped subset (mode "scoped"); "all"/"none"/missing → null
  // → a full sweep, so an absent or non-scoped file never silently drops renders.
  const scope = args.scopeFile !== undefined ? (readScopeFile(args.scopeFile) ?? undefined) : undefined;
  const result = await captureAll(config, {
    target: args.target,
    runId: args.runId,
    failFast,
    // `--concurrency` overrides the persisted config knob; both fall back to the cores-based default.
    concurrency: args.concurrency ?? config.concurrency,
    scope,
    // Fingerprint-skip is opt-in: only engages with BOTH `--skip-unchanged` and a `--fingerprints`
    // file. The /visual-check command never passes `--skip-unchanged` for a plain `--all` sweep.
    skipUnchanged: args.skipUnchanged,
    fingerprintsFile: args.fingerprintsFile,
  });
  console.log(`${PREFIX}: wrote ${result.written.length} render(s) -> ${result.currentDir}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
