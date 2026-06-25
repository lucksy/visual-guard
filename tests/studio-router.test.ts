import { describe, it, expect } from "vitest";
import {
  contentTypeFor,
  CSP,
  cspWithFrameSources,
  errorBody,
  isAllowedHost,
  isAllowedMutationOrigin,
  isFramableOrigin,
  matchRoute,
  resolveStaticAsset,
  SECURITY_HEADERS,
} from "../scripts/lib/studio/router";

describe("matchRoute — API table", () => {
  it("matches each documented endpoint with its verb", () => {
    expect(matchRoute("GET", "/api/health")).toEqual({ kind: "health" });
    expect(matchRoute("GET", "/api/components")).toEqual({ kind: "components" });
    expect(matchRoute("GET", "/api/components/42")).toEqual({ kind: "component", id: 42 });
    expect(matchRoute("GET", "/api/components/42/history")).toEqual({
      kind: "componentHistory",
      id: 42,
    });
    expect(matchRoute("GET", "/api/components/42/variants")).toEqual({
      kind: "componentVariants",
      id: 42,
    });
    expect(matchRoute("GET", "/api/snapshots/7")).toEqual({ kind: "snapshot", id: 7 });
    expect(matchRoute("GET", "/api/snapshots/7/image")).toEqual({ kind: "snapshotImage", id: 7 });
    expect(matchRoute("POST", "/api/sync")).toEqual({ kind: "sync" });
    expect(matchRoute("GET", "/api/drift")).toEqual({ kind: "drift" }); // F5
  });

  it("is method-aware: a known path with the wrong verb is 405, not a static read", () => {
    expect(matchRoute("POST", "/api/health")).toEqual({ kind: "methodNotAllowed", allow: "GET" });
    expect(matchRoute("DELETE", "/api/components/1")).toEqual({
      kind: "methodNotAllowed",
      allow: "GET",
    });
    expect(matchRoute("GET", "/api/sync")).toEqual({ kind: "methodNotAllowed", allow: "POST" });
    expect(matchRoute("POST", "/api/drift")).toEqual({ kind: "methodNotAllowed", allow: "GET" });
  });

  it("rejects non-numeric / non-positive ids as 404 (never reaches a DB query)", () => {
    expect(matchRoute("GET", "/api/components/abc")).toEqual({ kind: "notFound" });
    expect(matchRoute("GET", "/api/components/0")).toEqual({ kind: "notFound" });
    expect(matchRoute("GET", "/api/components/-1")).toEqual({ kind: "notFound" });
    expect(matchRoute("GET", "/api/snapshots/1.5")).toEqual({ kind: "notFound" });
  });

  it("treats an unknown /api/* path as 404, never as a static file read", () => {
    expect(matchRoute("GET", "/api/nope")).toEqual({ kind: "notFound" });
    expect(matchRoute("GET", "/api/components/1/bogus")).toEqual({ kind: "notFound" });
  });

  it("routes non-API GETs to static, and non-GET non-API to 405", () => {
    expect(matchRoute("GET", "/")).toEqual({ kind: "static", path: "/" });
    expect(matchRoute("GET", "/app.js")).toEqual({ kind: "static", path: "/app.js" });
    expect(matchRoute("GET", "/components/42")).toEqual({ kind: "static", path: "/components/42" });
    expect(matchRoute("POST", "/")).toEqual({ kind: "methodNotAllowed", allow: "GET" });
  });

  it("is case-insensitive on the method", () => {
    expect(matchRoute("get", "/api/health")).toEqual({ kind: "health" });
    expect(matchRoute("post", "/api/sync")).toEqual({ kind: "sync" });
  });

  it("routes the P6 endpoints (summary, diff, regressions, approve) with the right verbs", () => {
    expect(matchRoute("GET", "/api/summary")).toEqual({ kind: "summary" });
    expect(matchRoute("POST", "/api/summary")).toEqual({ kind: "methodNotAllowed", allow: "GET" });

    // /api/diff takes from/to in the query string, so the route carries no id.
    expect(matchRoute("GET", "/api/diff")).toEqual({ kind: "diffImage" });
    expect(matchRoute("POST", "/api/diff")).toEqual({ kind: "methodNotAllowed", allow: "GET" });

    expect(matchRoute("GET", "/api/components/42/regressions")).toEqual({
      kind: "componentRegressions",
      id: 42,
    });
    expect(matchRoute("POST", "/api/components/42/regressions")).toEqual({
      kind: "methodNotAllowed",
      allow: "GET",
    });

    // /approve is the one POST under /snapshots; GET on it is 405 (allow POST).
    expect(matchRoute("POST", "/api/snapshots/7/approve")).toEqual({ kind: "snapshotApprove", id: 7 });
    expect(matchRoute("GET", "/api/snapshots/7/approve")).toEqual({
      kind: "methodNotAllowed",
      allow: "POST",
    });
    // The image sub-route stays GET-only — a POST to it is 405 (allow GET), NOT mistaken for approve.
    expect(matchRoute("POST", "/api/snapshots/7/image")).toEqual({
      kind: "methodNotAllowed",
      allow: "GET",
    });
    expect(matchRoute("GET", "/api/snapshots/abc/approve")).toEqual({ kind: "notFound" });
  });
});

