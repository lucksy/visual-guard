#!/usr/bin/env node
/**
 * Visual Guard — SessionStart dependency bootstrap + engine-invocation bridge.
 *
 * Installs the engine's *runtime* dependencies and a pinned Chromium into the plugin's
 * persistent data dir (${CLAUDE_PLUGIN_DATA}) exactly once, then bridges those deps back to
 * the plugin root so the bundled `.ts` engine is actually runnable by the slash commands.
 * Heavy native deps must not be committed, so they land in the data dir on first session and
 * are reused thereafter.
 *
 * Idempotency follows the documented plugin "diff package.json" pattern, adapted because
 * our bundled package.json mixes the dev toolchain with runtime deps: we synthesize an
 * engine-only manifest, write it into the data dir, and treat it as the marker. If the
 * stored marker already matches AND node_modules + the browser are present, we no-op (but
 * still re-assert the bridge link). A FAILED install removes the marker, so the next session
 * retries (never a half-done "installed" state). isInstalled() also requires the browser dir,
 * so a partial install (deps but no Chromium) is likewise treated as not-installed.
 *
 * The bridge (T-12): the `/visual-check` & `/visual-baseline` commands run the engine via
 * `${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx scripts/<x>.ts`. Those scripts import bare
 * specifiers (`playwright`, `sharp`, `pngjs`, `pixelmatch`, and the Studio DB's native
 * `better-sqlite3`) which ESM resolves by walking up
 * from the script to the nearest `node_modules` — and NODE_PATH does NOT apply to ESM. So the
 * installed deps in the data dir are unreachable from `scripts/` unless a `node_modules` sits
 * adjacent to them. `ensureBridgeLink` symlinks `${pluginRoot}/node_modules` → the data-dir
 * deps in a real install; in local dev the root already has a real `node_modules` (the full
 * toolchain), which is left untouched. `tsx` is part of ENGINE_DEPS so the runner resolves too.
 *
 * ENGINE_DEPS is kept in sync with `dependencies` in ../package.json, plus `tsx` (the runner).
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The plugin root is this script's parent's parent (…/scripts/install-deps.mjs) — derived from
// the file location, not an env var, so it is correct under the hook runner and under tests.
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Runtime-only engine deps. Keep the diff-engine versions in lockstep with package.json
// `dependencies`; `tsx` (the command runner) and `typescript` (the token scanner's JSX/Tailwind
// AST + the JS-eval child process) come from devDependencies and live here too (not committed).
export const ENGINE_DEPS = {
  "better-sqlite3": "12.10.1",
  culori: "4.0.2",
  pixelmatch: "5.3.0",
  playwright: "1.49.1",
  pngjs: "7.0.0",
  postcss: "8.5.15",
  "postcss-less": "6.0.0",
  "postcss-scss": "4.0.9",
  sharp: "0.33.5",
  tsx: "4.19.2",
  typescript: "5.7.3",
};

/** The engine-only manifest written into the data dir; also the install marker. */
export function desiredManifest() {
  return (
    JSON.stringify(
      { name: "visual-guard-engine", private: true, dependencies: ENGINE_DEPS },
      null,
      2,
    ) + "\n"
  );
}

/** True iff `linkPath` is a symlink that resolves to the same real dir as `depsNodeModules`. */
function pointsAtDeps(linkPath, depsNodeModules) {
  try {
    // realpathSync throws on a broken link (target gone) → caught → not pointing at deps.
    return realpathSync(linkPath) === realpathSync(depsNodeModules);
  } catch {
    return false;
  }
}

/**
 * Make the installed engine deps reachable from `${pluginRoot}/scripts/` by ensuring
 * `rootNodeModules` resolves to `depsNodeModules`. ESM resolution walks up from the importing
 * file to the nearest `node_modules` (NODE_PATH does not apply to ESM), so this adjacent link
 * is the only mechanism that lets the bundled scripts resolve their bare imports and the tsx
 * runner in a real plugin install.
 *
 * - No entry at the root → create the symlink (the production case).
 * - A real directory at the root → leave it (local dev: the full toolchain is already there).
 * - A symlink that does NOT resolve to the current deps (broken, OR a stale link to a wiped/
 *   relocated data dir) → repair it so the engine never resolves stale deps.
 *
 * Tolerant of a concurrent SessionStart racing the same link: a symlink that already exists by
 * the time we create it (EEXIST) is treated as success, so a benign race never crashes the hook.
 * Returns "created" | "repaired" | "kept-existing". Never clobbers a real directory.
 */
