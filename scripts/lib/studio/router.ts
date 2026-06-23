import { posix } from "node:path";

/**
 * Component Studio web-app router (P3, SPEC §10). **Pure** — no I/O, no `node:http` types — so the
 * route table, the static-asset path resolution (the URL-driven path-traversal guard), the MIME map,
 * and the CSP header are all unit-testable in isolation. The I/O shell (`scripts/studio/server.ts`)
 * matches a request, then reads the DB / streams a file accordingly.
 *
 * Two distinct security boundaries live in the Studio server, both refusing `..`/absolute escapes:
 *  - **URL → static asset** under `public/` — {@link resolveStaticAsset} here (lexical).
 *  - **DB image_path → file** under `.visual-baselines/`/`.visual-guard/` — `images.ts` (lexical + realpath).
 */

/**
 * Content-Security-Policy for the localhost app (SPEC §10): same-origin only, `data:` images for inline
 * thumbnails, no plugins, no `<base>` redirection. The browser makes **zero external calls** — there is
 * no token anywhere and the page only consumes already-captured local images.
 */
export const CSP =
  "default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; " +
  "frame-ancestors 'none'";

/** Headers applied to every response: the CSP plus MIME-sniffing and framing hardening. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
});

/**
 * Is `origin` a bare loopback http(s) origin (`scheme://host[:port]`, nothing more)? Only such origins may
 * widen `frame-src` for the live-preview pane — so a hostile/misconfigured target URL can never open the
 * policy to a public host or smuggle extra CSP directives: the `origin === parsed.origin` check rejects
 * anything carrying a path/query, and the loopback requirement keeps the embed strictly local.
 */
export function isFramableOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return isAllowedHost(parsed.host) && origin === parsed.origin;
}

/**
 * The response CSP, optionally widened to permit framing specific loopback harness origins (Storybook /
 * Ladle) for the Studio's live-preview pane. With no framable origins it returns the base {@link CSP}
 * unchanged (frames fall back to `default-src 'self'`). NEVER adds a wildcard — each entry is an explicit,
 * validated loopback origin — so the "no `*` in the policy" invariant holds.
 */
export function cspWithFrameSources(origins: string[]): string {
  const safe = [...new Set(origins.filter(isFramableOrigin))];
  if (safe.length === 0) {
    return CSP;
  }
  return `${CSP}; frame-src 'self' ${safe.join(" ")}`;
}

// --- Host / origin guards (DNS-rebinding + CSRF defense) --------------------

/**
 * Loopback host names the server answers for. A foreign `Host` (DNS rebinding) is refused. IPv6 loopback
 * appears in a Host header only in bracketed form (`[::1]`), so the bare `::1` is intentionally absent.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Is the request's `Host` header a loopback name? Binding to `127.0.0.1` only restricts the network
 * interface, **not** which `Host` values the server answers for — so a DNS-rebinding page at
 * `evil.com` (rebound to 127.0.0.1) could otherwise read the whole API same-origin. We refuse any
 * `Host` whose hostname isn't loopback (and an absent `Host`). The port portion is ignored — the
 * defense is on the hostname. Pure + unit-tested; the server calls it before routing.
 */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    return false;
  }
  let host = hostHeader;
  if (host.startsWith("[")) {
    // Bracketed IPv6: keep `[::1]`, drop any `:port` after the closing bracket.
    const end = host.indexOf("]");
    if (end === -1) {
      return false;
    }
    host = host.slice(0, end + 1);
  } else {
    const colon = host.indexOf(":");
    if (colon !== -1) {
      host = host.slice(0, colon);
    }
  }
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Should a **mutating** request (POST /api/sync) be allowed? Guards against cross-site CSRF: a bare
 * cross-origin `fetch(..., { mode: 'no-cors' })` is a CORS "simple request" (no preflight) that would
 * otherwise drive the engine. Modern browsers stamp `Sec-Fetch-Site` — we reject `cross-site`. For
 * clients without it, we fall back to the `Origin` header (browsers send it on POST): if present, its
 * host must be loopback. A non-browser client (no `Sec-Fetch-Site`, no `Origin` — e.g. a local script)
 * is allowed. Pure + unit-tested.
 */
export function isAllowedMutationOrigin(
  secFetchSite: string | undefined,
  origin: string | undefined,
): boolean {
  if (typeof secFetchSite === "string" && secFetchSite.length > 0) {
    return secFetchSite === "same-origin" || secFetchSite === "same-site" || secFetchSite === "none";
  }
  if (typeof origin === "string" && origin.length > 0) {
    try {
      return isAllowedHost(new URL(origin).host);
    } catch {
      return false; // unparseable Origin → refuse the mutation
    }
  }
  return true; // no browser fetch-metadata at all → a same-machine non-browser client
}

/** The error response contract (SPEC §10): `{ error: { code, message } }`. */
export interface ErrorBody {
  error: { code: string; message: string };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

// --- MIME -------------------------------------------------------------------

const MIME: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
});

