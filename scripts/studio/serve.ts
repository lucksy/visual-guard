import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../lib/config";
import { ensureBrowsersPath } from "../lib/browsers-path";
import { captureAll } from "../capture";
import { openDb, SCHEMA_VERSION } from "../lib/studio/db";
import { studioDbPath, DEFAULT_OUT_ROOT } from "../lib/studio/keys";
import {
  decidePidfileAction,
  formatPidfile,
  isPidAlive,
  parsePidfile,
  type PidfileInfo,
} from "../lib/studio/pidfile";
import { browserOpenCommand } from "../lib/studio/open";
import { createStudioServer } from "./server";
import { syncCodeFromRun } from "./sync";

/**
 * Component Studio web-app entry (P3, SPEC §10). Boots the localhost server: opens the DB, enforces a
 * single instance via `.visual-guard/studio.pid` (reuse a live one, overwrite a stale one), listens on
 * `127.0.0.1:0` (loopback + OS-chosen port), writes the pidfile, prints the URL as one line of JSON, and
 * opens the browser (unless `--no-open`). SIGINT/SIGTERM closes the server + DB and removes the pidfile.
 *
 * `POST /api/sync` is wired to the headless engine (`captureAll` + `syncCodeFromRun`); Figma capture is
 * the agent-driven `/visual-sync` workflow, never the server. `/visual-studio` launches this detached so
 * the agent turn completes while the server keeps running.
 */

const PREFIX = "Visual Guard studio serve";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));

export interface ServeCliArgs {
  config: string;
  outRoot: string;
  port: number;
  open: boolean;
}

export function parseArgs(argv: string[]): ServeCliArgs {
  let config = "config/visual.config.json";
  let outRoot = DEFAULT_OUT_ROOT;
  let port = 0; // 0 → OS-assigned ephemeral port
  let open = true;

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
      case "--out":
        outRoot = value(++i, "--out");
        break;
      case "--port": {
        const raw = value(++i, "--port");
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 65535) {
          fail(`--port must be 0..65535 (got ${JSON.stringify(raw)}).`);
        }
        port = n;
        break;
      }
      case "--no-open":
        open = false;
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  return { config, outRoot, port, open };
}

/** Spawn the platform browser-open command, fully detached so it never blocks server shutdown. */
function openBrowser(url: string): void {
  const { cmd, args } = browserOpenCommand(process.platform, url);
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Opening the browser is best-effort — the URL is printed regardless.
  }
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  // The in-app Sync button (`POST /api/sync` → captureAll) renders via Playwright, which needs the
  // pinned Chromium at `${CLAUDE_PLUGIN_DATA}/browsers`. The server is launched detached (no caller
  // exports PLAYWRIGHT_BROWSERS_PATH), so resolve it here — without this, Sync fails "browser not
  // found" even on a healthy engine.
  ensureBrowsersPath();
  const config = loadConfig(args.config);
  const baselineDir = config.baselineDir;
  mkdirSync(args.outRoot, { recursive: true });
  const pidfilePath = join(args.outRoot, "studio.pid");

  // --- Single-instance guard: reuse a live server, overwrite a stale pidfile ---
  const existing = existsSync(pidfilePath)
    ? parsePidfile(readFileSync(pidfilePath, "utf8"))
    : null;
  if (decidePidfileAction(existing, isPidAlive) === "reuse" && existing !== null) {
    if (args.open) {
      openBrowser(existing.url);
    }
    console.log(JSON.stringify({ reused: true, ...existing }));
    return;
  }

  const dbPath = studioDbPath(args.outRoot);
  const db = openDb(dbPath);

  // The first Storybook target's URL → "Open the story" deep links in the SPA (omitted if none).
  const storybookTarget = config.targets.find((t) => t.type === "storybook");

  // Story-explorer (Storybook/Ladle) origins the SPA may frame for the live-preview pane. The router
  // validates each to a loopback http(s) bare origin before it widens frame-src — so a public/odd URL
  // is simply dropped, never embedded.
  const frameOrigins = config.targets
    .filter((t) => t.type === "storybook" || t.type === "ladle")
    .map((t) => {
      try {
        return new URL(t.url).origin;
      } catch {
        return null;
      }
    })
    .filter((origin): origin is string => origin !== null);

  const server = createStudioServer({
    db,
    projectRoot: process.cwd(),
    publicDir: PUBLIC_DIR,
    schemaVersion: SCHEMA_VERSION,
    storybookBaseUrl: storybookTarget ? storybookTarget.url : null,
    frameOrigins,
    // Code capture is the engine (headless Playwright). Reuse the same DB handle the server reads from
    // — better-sqlite3 is synchronous, so reads between capture `await`s never see a torn write. The
    // server already serializes this (single-flight 409), so no extra guard is needed here.
    onSync: async () => {
      const capture = await captureAll(config, { outRoot: args.outRoot });
      return syncCodeFromRun({
        db,
        config,
        currentDir: capture.currentDir,
        baselineDir,
        outRoot: args.outRoot,
      });
    },
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.close(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(pidfilePath, { force: true });
      process.exit(0);
    });
    // Failsafe: if connections keep the server from closing promptly, exit anyway.
    setTimeout(() => {
      rmSync(pidfilePath, { force: true });
      process.exit(0);
    }, 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.on("error", (err) => {
    db.close();
    console.error(`${PREFIX}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

  server.listen(args.port, "127.0.0.1", () => {
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/`;
    const info: PidfileInfo = {
      pid: process.pid,
      port: addr.port,
      url,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(pidfilePath, formatPidfile(info));
    console.log(JSON.stringify({ reused: false, ...info, dbPath }));
    if (args.open) {
      openBrowser(url);
    }
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { PUBLIC_DIR };