export function ensureBridgeLink(rootNodeModules, depsNodeModules) {
  const link = () => {
    try {
      symlinkSync(depsNodeModules, rootNodeModules, "dir");
    } catch (err) {
      // Another session created the link between our check and here — that is the desired
      // end state, so treat it as done rather than throwing.
      if (!(err && err.code === "EEXIST")) {
        throw err;
      }
    }
  };

  let stat = null;
  try {
    stat = lstatSync(rootNodeModules);
  } catch {
    stat = null; // nothing there
  }

  if (stat === null) {
    link();
    return "created";
  }

  if (stat.isSymbolicLink()) {
    // Repair a link that no longer points at the current deps (broken target, or a stale link
    // to a previous data-dir location). A link already pointing at the deps is left as-is.
    if (!pointsAtDeps(rootNodeModules, depsNodeModules)) {
      rmSync(rootNodeModules, { force: true });
      link();
      return "repaired";
    }
    return "kept-existing";
  }

  // A real directory (dev install) — never replace it.
  return "kept-existing";
}

/** Human-readable label for the pinned browser the installer fetches via Playwright. */
const BROWSER_LABEL = "Chromium (pinned, via Playwright)";

/**
 * Inspect the install state of a data dir WITHOUT touching it — fs reads only, no install, no
 * `process.exit`, no bridge mutation. Mirrors `main()`'s path math and the `isInstalled()`
 * criteria exactly so `--check` and the actual install agree on what "installed" means:
 *   installed ⟺ marker (package.json) matches desiredManifest() AND node_modules present AND
 *   the browsers dir present.
 *
 * `dataDir` is resolved() internally so a relative path still inspects the right place (the
 * installer needs an absolute path for the symlink target, but inspection only reads). Returns a
 * structured, JSON-serializable state object; the consent gate (`/visual-setup`) reads it.
 *
 * @param {string} dataDir
 * @returns {{
 *   dataDir: string,
 *   installed: boolean,
 *   depsPresent: boolean,
 *   browserPresent: boolean,
 *   markerMatches: boolean,
 *   missing: string[],
 *   engineDeps: typeof ENGINE_DEPS,
 *   browser: string,
 * }}
 */
export function computeInstallState(dataDir) {
  const resolvedDataDir = resolve(dataDir);
  const browsersDir = join(resolvedDataDir, "browsers");
  const markerPath = join(resolvedDataDir, "package.json"); // the diff marker
  const nodeModulesDir = join(resolvedDataDir, "node_modules");
  const manifest = desiredManifest();

  const depsPresent = existsSync(nodeModulesDir);
  const browserPresent = existsSync(browsersDir);

  let markerMatches = false;
  if (existsSync(markerPath)) {
    try {
      markerMatches = readFileSync(markerPath, "utf8") === manifest;
    } catch {
      markerMatches = false; // unreadable marker → treat as not matching
    }
  }

  // Same gate as isInstalled(): all three must hold.
  const installed = markerMatches && depsPresent && browserPresent;

  const missing = [];
  if (!depsPresent) {
    missing.push("deps");
  }
  if (!browserPresent) {
    missing.push("browser");
  }
  if (!markerMatches) {
    missing.push("marker");
  }

  return {
    dataDir: resolvedDataDir,
    installed,
    depsPresent,
    browserPresent,
    markerMatches,
    missing,
    engineDeps: ENGINE_DEPS,
    browser: BROWSER_LABEL,
  };
}

/** The plugin's own name, from the bundled plugin.json (fallback to the known name). */
function readPluginName() {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
    if (typeof pkg.name === "string" && pkg.name.length > 0) {
      return pkg.name;
    }
  } catch {
    /* manifest missing/unreadable — fall through */
  }
  return "visual-guard";
}

/** The marketplace name, from the bundled marketplace.json, or null when it isn't present. */
function readMarketplaceName() {
  try {
    const mkt = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    if (typeof mkt.name === "string" && mkt.name.length > 0) {
      return mkt.name;
    }
  } catch {
    /* not bundled — fall through to discovery */
  }
  return null;
}

