import { mkdirSync, writeFileSync } from "node:fs";
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
}

/** Parse `--config <path> --target <name> --run <id>`; unknown flags / missing values throw. */
export function parseArgs(argv: string[]): CliArgs {
  let config = "config/visual.config.json";
  let target: string | undefined;
  let runId: string | undefined;

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
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  return { config, target, runId };
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

  const written: string[] = [];
  const browser = await deps.launch();
  try {
    for (const target of targets) {
      const context = await browser.newContext(contextOptions(target.viewport));
      try {
        // Freeze animations/transitions BEFORE any page CSS/JS runs, so a load-time
        // animation is never captured mid-flight (R1).
        await context.addInitScript(FREEZE_INIT_SCRIPT);
        const page = await context.newPage();
        try {
          try {
            await page.goto(target.url, { waitUntil: "networkidle", timeout: navTimeoutMs });
          } catch (err) {
            fail(`failed to load ${target.instance}/${target.name} (${target.url}): ${detailOf(err)}`);
          }
          // Belt-and-suspenders freeze for any style inserted late, then wait for fonts /
          // images to settle and reset scroll before the shot.
          await page.addStyleTag({ content: FREEZE_STYLE });
          await page.evaluate(SETTLE_SCRIPT);
          const buffer = await page.screenshot({ fullPage: true });
          const rel = renderRelPath(target);
          deps.writeFile(join(currentDir, rel), buffer);
          written.push(rel);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  return { runId, runDir, currentDir, written };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig(args.config);
  const result = await captureAll(config, { target: args.target, runId: args.runId });
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
