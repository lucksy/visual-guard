import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { openDb, SCHEMA_VERSION, type DB } from "../scripts/lib/studio/db";
import {
  appendSnapshot,
  recomputeStatus,
  recordComparison,
  recordUsage,
  upsertComponent,
  upsertVariant,
} from "../scripts/lib/studio/store";
import { createStudioServer } from "../scripts/studio/server";

/**
 * P3 integration gate (SPEC §10 / PLAN P3 exit criteria): boot `createStudioServer` over a seeded temp
 * DB, hit every route, and assert JSON shapes + real PNG bytes + `image/png` + ETag/304 + the CSP header,
 * 127.0.0.1-only binding, a crafted `..` image path refused, and the `POST /api/sync` single-flight 409.
 * Needs no browser (better-sqlite3 + sharp are bundled), so it runs in the normal vitest gate.
 */

let tmp = "";
let db: DB;
let server: Server;
let base = "";
let figmaSnapId = 0;
let currentSnapId = 0;
let escapeSnapId = 0;
let symlinkSnapId = 0;
let port = 0;
let figmaHash = "";
let figmaBytes: Buffer;
let compAId = 0;
let compBId = 0;

// Synchronization for the single-flight test: onSync blocks on `gate` until released.
let syncCalls = 0;
let releaseSync: () => void = () => {};
const gate = new Promise<void>((resolve) => {
  releaseSync = resolve;
});

// Node types `Response.json()` as `Promise<unknown>`; these tests assert over known API shapes, so
// read JSON loosely for terse access. (Test-only — the production code stays `any`-free.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic API JSON in a test helper
async function j(res: Response): Promise<any> {
  return res.json();
}