/**
 * Resolve the plugin's data dir (where the engine deps + Chromium live). Prefers CLAUDE_PLUGIN_DATA,
 * which the SessionStart hook injects. When it is absent — a slash command's Bash runs mid-session, or
 * the plugin was *added* mid-session so the hook never ran — fall back to Claude Code's conventional
 * location so a `--check` (and a consent-gated install) still works WITHOUT a session restart:
 *
 *   <CLAUDE_CONFIG_DIR | ~/.claude>/plugins/data/<plugin>-<marketplace>
 *
 * <plugin>/<marketplace> come from the bundled manifests; if marketplace.json isn't bundled we discover
 * a single existing `<plugin>-*` data dir instead. Returns an absolute path, or null when it genuinely
 * cannot be determined (then `--check` reports "not installed / unknown" rather than erroring).
 */
export function resolveDataDir(env = process.env) {
  if (env.CLAUDE_PLUGIN_DATA) {
    // Normalize to absolute: the bridge symlink's target must be absolute (a symlink resolves
    // relative to the link's own directory, not cwd).
    return resolve(env.CLAUDE_PLUGIN_DATA);
  }
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const dataBase = join(configDir, "plugins", "data");
  const plugin = readPluginName();

  const marketplace = readMarketplaceName();
  if (marketplace) {
    // The convention Claude Code uses to name a plugin's data dir.
    return join(dataBase, `${plugin}-${marketplace}`);
  }
  // marketplace.json wasn't bundled — fall back to a single existing <plugin>-* data dir.
  try {
    const matches = readdirSync(dataBase).filter((d) => d.startsWith(`${plugin}-`));
    if (matches.length === 1) {
      return join(dataBase, matches[0]);
    }
  } catch {
    /* data base doesn't exist yet */
  }
  return null;
}

/**
 * Run a child process to completion, streaming its output to our inherited stdout/stderr while
 * emitting a periodic heartbeat so a long, quiet phase never *looks* frozen. Used for the two slow
 * install phases (npm + Chromium) so the user can see the engine setup is alive and progressing.
 *
 * Why plain lines and not a `\r` spinner: under the SessionStart hook and under a slash command's
 * Bash, stdout is NOT a TTY, so a carriage-return progress bar wouldn't render — appended lines read
 * as progress in every context (and the child's own npm/Playwright progress streams in between).
 *
 * The heartbeat timer is `unref`'d so it never keeps the process alive on its own; the awaited child
 * handle is what holds the event loop open until "close".
 *
 * @param {string} label    Phase label, e.g. "▸ 2/2 Downloading Chromium (~150 MB)…"
 * @param {string} command  Executable to run.
 * @param {string[]} args   Arguments.
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} opts
 * @returns {Promise<void>} resolves on exit 0, rejects on spawn error or non-zero exit.
 */
