import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { loadConfig, type Config } from "./lib/config";
import {
  resolveTargets,
  sanitizePathSegment,
  type FetchLike,
  type RenderTarget,
} from "./lib/targets";
import { FREEZE_INIT_SCRIPT, FREEZE_STYLE, SETTLE_SCRIPT, contextOptions } from "./lib/browser";
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
}

/** Parse `--config <path> --target <name> --run <id> --concurrency <n>`; unknown flags / missing values throw. */
export function parseArgs(argv: string[]): CliArgs {
  let config = "config/visual.config.json";
  let target: string | undefined;
  let runId: string | undefined;
  let concurrency: number | undefined;

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
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  return { config, target, runId, concurrency };
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

/** The shared relative key for a render — used under current/, baseline/, and diff/. */
export function renderRelPath(render: RenderTarget): string {
  return `${render.instance}/${render.name}/${render.state}@${render.viewport}.png`;
}

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
}

export interface CaptureDeps {
  fetch: FetchLike;
  launch: Launcher;
  writeFile: (path: string, data: Buffer) => void;
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
}

/** The `renders.json` artifact: render records keyed by the shared `renderRelPath` key. */
export interface RendersFile {
  version: number;
  renders: Record<string, RenderRecord>;
}

const RENDERS_VERSION = 1;

const defaultDeps: CaptureDeps = {
  fetch: defaultFetch,
  launch: launchChromium,
  writeFile: writeFileDefault,
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
  const targets = filterTargets(await resolveTargets(config, deps.fetch), options.target);
  if (targets.length === 0) {
    fail(
      options.target === undefined
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

  // Bounded-concurrency capture: a pool of workers pulls renders off a shared index queue, each
  // owning an isolated browser context (the R1 determinism settings are per-context, so running
  // many in parallel never changes a single render's pixels). Results are slotted by the target's
  // ORIGINAL index, so `written`/`renders` stay in config/target order regardless of which worker
  // finishes first. With failFast, the first failure stops new work being pulled and is rethrown
  // after the in-flight renders drain and the browser closes.
  const cores = availableParallelism?.() ?? cpus().length;
  const workerCount = Math.min(resolveConcurrency(options.concurrency, cores), targets.length);

  type Slot = { rel: string; record: RenderRecord; wrote: boolean };
  const slots: Array<Slot | null> = new Array(targets.length).fill(null);
  let nextIndex = 0;
  let aborted = false;
  let firstError: unknown = null;

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
      const index = nextIndex++;
      if (index >= targets.length) {
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

  return { runId, runDir, currentDir, written };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig(args.config);
  // A managed (VG-scaffolded) harness renders auto-generated stories that can error individually — be
  // tolerant so one bad story can't abort the whole run. A user's own server stays fail-fast (loud).
  const failFast = managedLadleTargets(config).length === 0;
  const result = await captureAll(config, {
    target: args.target,
    runId: args.runId,
    failFast,
    // `--concurrency` overrides the persisted config knob; both fall back to the cores-based default.
    concurrency: args.concurrency ?? config.concurrency,
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
