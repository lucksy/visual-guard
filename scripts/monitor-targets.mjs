#!/usr/bin/env node
/**
 * Visual Guard — dev-server / Storybook readiness monitor (T-24).
 *
 * Registered in monitors/monitors.json with `when: "on-skill-invoke:visual-check"`, so it starts
 * watching the configured targets the first time `/visual-check` runs in a session. It polls each
 * target's reachability AND health (Storybook `/index.json` parses → story count; app `routes`
 * return a non-5xx status) on an interval and prints **one line per state transition** to stdout —
 * each line is delivered to Claude as a notification, so the model sees "Storybook came up" or
 * "/checkout started 500ing" without being asked.
 *
 * Monitors are READ-ONLY and NON-GATING (verified — Decision D1): this surfaces readiness; it does
 * not replace `capture.ts`'s hard origin probe, which stays the fail-fast gate (R2). Plain ESM with
 * only Node builtins so it runs under a bare `node` with no install step (the engine deps may not be
 * bootstrapped, and a monitor must be light). Pure helpers are exported for unit testing; the poll
 * loop runs only when invoked directly. Any unexpected error becomes a logged line — the monitor
 * never crashes out of its loop.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 4000;

// --- Config resolution (mirrors detect-ui-change.mjs / visual-check.md precedence) ---------

/**
 * Resolve the project's Visual Guard config object, using the same precedence as the
 * `/visual-check` command: project `visual.config.json`, then `config/visual.config.json`, then the
 * bundled `${CLAUDE_PLUGIN_ROOT}/config/visual.config.json`. Best-effort — returns null if none
 * parses (the monitor then has nothing to watch and exits quietly). No-dep: it can't import the TS
 * config loader, so it reads the raw JSON.
 */
export function resolveConfig(cwd, env = process.env, io = {}) {
  const { readFileImpl = readFileSync, existsImpl = existsSync } = io;
  const candidates = [join(cwd, "visual.config.json"), join(cwd, "config", "visual.config.json")];
  if (env && typeof env.CLAUDE_PLUGIN_ROOT === "string" && env.CLAUDE_PLUGIN_ROOT.length > 0) {
    candidates.push(join(env.CLAUDE_PLUGIN_ROOT, "config", "visual.config.json"));
  }
  for (const path of candidates) {
    try {
      if (!existsImpl(path)) {
        continue;
      }
      const parsed = JSON.parse(readFileImpl(path, "utf8"));
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Turn a parsed config into the flat list of monitorable targets: `{ kind, label, origin, url,
 * routes, stories }`. Invalid entries (no type / no parseable url) are skipped rather than throwing,
 * so one bad target never blinds the monitor to the others.
 */
export function targetsFromConfig(parsed) {
  const raw = parsed && Array.isArray(parsed.targets) ? parsed.targets : [];
  const targets = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const { type, url } = entry;
    if ((type !== "storybook" && type !== "app") || typeof url !== "string" || url.length === 0) {
      continue;
    }
    let origin;
    let host;
    try {
      const parsedUrl = new URL(url);
      origin = parsedUrl.origin;
      host = parsedUrl.host;
    } catch {
      continue; // not a usable URL
    }
    targets.push({
      // A unique per-target id (the monitor reads raw JSON and can't reuse resolveTargets' duplicate-
      // label guard, so two targets could share a display `label`). prevState keys by `id`, not
      // `label`, so colliding labels never share one state slot and drop a target's transitions.
      id: `${type}:${origin}:${targets.length}`,
      kind: type,
      label: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : host,
      origin,
      url: url.replace(/\/+$/, ""),
      routes: type === "app" && Array.isArray(entry.routes) ? entry.routes.filter((r) => typeof r === "string") : [],
      stories: type === "storybook" && Array.isArray(entry.stories) ? entry.stories : null,
    });
  }
  return targets;
}

// --- Probing (fetch injected; defaults to the global) ---------------------

/** A fetch with a timeout so a hung server can't stall the poll loop. */
async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll one target → `{ status, detail }` where status is one of:
 *   "ready"       — reachable and healthy
 *   "degraded"    — reachable but a route/index is erroring (detail says how)
 *   "unreachable" — the origin refused / timed out
 * Never throws — a probe failure becomes "unreachable"/"degraded".
 */
export async function pollTarget(target, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS) {
  if (target.kind === "storybook") {
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, `${target.origin}/index.json`, timeoutMs);
    } catch {
      return { status: "unreachable", detail: "" };
    }
    if (!response.ok) {
      return { status: "degraded", detail: `index.json → HTTP ${response.status}` };
    }
    try {
      const index = await response.json();
      // Mirror the engine contract (lib/targets.ts parseStoryIndex): only the SB7+ `entries` shape
      // is renderable. A legacy SB6 `stories.json`/`stories` index is rejected by capture, so report
      // it degraded here rather than a misleading "ready" the subsequent capture would contradict.
      if (index && typeof index.entries === "object" && index.entries !== null) {
        const count = Object.keys(index.entries).length;
        return { status: "ready", detail: `${count} ${count === 1 ? "story" : "stories"}` };
      }
      if (index && typeof index.stories === "object" && index.stories !== null) {
        return { status: "degraded", detail: "legacy Storybook (SB6) — capture requires SB >= 7" };
      }
      return { status: "degraded", detail: "index.json has no entries (Storybook >= 7?)" };
    } catch {
      return { status: "degraded", detail: "index.json not valid JSON" };
    }
  }

  // app: origin reachability, then route health.
  try {
    await fetchWithTimeout(fetchImpl, target.origin, timeoutMs);
  } catch {
    return { status: "unreachable", detail: "" };
  }
  for (const route of target.routes) {
    const path = route.startsWith("/") ? route : `/${route}`;
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, `${target.origin}${path}`, timeoutMs);
    } catch {
      return { status: "degraded", detail: `${path} → unreachable` };
    }
    if (response.status >= 500) {
      return { status: "degraded", detail: `${path} → HTTP ${response.status}` };
    }
  }
  const n = target.routes.length;
  return { status: "ready", detail: n > 0 ? `${n} route(s) ok` : "reachable" };
}

