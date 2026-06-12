#!/usr/bin/env node
/**
 * Visual Guard — SessionStart dependency bootstrap.
 *
 * Installs the engine's *runtime* dependencies and a pinned Chromium into the plugin's
 * persistent data dir (${CLAUDE_PLUGIN_DATA}) exactly once. Heavy native deps must not be
 * committed, so they land here on first session and are reused thereafter.
 *
 * Idempotency follows the documented plugin "diff package.json" pattern, adapted because
 * our bundled package.json mixes the dev toolchain with runtime deps: we synthesize an
 * engine-only manifest, write it into the data dir, and treat it as the marker. If the
 * stored marker already matches AND node_modules + the browser are present, we no-op.
 * A FAILED install removes the marker, so the next session retries (never a half-done
 * "installed" state). isInstalled() also requires the browser dir, so a partial install
 * (deps but no Chromium) is likewise treated as not-installed.
 *
 * ENGINE_DEPS is kept in sync with `dependencies` in ../package.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.CLAUDE_PLUGIN_DATA;
if (!dataDir) {
  // Outside a plugin runtime (e.g. a raw `node` invocation) we cannot know where to install.
  console.error(
    "[visual-guard] CLAUDE_PLUGIN_DATA is not set — cannot bootstrap engine deps. " +
      "This script is meant to run from the SessionStart hook.",
  );
  process.exit(1);
}

// Runtime-only engine deps. Keep versions in lockstep with package.json `dependencies`.
const ENGINE_DEPS = {
  pixelmatch: "5.3.0",
  playwright: "1.49.1",
  pngjs: "7.0.0",
  sharp: "0.33.5",
};

const browsersDir = join(dataDir, "browsers");
const markerPath = join(dataDir, "package.json"); // the diff marker
const nodeModulesDir = join(dataDir, "node_modules");
const playwrightBin = join(nodeModulesDir, ".bin", "playwright");

const desiredManifest =
  JSON.stringify(
    { name: "visual-guard-engine", private: true, dependencies: ENGINE_DEPS },
    null,
    2,
  ) + "\n";

function isInstalled() {
  if (!existsSync(markerPath) || !existsSync(nodeModulesDir) || !existsSync(browsersDir)) {
    return false;
  }
  try {
    return readFileSync(markerPath, "utf8") === desiredManifest;
  } catch {
    return false;
  }
}

if (isInstalled()) {
  process.exit(0); // already bootstrapped — silent no-op (runs on every session)
}

// Chromium must resolve to the same path at install time and at capture time.
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir };

try {
  mkdirSync(dataDir, { recursive: true });
  // The marker must exist for `npm install` to read it, but must NOT survive a failure.
  writeFileSync(markerPath, desiredManifest);

  console.error("[visual-guard] Installing engine deps + Chromium into the plugin data dir (one-time)…");

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