/** Content-Type for a file path by extension; `application/octet-stream` for anything unknown. */
export function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) {
    return "application/octet-stream";
  }
  return MIME[filePath.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

// --- Route matching ---------------------------------------------------------

export type Route =
  | { kind: "health" }
  | { kind: "summary" }
  | { kind: "diffImage" }
  | { kind: "components" }
  | { kind: "component"; id: number }
  | { kind: "componentHistory"; id: number }
  | { kind: "componentVariants"; id: number }
  | { kind: "componentRegressions"; id: number }
  | { kind: "snapshot"; id: number }
  | { kind: "snapshotImage"; id: number }
  | { kind: "snapshotApprove"; id: number }
  | { kind: "sync" }
  /** A non-`/api/*` GET — resolved against `public/` by the server (SPA app shell). */
  | { kind: "static"; path: string }
  /** A known API path requested with the wrong HTTP method → 405. */
  | { kind: "methodNotAllowed"; allow: string }
  /** An unknown `/api/*` path → 404 JSON. */
  | { kind: "notFound" };

/** Parse a path segment as a positive integer DB id, or `null` (so `/api/components/abc` 404s). */
function parseId(segment: string): number | null {
  if (!/^[0-9]+$/.test(segment)) {
    return null;
  }
  const id = Number(segment);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Map an HTTP method + URL pathname (already percent-decoded, no query) to a {@link Route}.
 *
 * `/api/*` is matched exactly against the documented table; a known path with the wrong method yields
 * `methodNotAllowed`, an unknown `/api/*` path yields `notFound`. Everything else is a `static` GET (the
 * SPA shell + its assets) — a non-GET to a non-API path is `methodNotAllowed`. Numeric ids are validated
 * here so malformed ids never reach a DB query.
 */
export function matchRoute(method: string, pathname: string): Route {
  const verb = method.toUpperCase();

  if (pathname === "/api/health") {
    return verb === "GET" ? { kind: "health" } : { kind: "methodNotAllowed", allow: "GET" };
  }
  if (pathname === "/api/summary") {
    return verb === "GET" ? { kind: "summary" } : { kind: "methodNotAllowed", allow: "GET" };
  }
  if (pathname === "/api/diff") {
    // The from/to snapshot ids live in the query string (parsed + validated by the handler).
    return verb === "GET" ? { kind: "diffImage" } : { kind: "methodNotAllowed", allow: "GET" };
  }
  if (pathname === "/api/components") {
    return verb === "GET" ? { kind: "components" } : { kind: "methodNotAllowed", allow: "GET" };
  }
  if (pathname === "/api/sync") {
    return verb === "POST" ? { kind: "sync" } : { kind: "methodNotAllowed", allow: "POST" };
  }

  // /api/components/:id[/history|/variants|/regressions]
  const comp = /^\/api\/components\/([^/]+)(?:\/(history|variants|regressions))?$/.exec(pathname);
  if (comp) {
    const id = parseId(comp[1] ?? "");
    if (id === null) {
      return { kind: "notFound" };
    }
    if (verb !== "GET") {
      return { kind: "methodNotAllowed", allow: "GET" };
    }
    if (comp[2] === "history") {
      return { kind: "componentHistory", id };
    }
    if (comp[2] === "variants") {
      return { kind: "componentVariants", id };
    }
    if (comp[2] === "regressions") {
      return { kind: "componentRegressions", id };
    }
    return { kind: "component", id };
  }

  // /api/snapshots/:id[/image|/approve]
  const snap = /^\/api\/snapshots\/([^/]+)(?:\/(image|approve))?$/.exec(pathname);
  if (snap) {
    const id = parseId(snap[1] ?? "");
    if (id === null) {
      return { kind: "notFound" };
    }
    // /approve is the one mutating snapshot route → POST; everything else under /snapshots is GET.
    if (snap[2] === "approve") {
      return verb === "POST" ? { kind: "snapshotApprove", id } : { kind: "methodNotAllowed", allow: "POST" };
    }
    if (verb !== "GET") {
      return { kind: "methodNotAllowed", allow: "GET" };
    }
    return snap[2] === "image" ? { kind: "snapshotImage", id } : { kind: "snapshot", id };
  }

  if (pathname.startsWith("/api/")) {
    return { kind: "notFound" }; // an unknown API endpoint is a 404, never a static-file read
  }

  // Static (SPA) — only GET serves the app shell; other verbs are not allowed.
  if (verb !== "GET") {
    return { kind: "methodNotAllowed", allow: "GET" };
  }
  return { kind: "static", path: pathname };

}

// --- Static asset path resolution (URL-driven traversal guard) --------------

/**
 * Resolve a request pathname to a **`public/`-relative** asset path, or `null` if it escapes that root.
 * `/` (and any extension-less path — a client-router deep link) maps to `index.html` for SPA fallback.
 * Refuses `..` traversal, backslashes (Windows separators), NUL bytes, and absolute paths *before* the
 * server ever joins it to a directory — the URL-side analogue of `images.ts`'s DB-path guard.
 *
 * Returns a POSIX-relative path (forward slashes); the server joins it to `publicDir`.
 */
export function resolveStaticAsset(pathname: string): string | null {
  if (pathname.includes("\0") || pathname.includes("\\")) {
    return null; // NUL byte or backslash — reject outright (Windows-separator smuggling)
  }
  if (pathname === "/" || pathname === "") {
    return "index.html";
  }
  if (!pathname.startsWith("/")) {
    return null; // a well-formed request pathname is always absolute-from-root
  }
  const rel = pathname.slice(1);
  // posix.normalize collapses `a/../b` etc.; an escape surfaces as a leading `..`.
  const normalized = posix.normalize(rel);
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    return null;
  }
  // A directory-style or extension-less path is a client-router deep link → serve the app shell.
  if (normalized === "" || normalized.endsWith("/") || !normalized.includes(".")) {
    return "index.html";
  }
  return normalized;
}