// --- Formatting + transition logic (pure) ---------------------------------

const STATUS_ICON = { ready: "ok", degraded: "!!", unreachable: "??" };

/** A single human line for a target's current status (delivered to Claude as a notification). */
export function formatLine(target, result) {
  const icon = STATUS_ICON[result.status] ?? "?";
  const where = `${target.kind} ${target.label}`;
  if (result.status === "ready") {
    return `${icon} ${where} ready${result.detail ? ` (${result.detail})` : ""}`;
  }
  if (result.status === "unreachable") {
    return `${icon} ${where} unreachable (${target.origin})`;
  }
  return `${icon} ${where} ${result.detail}`;
}

/** A stable key for a status so the loop logs only on a real change (status OR detail). */
export function statusKey(result) {
  return `${result.status}:${result.detail}`;
}

// --- Orchestration --------------------------------------------------------

/** Poll every target once, returning `[{ target, result, line }]`. Never throws. */
export async function pollAll(targets, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS) {
  const out = [];
  for (const target of targets) {
    let result;
    try {
      result = await pollTarget(target, fetchImpl, timeoutMs);
    } catch (err) {
      result = { status: "unreachable", detail: err instanceof Error ? err.message : String(err) };
    }
    out.push({ target, result, line: formatLine(target, result) });
  }
  return out;
}

/** One pass: poll all targets and log each line (used by `--once` and as the loop body). */
export async function runOnce(targets, { fetchImpl, log, timeoutMs = PROBE_TIMEOUT_MS }) {
  const polled = await pollAll(targets, fetchImpl, timeoutMs);
  for (const { line } of polled) {
    log(line);
  }
  return polled;
}

/**
 * Long-running loop: poll on `intervalMs`, logging a target's line only when its status key changes
 * (including the first observation). `prevState` is a Map kept across passes. Returns the updated
 * Map so a test can drive successive passes deterministically without timers.
 */
export async function runPass(targets, { fetchImpl, log, prevState, timeoutMs = PROBE_TIMEOUT_MS }) {
  const polled = await pollAll(targets, fetchImpl, timeoutMs);
  for (const { target, result, line } of polled) {
    const stateId = target.id ?? target.label; // unique per target — see targetsFromConfig
    const key = statusKey(result);
    if (prevState.get(stateId) !== key) {
      prevState.set(stateId, key);
      log(line);
    }
  }
  return prevState;
}

// --- CLI ------------------------------------------------------------------

export function parseArgs(argv) {
  let once = false;
  let intervalMs = DEFAULT_INTERVAL_MS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") {
      once = true;
    } else if (arg === "--interval") {
      // Only consume the next token as the value when it is a valid positive number — otherwise
      // leave it in place so a following flag (e.g. `--interval --once`) isn't silently swallowed.
      const next = argv[i + 1];
      const parsed = Number(next);
      if (next !== undefined && Number.isFinite(parsed) && parsed > 0) {
        intervalMs = parsed;
        i++;
      }
    }
  }
  return { once, intervalMs };
}

async function main(argv) {
  const args = parseArgs(argv);
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const config = resolveConfig(cwd);
  const targets = targetsFromConfig(config);
  const log = (line) => process.stdout.write(`${line}\n`);

  if (targets.length === 0) {
    log("Visual Guard monitor: no targets in config — nothing to watch.");
    return;
  }

  const fetchImpl = (url, init) => globalThis.fetch(url, init);

  if (args.once) {
    await runOnce(targets, { fetchImpl, log });
    return;
  }

  // Long-running: poll, log transitions, sleep, repeat. A poll error is contained per target.
  const prevState = new Map();
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    try {
      await runPass(targets, { fetchImpl, log, prevState });
    } catch (err) {
      log(`Visual Guard monitor: poll error — ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    // A monitor must not crash noisily; surface the error as a line and exit cleanly.
    process.stdout.write(
      `Visual Guard monitor: stopped — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(0);
  });
}