const put = (rel: string, bytes: Buffer): string => {
  const abs = join(tmp, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  return rel;
};
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Low-level HTTP request — needed because undici's `fetch` forbids setting `Host` and `Sec-Fetch-*`
 * headers, which the DNS-rebinding + CSRF guards key on. Always connects to 127.0.0.1:<port>.
 */
function raw(path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}${path}`);
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: Number(u.port),
        path: u.pathname + u.search,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
        setHost: opts.headers?.Host === undefined && opts.headers?.host === undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "vg-server-"));
  db = openDb(join(tmp, ".visual-guard", "studio.db"));

  // Real PNGs under the two servable roots.
  figmaBytes = await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();
  figmaHash = sha(figmaBytes);
  const figmaRel = put(".visual-baselines/.figma/F/1-2/default@0.png", figmaBytes);

  const currentBytes = await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const currentRel = put(`.visual-guard/cache/blobs/${sha(currentBytes)}.png`, currentBytes);

  // A secret OUTSIDE both roots — the crafted `..` snapshot points here and must be refused.
  writeFileSync(join(tmp, "secret.txt"), "TOP SECRET");
  // A symlink that is LEXICALLY inside .visual-baselines/ but points at the out-of-tree secret — the
  // realpath confinement (not the lexical guard) must catch this one at the HTTP layer.
  symlinkSync(join(tmp, "secret.txt"), join(tmp, ".visual-baselines", "escape.png"));

  // Component A: figma-linked, with a code variant + figma/current snapshots + a regression verdict.
  compAId = upsertComponent(db, {
    key: "buttons/primary",
    name: "Primary",
    figmaFileKey: "F",
    figmaNodeId: "1:2",
    codeInstance: "inst",
    codeTarget: "Primary",
  });
  const vCode = upsertVariant(db, { componentId: compAId, source: "code", name: "default@1280" });
  upsertVariant(db, { componentId: compAId, source: "figma", name: "default@0" });
  const figmaSnap = appendSnapshot(db, {
    componentId: compAId,
    source: "figma",
    imagePath: figmaRel,
    imageHash: figmaHash,
    width: 4,
    height: 4,
    approved: true,
  });
  figmaSnapId = figmaSnap.id;
  const baseSnap = appendSnapshot(db, {
    componentId: compAId,
    variantId: vCode,
    source: "code",
    imagePath: ".visual-baselines/inst/Primary/default@1280.png",
    imageHash: "basehash",
    approved: true,
  });
  const curSnap = appendSnapshot(db, {
    componentId: compAId,
    variantId: vCode,
    source: "current",
    imagePath: currentRel,
    imageHash: sha(currentBytes),
    width: 4,
    height: 4,
  });
  currentSnapId = curSnap.id;
  recordComparison(db, {
    componentId: compAId,
    axis: "current_vs_baseline",
    fromSnapshot: baseSnap.id,
    toSnapshot: curSnap.id,
    diffRatio: 0.5,
    status: "regression",
  });
  recomputeStatus(db, compAId);
  // Two "Used in" story usages so the detail endpoint's usages field has content to assert.
  recordUsage(db, { componentId: compAId, kind: "story", usedIn: "hover", detail: "inst" });
  recordUsage(db, { componentId: compAId, kind: "story", usedIn: "default", detail: "inst" });

  // Component B: minimal, no figma link, no snapshots → for list filtering + 'unknown' status.
  compBId = upsertComponent(db, { key: "cards/info", name: "Info" });

  // A snapshot whose stored path escapes the roots (simulating a poisoned figma_meta / DB row).
  const escapeSnap = appendSnapshot(db, {
    componentId: compBId,
    source: "current",
    imagePath: "../secret.txt",
    imageHash: "evil",
  });
  escapeSnapId = escapeSnap.id;

  // Lexically-clean path under .visual-baselines/, but it's a symlink to the out-of-tree secret.
  const symlinkSnap = appendSnapshot(db, {
    componentId: compBId,
    source: "current",
    imagePath: ".visual-baselines/escape.png",
    imageHash: "symlink-evil",
  });
  symlinkSnapId = symlinkSnap.id;

  server = createStudioServer({
    db,
    projectRoot: tmp,
    baselineDir: join(tmp, ".visual-baselines"),
    diffThreshold: 0.1,
    diffCacheDir: join(tmp, ".visual-guard", "cache", "diffs"),
    publicDir: join(tmp, "no-public-dir"), // absent → built-in shell
    schemaVersion: SCHEMA_VERSION,
    onSync: async () => {
      syncCalls += 1;
      await gate;
      return { synced: syncCalls };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  expect(addr.address).toBe("127.0.0.1"); // loopback-only binding (SPEC §10)
  port = addr.port;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  releaseSync();
  server?.close();
  db?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/health", () => {
  it("reports ok + schema version + counts, under the CSP", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY"); // clickjacking guard
    expect(res.headers.get("referrer-policy")).toBe("no-referrer"); // no-external-leak posture
    expect(res.headers.get("cache-control")).toBe("no-store"); // live API data is never cached
    const body = await j(res);
    expect(body.status).toBe("ok");
    expect(body.schemaVersion).toBe(SCHEMA_VERSION);
    expect(body.counts.components).toBe(2);
    expect(body.counts.snapshots).toBeGreaterThanOrEqual(4);
  });
});

describe("GET /api/components", () => {
  it("lists all, filters by status, and by substring q", async () => {
    const all = await j(await fetch(`${base}/api/components`));
    expect(all.components.map((c: { key: string }) => c.key)).toEqual([
      "buttons/primary",
      "cards/info",
    ]);

    const regressed = await j(await fetch(`${base}/api/components?status=regression`));
    expect(regressed.components.map((c: { key: string }) => c.key)).toEqual(["buttons/primary"]);

    const q = await j(await fetch(`${base}/api/components?q=card`));
    expect(q.components.map((c: { key: string }) => c.key)).toEqual(["cards/info"]);
  });

  it("400s an unknown status filter", async () => {
    const res = await fetch(`${base}/api/components?status=bogus`);
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe("bad_request");
  });

  it("carries each card's thumbnail ids + variant count (no per-card detail fetch needed)", async () => {
    const all = await j(await fetch(`${base}/api/components`));
    const primary = all.components.find((c: { key: string }) => c.key === "buttons/primary");
    // The list payload includes the enriched thumbnail fields so the gallery renders without an N+1.
    expect(primary).toHaveProperty("figma_snapshot_id");
    expect(primary).toHaveProperty("code_snapshot_id");
    expect(typeof primary.variant_count).toBe("number");
  });

  it("400s a q over the length cap, but accepts one at the boundary", async () => {
    const tooLong = await fetch(`${base}/api/components?q=${"a".repeat(257)}`);
    expect(tooLong.status).toBe(400);
    expect((await j(tooLong)).error.code).toBe("bad_request");
    const atCap = await fetch(`${base}/api/components?q=${"a".repeat(256)}`);
    expect(atCap.status).toBe(200); // 256 is allowed; 257 is not
  });
});

describe("GET /api/components/:id (+ history, variants)", () => {
  it("returns component + variants + latest-per-source", async () => {
    const res = await fetch(`${base}/api/components/${compAId}`);
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.component.key).toBe("buttons/primary");
    expect(body.variants.length).toBe(2); // a code + a figma variant
    expect(body.latest.figma.image_hash).toBe(figmaHash);
    expect(body.latest.code.image_path).toContain(".visual-baselines/");
    expect(body.latest.current).not.toBeNull();
    // The "Used in" usages are wired into the detail response, ordered kind then used_in.
    expect(body.usages).toEqual([
      { kind: "story", used_in: "default", detail: "inst" },
      { kind: "story", used_in: "hover", detail: "inst" },
    ]);
    // P6: the latest comparison per axis is now surfaced — the engine-computed pixel-diff magnitude.
    expect(body.comparisons.code.diff_ratio).toBeCloseTo(0.5);
    expect(body.comparisons.code.status).toBe("regression");
    expect(body.comparisons.parity).toBeNull(); // no figma_vs_code comparison was recorded
    // v5 (F4): the advisory variant-axis diff is surfaced, and reading it never moves the code axis.
    expect(["aligned", "minor", "divergent", "unknown"]).toContain(body.axisDiff.level);
    expect(body.component.status).toBe("regression"); // unchanged by the advisory axisDiff read
  });

  it("history can be scoped by source", async () => {
    const all = await j(await fetch(`${base}/api/components/${compAId}/history`));
    expect(all.history.length).toBeGreaterThanOrEqual(3);
    const figmaOnly = await j(
      await fetch(`${base}/api/components/${compAId}/history?source=figma`),
    );
    expect(figmaOnly.history.every((s: { source: string }) => s.source === "figma")).toBe(true);
  });

  it("400s a bad history source and 404s a missing component", async () => {
    expect((await fetch(`${base}/api/components/${compAId}/history?source=nope`)).status).toBe(400);
    expect((await fetch(`${base}/api/components/999999`)).status).toBe(404);
    expect((await fetch(`${base}/api/components/999999/variants`)).status).toBe(404);
  });

  it("variants endpoint returns just the variants array", async () => {
    const body = await j(await fetch(`${base}/api/components/${compAId}/variants`));
    expect(body.variants.length).toBe(2);
  });
});

describe("GET /api/snapshots/:id (+ image)", () => {
  it("returns the snapshot row", async () => {
    const body = await j(await fetch(`${base}/api/snapshots/${figmaSnapId}`));
    expect(body.snapshot.id).toBe(figmaSnapId);
    expect(body.snapshot.source).toBe("figma");
  });

  it("streams the real PNG bytes with image/png, an immutable cache, and an ETag", async () => {
    const res = await fetch(`${base}/api/snapshots/${figmaSnapId}/image`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const etag = res.headers.get("etag");
    expect(etag).toBe(`"${figmaHash}"`);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(figmaBytes)).toBe(true); // exactly the file on disk
  });

  it("honors If-None-Match with a 304 (no body)", async () => {
    const res = await fetch(`${base}/api/snapshots/${figmaSnapId}/image`, {
      headers: { "If-None-Match": `"${figmaHash}"` },
    });
    expect(res.status).toBe(304);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("404s the image of a snapshot whose stored path escapes the roots (the .. guard)", async () => {
    // Defense-in-depth proof: the file (secret.txt) really exists, but it is out of bounds.
    expect(readFileSync(join(tmp, "secret.txt"), "utf8")).toBe("TOP SECRET");
    const res = await fetch(`${base}/api/snapshots/${escapeSnapId}/image`);
    expect(res.status).toBe(404);
    expect((await j(res)).error.code).toBe("image_unavailable");
  });

  it("404s a lexically-clean path that is a SYMLINK out of the tree (realpath guard at the HTTP layer)", async () => {
    // `.visual-baselines/escape.png` passes the lexical guard but symlinks to the out-of-tree secret.
    // This proves realpath—not just lexical—confinement is wired into the server, not only the unit test.
    const res = await fetch(`${base}/api/snapshots/${symlinkSnapId}/image`);
    expect(res.status).toBe(404);
    const text = await res.text(); // read the body once
    expect(JSON.parse(text).error.code).toBe("image_unavailable");
    expect(text).not.toContain("TOP SECRET"); // the secret bytes are never streamed
  });

  it("404s a missing snapshot id", async () => {
    expect((await fetch(`${base}/api/snapshots/999999`)).status).toBe(404);
    expect((await fetch(`${base}/api/snapshots/999999/image`)).status).toBe(404);
  });
});

describe("GET /api/summary (P6 health rollup)", () => {
  it("returns bucketed counts over status, sync state, and presence", async () => {
    const res = await fetch(`${base}/api/summary`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await j(res);
    expect(body.summary.total).toBeGreaterThanOrEqual(2);
    // compA is figma+code; compB is neither-linked.
    expect(body.summary.presence.both).toBeGreaterThanOrEqual(1);
    expect(typeof body.summary.byStatus.regression).toBe("number");
    expect(typeof body.summary.bySyncState.synced).toBe("number");
    // F5: the "new since last sync" delta rides alongside the rollup.
    expect(body.delta).toMatchObject({ newFigma: [], newCode: [], removedFigma: [], removedCode: [] });
    expect(typeof body.summary.byLifecycle.matched).toBe("number");
  });
});

describe("GET /api/drift (F5 advisory drift report)", () => {
  it("returns the aggregate drift report and is method-aware", async () => {
    const res = await fetch(`${base}/api/drift`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await j(res);
    expect(Array.isArray(body.drift.removed)).toBe(true);
    expect(Array.isArray(body.drift.stale)).toBe(true);
    expect(typeof body.drift.matched).toBe("number");
    expect(body.drift.delta).toMatchObject({ newFigma: [], newCode: [] });
    // POST is 405 (read-only endpoint)
    expect((await fetch(`${base}/api/drift`, { method: "POST" })).status).toBe(405);
  });
});

describe("GET /api/components/:id/regressions (P6 drift history)", () => {
  it("returns the axis history and validates the axis param", async () => {
    const body = await j(await fetch(`${base}/api/components/${compAId}/regressions`));
    expect(body.axis).toBe("current_vs_baseline");
    expect(body.regressions.length).toBeGreaterThanOrEqual(1);
    expect(body.regressions[0].diff_ratio).toBeCloseTo(0.5);

    // An explicit valid axis with no rows → empty list, not an error.
    const parity = await j(await fetch(`${base}/api/components/${compAId}/regressions?axis=figma_vs_code`));
    expect(parity.regressions).toEqual([]);

    // A bad axis → 400; a missing component → 404.
    expect((await fetch(`${base}/api/components/${compAId}/regressions?axis=nope`)).status).toBe(400);
    expect((await fetch(`${base}/api/components/999999/regressions`)).status).toBe(404);
  });
});

describe("GET /api/diff (P6 pixel-diff overlay)", () => {
  it("streams a real PNG diff overlay, caches it, and honors ETag/304", async () => {
    const res = await fetch(`${base}/api/diff?from=${figmaSnapId}&to=${currentSnapId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const bytes = Buffer.from(await res.arrayBuffer());
    // PNG magic — proves it's a real generated image, not JSON/an error body.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // The overlay was cached content-addressed under diffCacheDir.
    const cached = readdirSync(join(tmp, ".visual-guard", "cache", "diffs"));
    expect(cached.some((f) => f.endsWith(".png"))).toBe(true);

    // A conditional re-request (served from the cache + ETag) is a 304 with no body.
    const again = await fetch(`${base}/api/diff?from=${figmaSnapId}&to=${currentSnapId}`, {
      headers: { "If-None-Match": etag! },
    });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
  });

  it("400s bad params, 404s a missing snapshot, 404s an out-of-bounds source image", async () => {
    expect((await fetch(`${base}/api/diff?from=abc&to=${figmaSnapId}`)).status).toBe(400);
    expect((await fetch(`${base}/api/diff?from=${figmaSnapId}`)).status).toBe(400); // missing `to`
    expect((await fetch(`${base}/api/diff?from=999999&to=${figmaSnapId}`)).status).toBe(404);
    // `escapeSnapId` has a path that escapes the image roots → its image is unavailable for diffing.
    const oob = await fetch(`${base}/api/diff?from=${escapeSnapId}&to=${figmaSnapId}`);
    expect(oob.status).toBe(404);
    expect((await j(oob)).error.code).toBe("image_unavailable");
  });
});

