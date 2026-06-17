import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { DB } from "../lib/studio/db";
import {
  componentTimeline,
  componentUsages,
  componentVariants,
  countComponents,
  countSnapshots,
  getComponentById,
  getSnapshotById,
  latestSnapshotForSource,
  listComponentsWithThumbs,
  type ComponentStatus,
  type SnapshotSource,
} from "../lib/studio/store";
import {
  contentTypeFor,
  cspWithFrameSources,
  errorBody,
  isAllowedHost,
  isAllowedMutationOrigin,
  matchRoute,
  resolveStaticAsset,
  SECURITY_HEADERS,
  type Route,
} from "../lib/studio/router";
import { resolveServableImage } from "../lib/studio/images";

/**
 * Component Studio web-app server (P3, SPEC §10). The **I/O shell**: it wires the pure router → DB reads
 * (`store.ts`) → JSON responses + path-confined PNG streaming (`images.ts`). `createStudioServer` returns
 * an un-listened `http.Server` so it is integration-testable over a seeded temp DB (`serve.ts` adds the
 * loopback listen, pidfile, signals, and browser open).
 *
 * Read-mostly. The single mutating route, `POST /api/sync`, re-runs the **code** capture via an injected
 * `onSync` (the engine — agent-free); Figma capture stays in the `/visual-sync` MCP workflow. Concurrent
 * syncs are rejected with 409 (single-flight). Every response carries the same-origin CSP (SPEC §10).
 */

const STATUSES: ReadonlySet<string> = new Set([
  "same",
  "changed",
  "regression",
  "new",
  "error",
  "unknown",
]);
const SNAPSHOT_SOURCES: ReadonlySet<string> = new Set(["figma", "code", "current"]);
/** Upper bound on the `q` search param — a literal substring search past this is meaningless, and an
 *  unbounded `q` would drive an arbitrarily large `LIKE` scan (a trivial local DoS). */
const MAX_Q_LENGTH = 256;
/** Cap on the "Used in" rows returned with a component detail (the UI further trims to 12). */
const USAGES_LIMIT = 50;

export interface StudioServerOptions {
  /** An open studio DB handle (WAL — reads happen while a sync writes on the same handle). */
  db: DB;
  /** Project root for resolving repo-relative image paths (the path-traversal boundary). */
  projectRoot: string;
  /** Directory of the prebuilt SPA (`scripts/studio/public`, P4). May not exist yet → built-in shell. */
  publicDir: string;
  /** Schema version surfaced by `/api/health` (from `db.ts` `SCHEMA_VERSION`). */
  schemaVersion: number;
  /** The project's Storybook base URL (first storybook target), surfaced so the SPA can build
   *  "Open the story" deep links. `null`/absent → the launchpad omits the story link. */
  storybookBaseUrl?: string | null;
  /** Loopback harness origins (Storybook/Ladle) to allow framing for the live-preview pane. Each is
   *  validated (loopback http(s) bare origin) before it widens `frame-src`; absent → no framing. */
  frameOrigins?: string[];
  /**
   * Re-run the headless code sync (engine). Resolves with a JSON-serializable summary. Injected so the
   * e2e can stub it instantly and `serve.ts` can wire the real `captureAll` + `syncCodeFromRun`.
   */
  onSync: () => Promise<unknown>;
}

// --- response helpers -------------------------------------------------------

/** A request header as a single string (the first value if Node parsed a repeated header to an array). */
function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    // Set-if-absent: dispatch sets the (possibly frame-src-widened) CSP up front, so this must not
    // clobber it back to the static base — it only fills in any header not already present.
    if (!res.hasHeader(name)) {
      res.setHeader(name, value);
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  applySecurityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(payload.byteLength));
  // Studio data is live + per-request; never let a proxy/browser cache an API JSON response.
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, errorBody(code, message));
}

