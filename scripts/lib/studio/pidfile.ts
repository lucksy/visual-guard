import { isAllowedHost } from "./router";

/**
 * Component Studio single-instance pidfile (P3, SPEC §10). The server writes `.visual-guard/studio.pid`
 * describing the live instance; a second `/visual-studio` reads it and **reuses** the running server
 * (just reopens the browser) instead of double-starting, while a **stale** file (the process is gone)
 * is silently overwritten. The decision logic is pure (an injected liveness predicate), so it is
 * unit-testable without spawning processes; {@link isPidAlive} is the thin real probe.
 */

export interface PidfileInfo {
  pid: number;
  port: number;
  /** The loopback URL the server is listening on, e.g. `http://127.0.0.1:54123/`. */
  url: string;
  /** ISO-8601 start time (informational). */
  startedAt: string;
}

/** Serialize a {@link PidfileInfo} to the on-disk JSON form. */
export function formatPidfile(info: PidfileInfo): string {
  return JSON.stringify(info);
}

/** Is `url` a parseable `http:` URL whose host is loopback? (The launcher only opens such URLs.) */
function isLoopbackHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && isAllowedHost(parsed.host);
}

/**
 * Parse pidfile contents back to a {@link PidfileInfo}, or `null` if it is missing/garbage/half-written
 * (a truncated or hand-edited file must never crash the launcher — it is treated as "no live instance").
 */
export function parsePidfile(text: string): PidfileInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (
    typeof o.pid !== "number" ||
    !Number.isInteger(o.pid) ||
    o.pid <= 0 ||
    typeof o.port !== "number" ||
    !Number.isInteger(o.port) ||
    o.port <= 0 ||
    typeof o.url !== "string" ||
    o.url.length === 0 ||
    typeof o.startedAt !== "string"
  ) {
    return null;
  }
  // The launcher auto-opens a browser at `url`; a tampered pidfile must not be able to redirect it.
  // Require a loopback http URL (reusing the server's own Host allowlist) — anything else is "no live
  // instance", so the launcher falls through to starting a fresh server.
  if (!isLoopbackHttpUrl(o.url)) {
    return null;
  }
  return { pid: o.pid, port: o.port, url: o.url, startedAt: o.startedAt };
}

export type PidfileAction = "reuse" | "start";

/**
 * Decide what a launcher should do given the parsed existing pidfile (or `null`) and a liveness probe:
 * **reuse** the already-running server iff the file is valid and its pid is alive, otherwise **start**
 * fresh (overwriting a stale/missing file). Pure — `isAlive` is injected so tests are deterministic.
 */
export function decidePidfileAction(
  existing: PidfileInfo | null,
  isAlive: (pid: number) => boolean,
): PidfileAction {
  return existing !== null && isAlive(existing.pid) ? "reuse" : "start";
}

/**
 * Is `pid` a live process? `process.kill(pid, 0)` sends no signal — it only checks existence/permission.
 * `ESRCH` → gone (false); `EPERM` → exists but owned by another user (true, treat as alive). Any other
 * error is treated as not-alive so a launcher fails safe toward starting a fresh instance.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