export function runStep(label, command, args, opts) {
  return new Promise((resolveStep, rejectStep) => {
    const startedAt = Date.now();
    const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
    process.stderr.write(`[visual-guard] ${label}\n`);

    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: "inherit" });

    const heartbeat = setInterval(() => {
      process.stderr.write(`[visual-guard]   … still working (${elapsed()}s)\n`);
    }, 6000);
    if (typeof heartbeat.unref === "function") {
      heartbeat.unref();
    }

    const finish = (fn, arg) => {
      clearInterval(heartbeat);
      fn(arg);
    };

    child.on("error", (err) => finish(rejectStep, err));
    child.on("close", (code) => {
      if (code === 0) {
        process.stderr.write(`[visual-guard]   ✓ done (${elapsed()}s)\n`);
        finish(resolveStep, undefined);
      } else {
        finish(rejectStep, new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function main() {
  // `--check`: read-only install-state inspection for the /visual-setup consent gate. Prints the
  // computeInstallState() JSON to STDOUT and exits 0 — ALWAYS, even when the data dir can't be
  // resolved — so a mid-session Bash invocation never shows a hard error. Installs nothing.
  const checkOnly = process.argv.includes("--check");

  // Normally CLAUDE_PLUGIN_DATA; resolveDataDir falls back to the conventional path when it's absent
  // (command Bash mid-session, or the plugin was added mid-session so the SessionStart hook never ran).
  const dataDir = resolveDataDir();

  if (checkOnly) {
    // STDOUT (not stderr): the consent gate parses this. No install, no bridge, no fs writes.
    if (dataDir === null) {
      process.stdout.write(
        JSON.stringify({
          dataDir: null,
          installed: false,
          depsPresent: false,
          browserPresent: false,
          markerMatches: false,
          missing: ["deps", "browser", "marker"],
          engineDeps: ENGINE_DEPS,
          browser: BROWSER_LABEL,
          reason:
            "CLAUDE_PLUGIN_DATA is not set and the data dir could not be resolved — treat as not installed.",
        }) + "\n",
      );
      process.exit(0);
    }
    process.stdout.write(JSON.stringify(computeInstallState(dataDir)) + "\n");
    process.exit(0);
  }

  if (dataDir === null) {
    // A real install needs a target dir. If none could be resolved, guide the user rather than crash
    // with a raw error — a fresh session lets the SessionStart hook set CLAUDE_PLUGIN_DATA and install.
    console.error(
      "[visual-guard] Could not resolve the plugin data dir (CLAUDE_PLUGIN_DATA is not set). " +
        "Start a fresh session so the SessionStart hook can install the engine, or set CLAUDE_PLUGIN_DATA.",
    );
    process.exit(1);
  }

  const browsersDir = join(dataDir, "browsers");
  const markerPath = join(dataDir, "package.json"); // the diff marker
  const nodeModulesDir = join(dataDir, "node_modules");
  const playwrightBin = join(nodeModulesDir, ".bin", "playwright");
  const rootNodeModules = join(pluginRoot, "node_modules");
  const manifest = desiredManifest();

  // Re-assert the bridge link, but never let a benign link race / fs hiccup fail the hook: the
  // deps are installed and the commands' own preflight will report if the runner is unreachable.
  const refreshBridge = () => {
    try {
      ensureBridgeLink(rootNodeModules, nodeModulesDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[visual-guard] Could not link the engine into the plugin root: ${message}. ` +
          "If a command reports the runner is unreachable, retry in a fresh session.",
      );
    }
  };

  const isInstalled = () => {
    if (!existsSync(markerPath) || !existsSync(nodeModulesDir) || !existsSync(browsersDir)) {
      return false;
    }
    try {
      return readFileSync(markerPath, "utf8") === manifest;
    } catch {
      return false;
    }
  };

  if (isInstalled()) {
    // Re-assert the bridge every session — cheap, and self-heals a wiped/relocated link.
    refreshBridge();
    process.exit(0); // already bootstrapped — silent no-op
  }

  // Chromium must resolve to the same path at install time and at capture time.
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir };

  try {
    mkdirSync(dataDir, { recursive: true });
    // The marker must exist for `npm install` to read it, but must NOT survive a failure.
    writeFileSync(markerPath, manifest);

    process.stderr.write(
      "[visual-guard] Setting up the engine (one-time): runtime deps + a pinned Chromium " +
        `(~150 MB) → ${dataDir}\n`,
    );

    // Two streamed phases, each with a heartbeat so a long, quiet download never looks frozen.
    await runStep(
      "▸ 1/2 Installing engine packages (npm)…",
      "npm",
      ["install", "--no-audit", "--no-fund", "--no-package-lock"],
      { cwd: dataDir, env },
    );
    await runStep("▸ 2/2 Downloading Chromium (~150 MB)…", playwrightBin, ["install", "chromium"], {
      cwd: dataDir,
      env,
    });

    // Deps + browser are in place — now wire them to the plugin root so the engine is runnable.
    refreshBridge();

    process.stderr.write("[visual-guard] ✓ Engine ready — deps + Chromium installed.\n");
    process.exit(0);
  } catch (err) {
    // Leave NO marker behind so the next session retries from a clean slate.
    rmSync(markerPath, { force: true });
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[visual-guard] Dependency bootstrap failed: ${message}`);
    console.error("[visual-guard] Will retry on the next session.");
    process.exit(1);
  }
}

// Run only when invoked directly (`node install-deps.mjs`), so the module can be imported by
// tests without triggering an install or a process.exit.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[visual-guard] Dependency bootstrap failed: ${message}`);
    process.exit(1);
  });
}