describe("resolveStaticAsset — URL traversal guard + SPA fallback", () => {
  it("maps the root and client-router deep links to index.html", () => {
    expect(resolveStaticAsset("/")).toBe("index.html");
    expect(resolveStaticAsset("")).toBe("index.html");
    expect(resolveStaticAsset("/components/42")).toBe("index.html"); // extension-less deep link
    expect(resolveStaticAsset("/some/dir/")).toBe("index.html"); // trailing slash
  });

  it("returns real asset paths for files with extensions", () => {
    expect(resolveStaticAsset("/app.js")).toBe("app.js");
    expect(resolveStaticAsset("/assets/app.css")).toBe("assets/app.css");
    expect(resolveStaticAsset("/a/b/c.png")).toBe("a/b/c.png");
  });

  it("collapses interior . and .. without escaping the root", () => {
    expect(resolveStaticAsset("/a/./b.js")).toBe("a/b.js");
    expect(resolveStaticAsset("/a/x/../b.js")).toBe("a/b.js");
  });

  it("REFUSES traversal, backslashes, NUL, and absolute smuggling (returns null)", () => {
    expect(resolveStaticAsset("/../etc/passwd")).toBeNull();
    expect(resolveStaticAsset("/../../secret.png")).toBeNull();
    expect(resolveStaticAsset("/a/../../b")).toBeNull();
    expect(resolveStaticAsset("/a\\..\\b")).toBeNull(); // backslash separator
    expect(resolveStaticAsset("/a\0.js")).toBeNull(); // NUL byte
    expect(resolveStaticAsset("relative/no/leading/slash")).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it("maps known extensions and defaults unknowns to octet-stream", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("a.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("x.PNG")).toBe("image/png"); // case-insensitive
    expect(contentTypeFor("data.json")).toBe("application/json; charset=utf-8");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
    expect(contentTypeFor("weird.xyz")).toBe("application/octet-stream");
  });
});

describe("CSP + error contract", () => {
  it("CSP is same-origin only and the security headers include it", () => {
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).toContain("connect-src 'self'");
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).not.toContain("*"); // no wildcard origin anywhere
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toBe(CSP);
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("errorBody matches the { error: { code, message } } contract", () => {
    expect(errorBody("not_found", "nope")).toEqual({ error: { code: "not_found", message: "nope" } });
  });
});

describe("cspWithFrameSources — live-preview frame-src (loopback only, no wildcard)", () => {
  it("returns the base CSP unchanged when there are no framable origins", () => {
    expect(cspWithFrameSources([])).toBe(CSP);
  });

  it("appends frame-src with only the loopback http(s) origins, deduped, no wildcard", () => {
    const csp = cspWithFrameSources([
      "http://localhost:61000",
      "http://localhost:61000", // duplicate
      "http://127.0.0.1:6006",
    ]);
    expect(csp.startsWith(CSP)).toBe(true);
    expect(csp).toContain("frame-src 'self' http://localhost:61000 http://127.0.0.1:6006");
    expect(csp).not.toContain("*");
    // The duplicate is collapsed.
    expect(csp.match(/http:\/\/localhost:61000/g)?.length).toBe(1);
  });

  it("drops non-loopback / non-origin / bad inputs so the policy never widens to a public host", () => {
    const csp = cspWithFrameSources([
      "https://evil.example.com",
      "http://localhost:61000/with/path", // not a bare origin
      "ftp://localhost:21",
      "garbage",
    ]);
    expect(csp).toBe(CSP); // nothing framable → base CSP
  });

  it("isFramableOrigin accepts only bare loopback http(s) origins", () => {
    expect(isFramableOrigin("http://localhost:61000")).toBe(true);
    expect(isFramableOrigin("http://127.0.0.1:6006")).toBe(true);
    expect(isFramableOrigin("https://localhost:8443")).toBe(true);
    expect(isFramableOrigin("http://localhost")).toBe(true); // default port normalized away
    expect(isFramableOrigin("http://localhost:61000/preview")).toBe(false); // carries a path
    expect(isFramableOrigin("https://example.com")).toBe(false);
    expect(isFramableOrigin("javascript:alert(1)")).toBe(false);
    expect(isFramableOrigin("nope")).toBe(false);
  });
});

describe("isAllowedHost — DNS-rebinding defense", () => {
  it("accepts loopback names (with/without port, IPv6 bracketed)", () => {
    expect(isAllowedHost("127.0.0.1:54123")).toBe(true);
    expect(isAllowedHost("127.0.0.1")).toBe(true);
    expect(isAllowedHost("localhost:8080")).toBe(true);
    expect(isAllowedHost("LOCALHOST")).toBe(true); // case-insensitive
    expect(isAllowedHost("[::1]:54123")).toBe(true);
    expect(isAllowedHost("[::1]")).toBe(true);
  });

  it("refuses a foreign or absent Host (the rebinding vector)", () => {
    expect(isAllowedHost("evil.attacker.com")).toBe(false);
    expect(isAllowedHost("evil.attacker.com:54123")).toBe(false);
    expect(isAllowedHost("127.0.0.1.evil.com")).toBe(false); // suffix trick
    expect(isAllowedHost("[bad")).toBe(false); // malformed IPv6
    expect(isAllowedHost("::1")).toBe(false); // bare unbracketed IPv6 is not a valid Host form
    expect(isAllowedHost("")).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });
});

describe("isAllowedMutationOrigin — CSRF defense for POST /api/sync", () => {
  it("trusts Sec-Fetch-Site over everything", () => {
    expect(isAllowedMutationOrigin("same-origin", undefined)).toBe(true);
    expect(isAllowedMutationOrigin("same-site", undefined)).toBe(true);
    expect(isAllowedMutationOrigin("none", undefined)).toBe(true); // user-initiated (address bar)
    expect(isAllowedMutationOrigin("cross-site", "http://127.0.0.1:1/")).toBe(false); // rejected even w/ loopback Origin
  });

  it("falls back to Origin host when Sec-Fetch-Site is absent", () => {
    expect(isAllowedMutationOrigin(undefined, "http://127.0.0.1:54123")).toBe(true);
    expect(isAllowedMutationOrigin(undefined, "http://localhost:54123")).toBe(true);
    expect(isAllowedMutationOrigin(undefined, "https://evil.attacker.com")).toBe(false);
    expect(isAllowedMutationOrigin(undefined, "not-a-url")).toBe(false);
  });

  it("allows a non-browser client (no fetch metadata at all)", () => {
    expect(isAllowedMutationOrigin(undefined, undefined)).toBe(true);
  });
});
