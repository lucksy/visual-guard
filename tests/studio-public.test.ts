import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { CSP } from "../scripts/lib/studio/router";
import { createStudioServer } from "../scripts/studio/server";
import { openDb, SCHEMA_VERSION } from "../scripts/lib/studio/db";

/**
 * P4 SPA guardrails (SPEC §10/§11.5): the committed, zero-build app must make **zero external calls** —
 * every asset is same-origin and the CSP forbids off-origin script/connect. These are static assertions
 * over the committed files plus one live check that the P3 server actually serves the SPA.
 */

const PUBLIC = join(process.cwd(), "scripts", "studio", "public");
const read = (f: string): string => readFileSync(join(PUBLIC, f), "utf8");

describe("index.html — same-origin only, no inline code", () => {
  const html = read("index.html");

  it("references no off-origin asset (no http(s):// or protocol-relative //)", () => {
    expect(html).not.toMatch(/(?:href|src)\s*=\s*["'](?:https?:)?\/\//i);
  });

  it("loads JS only as a relative ES module, with no inline script body", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toMatch(/type="module"/);
      expect(tag).toMatch(/src="\.\//);
    }
    // No <script> element with an inline (non-empty) body.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i);
  });

  it("has no inline event handlers (CSP script-src 'self' would block them anyway)", () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
  });
});

describe("CSS + JS modules — same-origin only", () => {
  it("CSS pulls in no off-origin url()/@import", () => {
    for (const f of ["tokens.css", "app.css"]) {
      const css = read(f);
      expect(css).not.toMatch(/url\(\s*["']?https?:/i);
      expect(css).not.toMatch(/@import\s+["']?https?:/i);
    }
  });

  it("every JS module imports only relative specifiers and hardcodes no external fetch", () => {
    for (const f of ["app.js", "gallery.js", "detail.js", "api.js", "dom.js", "view-model.js"]) {
      const js = read(f);
      const specs = [...js.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const spec of specs) {
        expect(spec?.startsWith("./")).toBe(true); // relative only — no bare/CDN imports
      }
      expect(js).not.toMatch(/fetch\(\s*["']https?:/i);
    }
  });
});

describe("detail.js — ARIA slider correctness (lock the valmin/valmax typo regression)", () => {
  const detail = read("detail.js");
  it("the timeline slider uses valid aria-valuemin/aria-valuemax (never the misspelled aria-valmin)", () => {
    expect(detail).toContain("aria-valuemin");
    expect(detail).toContain("aria-valuemax");
    expect(detail).not.toMatch(/aria-valmin\b/); // the typo: missing the "ue"
    expect(detail).not.toMatch(/aria-valmax\b/);
  });
  it("supports Shift+arrow timeline navigation (SPEC §11.3)", () => {
    expect(detail).toMatch(/shiftKey/);
  });
});

describe("CSP forbids off-origin script/connect (no external calls possible)", () => {
  it("locks script-src / connect-src to 'self' with no wildcard", () => {
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("connect-src 'self'");
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).not.toContain("connect-src 'self' http");
    expect(CSP).not.toContain("*");
  });

  it("forbids framing via frame-ancestors 'none' (parity with X-Frame-Options: DENY)", () => {
    expect(CSP).toContain("frame-ancestors 'none'");
  });
});

describe("the P3 server serves the committed SPA", () => {
  let server: Server | undefined;
  const db = openDb(":memory:");
  afterAll(() => {
    server?.close();
    db.close();
  });

  it("returns index.html at / and the JS/CSS assets with correct content-types", async () => {
    server = createStudioServer({
      db,
      projectRoot: process.cwd(),
      publicDir: PUBLIC,
      schemaVersion: SCHEMA_VERSION,
      onSync: async () => ({}),
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    const html = await root.text();
    expect(html).toContain("Component Studio");
    expect(html).toContain('src="./app.js"');

    const appJs = await fetch(`${base}/app.js`);
    expect(appJs.status).toBe(200);
    expect(appJs.headers.get("content-type")).toContain("text/javascript");

    const vm = await fetch(`${base}/view-model.js`);
    expect(vm.status).toBe(200);

    const css = await fetch(`${base}/tokens.css`);
    expect(css.headers.get("content-type")).toContain("text/css");

    // A client-router deep link falls back to the app shell (SPA), not a 404.
    const deep = await fetch(`${base}/component/5`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get("content-type")).toContain("text/html");
  });

  it("still sends every hardening header on a 200 (set-if-absent refactor didn't drop any)", async () => {
    const srv = createStudioServer({
      db,
      projectRoot: process.cwd(),
      publicDir: PUBLIC,
      schemaVersion: SCHEMA_VERSION,
      onSync: async () => ({}),
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/api/health`);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    } finally {
      srv.close();
    }
  });

  it("widens the response CSP frame-src to the configured loopback harness origin (live preview)", async () => {
    const srv = createStudioServer({
      db,
      projectRoot: process.cwd(),
      publicDir: PUBLIC,
      schemaVersion: SCHEMA_VERSION,
      frameOrigins: ["http://localhost:61000"],
      onSync: async () => ({}),
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      const csp = (await fetch(`${base}/api/health`)).headers.get("content-security-policy") || "";
      expect(csp).toContain("frame-src 'self' http://localhost:61000");
      expect(csp).toContain("default-src 'self'"); // base policy still intact
    } finally {
      srv.close();
    }
  });
});
