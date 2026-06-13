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
 * specifiers (`playwright`, `sharp`, `pngjs`, `pixelmatch`) which ESM resolves by walking up
 * from the script to the nearest `node_modules` — and NODE_PATH does NOT apply to ESM. So the
 * installed deps in the data dir are unreachable from `scripts/` unless a `node_modules` sits
 * adjacent to them. `ensureBridgeLink` symlinks `${pluginRoot}/node_modules` → the data-dir
 * deps in a real install; in local dev the root already has a real `node_modules` (the full
 * toolchain), which is left untouched. `tsx` is part of ENGINE_DEPS so the runner resolves too.
 *
 * ENGINE_DEPS is kept in sync with `dependencies` in ../package.json, plus `tsx` (the runner).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The plugin root is this script's parent's parent (…/scripts/install-deps.mjs) — derived from
// the file location, not an env var, so it is correct under the hook runner and under tests.
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Runtime-only engine deps. Keep the diff-engine versions in lockstep with package.json
// `dependencies`; `tsx` is the runner the commands invoke and lives here too (not committed).
export const ENGINE_DEPS = {
  pixelmatch: "5.3.0",
  playwright: "1.49.1",
  pngjs: "7.0.0",
  sharp: "0.33.5",
  tsx: "4.19.2",
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

function main() {
  const rawDataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (!rawDataDir) {
    // Outside a plugin runtime (e.g. a raw `node` invocation) we cannot know where to install.
    console.error(
      "[visual-guard] CLAUDE_PLUGIN_DATA is not set — cannot bootstrap engine deps. " +
        "This script is meant to run from the SessionStart hook.",
    );
    process.exit(1);
  }
  // Normalize to absolute: the bridge symlink's target must be absolute (a symlink resolves
  // relative to the link's own directory, not cwd), so a relative CLAUDE_PLUGIN_DATA would
  // otherwise produce a link that points at the wrong place.
  const dataDir = resolve(rawDataDir);

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

    console.error(
      "[visual-guard] Installing engine deps + Chromium into the plugin data dir (one-time)…",
    );

    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], {
      cwd: dataDir,
      env,
      stdio: "inherit",
    });

    execFileSync(playwrightBin, ["install", "chromium"], {
      cwd: dataDir,
      env,
      stdio: "inherit",
    });

    // Deps + browser are in place — now wire them to the plugin root so the engine is runnable.
    refreshBridge();

    console.error("[visual-guard] Engine deps ready.");
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
  main();
}