/** Minimal same-origin shell served when the prebuilt P4 SPA isn't present (no external calls). */
const BUILTIN_SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual Guard — Component Studio</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a}code{background:#f0f0f0;padding:.1em .35em;border-radius:.25em}a{color:#4f46e5}</style>
</head><body>
<h1>Component Studio</h1>
<p>The JSON API is running. The interactive gallery ships in a later phase.</p>
<p>Populate it with <code>/visual-sync</code>, then explore the API:</p>
<ul>
<li><a href="/api/health">/api/health</a></li>
<li><a href="/api/components">/api/components</a></li>
</ul>
</body></html>
`;

function sendHtml(res: ServerResponse, status: number, html: string): void {
  const payload = Buffer.from(html, "utf8");
  applySecurityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", String(payload.byteLength));
  res.end(payload);
}

// --- route handlers ---------------------------------------------------------

function handleComponentDetail(res: ServerResponse, db: DB, id: number): void {
  const component = getComponentById(db, id);
  if (component === undefined) {
    sendError(res, 404, "not_found", `no component with id ${id}.`);
    return;
  }
  sendJson(res, 200, {
    component,
    variants: componentVariants(db, id),
    // Where this component is used (the "Used in" panel) — bounded so a heavily-reused component can't
    // return an unbounded list.
    usages: componentUsages(db, id, USAGES_LIMIT),
    // Latest snapshot per source (across variant lanes) — enough for P4 to render dual thumbnails
    // without a history fetch.
    latest: {
      figma: latestSnapshotForSource(db, id, "figma") ?? null,
      code: latestSnapshotForSource(db, id, "code") ?? null,
      current: latestSnapshotForSource(db, id, "current") ?? null,
    },
  });
}

function handleHistory(req: IncomingMessage, res: ServerResponse, db: DB, id: number): void {
  if (getComponentById(db, id) === undefined) {
    sendError(res, 404, "not_found", `no component with id ${id}.`);
    return;
  }
  const source = new URL(req.url ?? "/", "http://localhost").searchParams.get("source");
  if (source !== null && !SNAPSHOT_SOURCES.has(source)) {
    sendError(res, 400, "bad_request", `source must be one of figma|code|current (got ${source}).`);
    return;
  }
  const history = componentTimeline(db, id, (source as SnapshotSource | null) ?? undefined);
  sendJson(res, 200, { history });
}

function handleSnapshotImage(req: IncomingMessage, res: ServerResponse, opts: StudioServerOptions, id: number): void {
  const snap = getSnapshotById(opts.db, id);
  if (snap === undefined) {
    sendError(res, 404, "not_found", `no snapshot with id ${id}.`);
    return;
  }
  const abs = resolveServableImage(opts.projectRoot, snap.image_path);
  if (abs === null) {
    // The path failed the lexical guard, escaped both image roots, or the file is gone.
    sendError(res, 404, "image_unavailable", `image for snapshot ${id} is missing or out of bounds.`);
    return;
  }
  // Snapshots are content-addressed (hash never changes for an id) → a strong, immutable ETag.
  const etag = `"${snap.image_hash}"`;
  applySecurityHeaders(res);
  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.setHeader("ETag", etag);
    res.end();
    return;
  }
  let size: number;
  try {
    size = statSync(abs).size;
  } catch {
    sendError(res, 404, "image_unavailable", `image for snapshot ${id} could not be read.`);
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", String(size));
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  const stream = createReadStream(abs);
  stream.on("error", () => {
    if (!res.headersSent) {
      sendError(res, 404, "image_unavailable", `image for snapshot ${id} could not be read.`);
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

function handleStatic(res: ServerResponse, publicDir: string, urlPath: string): void {
  const asset = resolveStaticAsset(urlPath);
  if (asset === null) {
    sendError(res, 404, "not_found", "not found.");
    return;
  }
  const filePath = join(publicDir, asset);
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    // No prebuilt SPA on disk → serve the built-in shell for the app-shell route; 404 a real asset miss.
    if (asset === "index.html") {
      sendHtml(res, 200, BUILTIN_SHELL);
    } else {
      sendError(res, 404, "not_found", "not found.");
    }
    return;
  }
  applySecurityHeaders(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeFor(asset));
  res.setHeader("Content-Length", String(size));
  // The SPA shell must always re-validate; hashed assets (P4) can override per-file later.
  res.setHeader("Cache-Control", asset === "index.html" ? "no-cache" : "public, max-age=300");
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      sendError(res, 404, "not_found", "not found.");
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

/**
 * Build the read-mostly + sync request handler over `opts`. Holds the single-flight sync promise in a
 * closure so a second `POST /api/sync` while one is running gets a clean 409 instead of racing the engine.
 */
function makeHandler(opts: StudioServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { db, publicDir, schemaVersion } = opts;
  let syncInFlight: Promise<unknown> | null = null;
  // The CSP is constant for this server's lifetime (derived from config once). Compute it here so the
  // live-preview pane can frame the configured loopback harness origin(s) — explicit origins, no wildcard.
  const csp = cspWithFrameSources(opts.frameOrigins ?? []);

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Set the (possibly frame-src-widened) CSP first so every response carries it; applySecurityHeaders
    // is set-if-absent and therefore never overwrites it with the static base CSP.
    res.setHeader("Content-Security-Policy", csp);
    // DNS-rebinding defense: answer only for loopback Host names (binding to 127.0.0.1 restricts the
    // interface, not the Host header). A foreign/absent Host is refused before any DB read.
    if (!isAllowedHost(req.headers.host)) {
      sendError(res, 403, "forbidden", "host not allowed.");
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const route: Route = matchRoute(req.method ?? "GET", pathname);

    switch (route.kind) {
      case "health":
        sendJson(res, 200, {
          status: "ok",
          schemaVersion,
          storybookBaseUrl: opts.storybookBaseUrl ?? null,
          counts: { components: countComponents(db), snapshots: countSnapshots(db) },
        });
        return;
      case "components": {
        const params = new URL(req.url ?? "/", "http://localhost").searchParams;
        const status = params.get("status");
        if (status !== null && !STATUSES.has(status)) {
          sendError(res, 400, "bad_request", `unknown status filter ${JSON.stringify(status)}.`);
          return;
        }
        const q = params.get("q");
        if (q !== null && q.length > MAX_Q_LENGTH) {
          sendError(res, 400, "bad_request", `q must be at most ${MAX_Q_LENGTH} characters.`);
          return;
        }
        sendJson(res, 200, {
          components: listComponentsWithThumbs(db, {
            status: (status as ComponentStatus | null) ?? undefined,
            q: q ?? undefined,
          }),
        });
        return;
      }
      case "component":
        handleComponentDetail(res, db, route.id);
        return;
      case "componentHistory":
        handleHistory(req, res, db, route.id);
        return;
      case "componentVariants": {
        if (getComponentById(db, route.id) === undefined) {
          sendError(res, 404, "not_found", `no component with id ${route.id}.`);
          return;
        }
        sendJson(res, 200, { variants: componentVariants(db, route.id) });
        return;
      }
      case "snapshot": {
        const snap = getSnapshotById(db, route.id);
        if (snap === undefined) {
          sendError(res, 404, "not_found", `no snapshot with id ${route.id}.`);
          return;
        }
        sendJson(res, 200, { snapshot: snap });
        return;
      }
      case "snapshotImage":
        handleSnapshotImage(req, res, opts, route.id);
        return;
      case "sync": {
        // CSRF defense for the one mutating route: a cross-site request must not be able to drive the
        // engine. Reject anything not provably same-origin (Sec-Fetch-Site / Origin) before running.
        if (!isAllowedMutationOrigin(headerStr(req, "sec-fetch-site"), headerStr(req, "origin"))) {
          sendError(res, 403, "forbidden", "cross-origin sync is not allowed.");
          return;
        }
        if (syncInFlight !== null) {
          sendError(res, 409, "sync_in_progress", "a sync is already running.");
          return;
        }
        syncInFlight = Promise.resolve().then(opts.onSync);
        try {
          const summary = await syncInFlight;
          sendJson(res, 200, { ok: true, summary });
        } catch (err) {
          // The engine's capture errors are user-actionable (e.g. "start your dev server") and only
          // readable same-origin (no CORS header), so the SPA gets the real message; also log it.
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[visual-studio] sync failed: ${message}`);
          sendError(res, 500, "sync_failed", message);
        } finally {
          syncInFlight = null;
        }
        return;
      }
      case "methodNotAllowed":
        applySecurityHeaders(res);
        res.setHeader("Allow", route.allow);
        sendError(res, 405, "method_not_allowed", `method not allowed (allow: ${route.allow}).`);
        return;
      case "notFound":
        sendError(res, 404, "not_found", "not found.");
        return;
      case "static":
        handleStatic(res, publicDir, route.path);
        return;
    }
  }

  return (req, res) => {
    dispatch(req, res).catch((err) => {
      // An unexpected handler error: log the detail server-side, but return a GENERIC message so a raw
      // exception (which may embed host paths / internals) is never echoed in the response body.
      console.error(`[visual-studio] request error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (!res.headersSent) {
        sendError(res, 500, "internal_error", "internal server error.");
      } else {
        res.destroy();
      }
    });
  };
}

/** Create the studio `http.Server` (not yet listening). `serve.ts` calls `.listen(0, "127.0.0.1")`. */
export function createStudioServer(opts: StudioServerOptions): Server {
  return createServer(makeHandler(opts));
}

export { BUILTIN_SHELL };