describe("POST /api/snapshots/:id/approve (P6 approve as baseline)", () => {
  it("refuses a cross-site approve (CSRF guard) and a wrong-verb GET (405)", async () => {
    const cross = await raw(`/api/snapshots/${figmaSnapId}/approve`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(cross.status).toBe(403);
    expect(JSON.parse(cross.body.toString()).error.code).toBe("forbidden");

    const wrongVerb = await fetch(`${base}/api/snapshots/${figmaSnapId}/approve`);
    expect(wrongVerb.status).toBe(405);
  });

  it("rejects approving a Figma snapshot (not a code baseline) with a same-origin request", async () => {
    const res = await raw(`/api/snapshots/${figmaSnapId}/approve`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body.toString()).error.code).toBe("not_approvable");
  });

  // NOTE: this mutates compA (promotes its current render → baseline), so it runs AFTER the read tests
  // above that assert compA's regression state.
  it("promotes the current render to a committed baseline and clears the regression", async () => {
    const detail = await j(await fetch(`${base}/api/components/${compAId}`));
    const currentId = detail.latest.current.id;
    const res = await raw(`/api/snapshots/${currentId}/approve`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString());
    expect(body.ok).toBe(true);
    expect(body.promoted).toBe(true);
    expect(body.key).toBe("inst/Primary/default@1280.png");
    // The committed PNG was written into the baseline dir.
    expect(readFileSync(join(tmp, ".visual-baselines", "inst", "Primary", "default@1280.png")).length).toBeGreaterThan(0);
    // The component now reads `same` (the regression cleared) on a fresh detail fetch.
    const after = await j(await fetch(`${base}/api/components/${compAId}`));
    expect(after.component.status).toBe("same");
    // The promoted baseline's image must actually SERVE (the stored path is project-relative + confined),
    // not just exist on disk — a regression guard for the absolute-path 404.
    const newBaselineId = after.latest.code.id;
    const img = await fetch(`${base}/api/snapshots/${newBaselineId}/image`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
  });
});

describe("static shell + method/notfound contract", () => {
  it("serves the built-in shell at / under the CSP when no public/ exists", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toContain("Component Studio");
  });

  it("405s a wrong method and 404s an unknown api path", async () => {
    const wrong = await fetch(`${base}/api/health`, { method: "POST" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it("405s GET /api/sync with Allow: POST, and a non-GET static path with Allow: GET", async () => {
    const sync = await fetch(`${base}/api/sync`); // GET on a POST-only route
    expect(sync.status).toBe(405);
    expect(sync.headers.get("allow")).toBe("POST");
    const stat = await fetch(`${base}/`, { method: "PUT" }); // non-GET on a static path
    expect(stat.status).toBe(405);
    expect(stat.headers.get("allow")).toBe("GET");
  });
});

describe("DNS-rebinding defense (Host allowlist)", () => {
  it("answers loopback Host names and 403s a foreign Host", async () => {
    const ok = await raw("/api/health", { headers: { Host: `127.0.0.1:${port}` } });
    expect(ok.status).toBe(200);
    const localhost = await raw("/api/health", { headers: { Host: `localhost:${port}` } });
    expect(localhost.status).toBe(200);

    const evil = await raw("/api/health", { headers: { Host: "evil.attacker.com" } });
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body.toString("utf8")).error.code).toBe("forbidden");

    // A foreign Host must not even reach the image stream.
    const evilImg = await raw(`/api/snapshots/${figmaSnapId}/image`, {
      headers: { Host: "evil.attacker.com" },
    });
    expect(evilImg.status).toBe(403);
  });
});

describe("CSRF defense for POST /api/sync", () => {
  it("403s a cross-site mutation WITHOUT invoking onSync", async () => {
    expect(syncCalls).toBe(0); // not yet released/triggered by the single-flight test below
    const res = await raw("/api/sync", {
      method: "POST",
      headers: { Host: `127.0.0.1:${port}`, "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body.toString("utf8")).error.code).toBe("forbidden");
    expect(syncCalls).toBe(0); // the engine was never driven by the cross-site request
  });
});

describe("POST /api/sync — single-flight", () => {
  it("rejects a concurrent sync with 409, then completes the first with the summary", async () => {
    const first = fetch(`${base}/api/sync`, { method: "POST" });
    // Wait until onSync has entered (so syncInFlight is set) before firing the second.
    for (let i = 0; i < 200 && syncCalls < 1; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(syncCalls).toBe(1);

    const second = await fetch(`${base}/api/sync`, { method: "POST" });
    expect(second.status).toBe(409);
    expect((await j(second)).error.code).toBe("sync_in_progress");

    releaseSync(); // let the first finish
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    const body = await j(firstRes);
    expect(body.ok).toBe(true);
    expect(body.summary).toEqual({ synced: 1 });
    expect(syncCalls).toBe(1); // the 409'd request never invoked onSync
  });
});

describe("POST /api/sync — failure (500) + in-flight reset (dedicated server)", () => {
  let s: Server;
  let sdb: DB;
  let b = "";
  let mode: "ok" | "fail" = "fail";
  let calls = 0;

  beforeAll(async () => {
    sdb = openDb(":memory:"); // the stubbed onSync doesn't touch it; an empty DB is fine
    s = createStudioServer({
      db: sdb,
      projectRoot: tmp,
      baselineDir: join(tmp, ".visual-baselines"),
      publicDir: join(tmp, "no-public-dir"),
      schemaVersion: SCHEMA_VERSION,
      onSync: async () => {
        calls += 1;
        if (mode === "fail") {
          throw new Error("boom from the engine");
        }
        return { ok: calls };
      },
    });
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    s?.close();
    sdb?.close();
  });

  it("returns 500 sync_failed when onSync throws, then a later sync succeeds (latch reset)", async () => {
    // 1) A failing sync → 500 with the sync_failed code (the catch branch).
    const failed = await fetch(`${b}/api/sync`, { method: "POST" });
    expect(failed.status).toBe(500);
    const failBody = await j(failed);
    expect(failBody.error.code).toBe("sync_failed");
    expect(failBody.error.message).toContain("boom from the engine");
    expect(calls).toBe(1);

    // 2) The `finally` must have reset syncInFlight — a subsequent sync runs (not permanently 409-locked).
    mode = "ok";
    const okRes = await fetch(`${b}/api/sync`, { method: "POST" });
    expect(okRes.status).toBe(200);
    expect((await j(okRes)).summary).toEqual({ ok: 2 });
    expect(calls).toBe(2);
  });
});

describe("unexpected handler error → generic internal_error (no detail leak)", () => {
  let s: Server;
  let b = "";

  beforeAll(async () => {
    // A poisoned DB whose every query throws — drives a read route into the top-level catch. The thrown
    // message embeds a fake host path to prove the handler does NOT echo exception detail to the client.
    const poison = {
      prepare() {
        throw new Error("boom at /Users/secret/internal/path");
      },
    } as unknown as DB;
    s = createStudioServer({
      db: poison,
      projectRoot: tmp,
      baselineDir: join(tmp, ".visual-baselines"),
      publicDir: join(tmp, "no-public-dir"),
      schemaVersion: SCHEMA_VERSION,
      onSync: async () => ({}),
    });
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    s?.close();
  });

  it("returns 500 internal_error with a generic body that leaks no exception detail", async () => {
    const res = await fetch(`${b}/api/health`);
    expect(res.status).toBe(500);
    const body = await j(res);
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("internal server error.");
    const text = JSON.stringify(body);
    expect(text).not.toContain("boom");
    expect(text).not.toContain("/Users/secret");
  });
});
