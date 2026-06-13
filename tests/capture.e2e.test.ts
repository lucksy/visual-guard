import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../scripts/lib/config";
import { captureAll } from "../scripts/capture";
import { diffImages } from "../scripts/lib/diff";

/**
 * CP3 — the determinism gate (R1) and the fail-fast probe (R2). Real Chromium, so it is
 * opt-in: set VG_E2E=1 and have the matching Playwright browser installed. Skipped in
 * environments without a browser (per SPEC Testing Strategy).
 */
const E2E = process.env.VG_E2E === "1";

// A fully static page: no animation, no web fonts, no time-based content → deterministic.
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  .box {
    width: 240px; height: 140px; margin: 24px;
    background: #3366cc; color: #ffffff;
    font-family: monospace; font-size: 16px; padding: 16px;
    box-sizing: border-box;
  }
</style></head><body><div class="box">Visual Guard determinism fixture</div></body></html>`;

// A page whose box fades/slides in over 3s on mount. Without the freeze-before-load fix,
// the two captures land at different animation frames; with it, both settle to the end state.
const ANIMATED_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  @keyframes reveal { from { opacity: 0; transform: translateY(60px) scale(0.8); }
                      to   { opacity: 1; transform: none; } }
  .box {
    width: 240px; height: 140px; margin: 24px;
    background: #cc3366; color: #ffffff;
    font-family: monospace; font-size: 16px; padding: 16px;
    box-sizing: border-box;
    animation: reveal 3s ease-in forwards;
  }
</style></head><body><div class="box">Visual Guard animated fixture</div></body></html>`;

describe.skipIf(!E2E)("capture.ts — CP3 determinism + R2 probe (real Chromium)", () => {
  let server: Server;
  let port = 0;
  let tmp = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = req.url && req.url.startsWith("/animated") ? ANIMATED_HTML : FIXTURE_HTML;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
    tmp = mkdtempSync(join(tmpdir(), "vg-e2e-"));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("captures the same page twice with a pixel-diff ratio of 0", async () => {
    const config = parseConfig({
      targets: [{ type: "app", name: "fixture", url: `http://127.0.0.1:${port}`, routes: ["/"] }],
      viewports: [400],
      states: ["default"],
    });

    const a = await captureAll(config, { runId: "A", outRoot: tmp });
    const b = await captureAll(config, { runId: "B", outRoot: tmp });

    const rel = "fixture/index/default@400.png";
    const imageA = readFileSync(join(a.currentDir, rel));
    const imageB = readFileSync(join(b.currentDir, rel));

    const result = await diffImages(imageA, imageB, 0.1);
    expect(result.dimensionDelta).toBeNull();
    expect(result.ratio).toBe(0);
  }, 60_000);

  it("captures an animated component deterministically (freeze before load → ratio 0)", async () => {
    const config = parseConfig({
      targets: [{ type: "app", name: "fixture", url: `http://127.0.0.1:${port}`, routes: ["/animated"] }],
      viewports: [400],
      states: ["default"],
    });

    const a = await captureAll(config, { runId: "ANIM-A", outRoot: tmp });
    const b = await captureAll(config, { runId: "ANIM-B", outRoot: tmp });

    const rel = "fixture/animated/default@400.png";
    const imageA = readFileSync(join(a.currentDir, rel));
    const imageB = readFileSync(join(b.currentDir, rel));

    const result = await diffImages(imageA, imageB, 0.1);
    expect(result.ratio).toBe(0);
  }, 60_000);

  it("fails fast with an actionable message when the dev server is down (R2)", async () => {
    const config = parseConfig({
      targets: [{ type: "app", name: "down", url: "http://127.0.0.1:1", routes: ["/"] }],
      viewports: [400],
      states: ["default"],
    });
    await expect(captureAll(config, { runId: "D", outRoot: tmp })).rejects.toThrow(/could not reach/);
  }, 30_000);
});
