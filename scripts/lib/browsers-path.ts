import { join } from "node:path";

/**
 * Ensure `PLAYWRIGHT_BROWSERS_PATH` points at the pinned Chromium the installer fetched into
 * `${CLAUDE_PLUGIN_DATA}/browsers`. Playwright reads this from the environment at launch; the
 * slash-command orchestrators (check.ts / ci-run.ts) set it for the children they spawn, but the
 * STANDALONE capture entrypoints — the `sync.ts` CLI and the Studio server's in-app Sync — have no such
 * caller. Without this they fall back to Playwright's default cache (`~/.cache/ms-playwright`), which
 * does not have the pinned build → "browser not found".
 *
 * Mutates `env` in place (defaulting to `process.env`) and returns the resolved path, or `null` when it
 * was neither already set nor resolvable. NEVER overrides a value a caller already set, so the
 * orchestrators that set it explicitly keep precedence.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function ensureBrowsersPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PLAYWRIGHT_BROWSERS_PATH) {
    return env.PLAYWRIGHT_BROWSERS_PATH;
  }
  if (env.CLAUDE_PLUGIN_DATA) {
    env.PLAYWRIGHT_BROWSERS_PATH = join(env.CLAUDE_PLUGIN_DATA, "browsers");
    return env.PLAYWRIGHT_BROWSERS_PATH;
  }
  return null;
}
