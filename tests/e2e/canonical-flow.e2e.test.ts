import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, type Config } from "../../scripts/lib/config";
import { captureAll } from "../../scripts/capture";
import { compareRun } from "../../scripts/compare";
import { runBaseline } from "../../scripts/baseline";
import { report } from "../../scripts/report";

/**
 * CP5 — the canonical flow, end-to-end on the bundled sample project (T-12). Drives the real
 * engine (capture → compare → report → baseline) through the lifecycle the `/visual-check` and
 * `/visual-baseline` commands orchestrate, asserting the three success criteria:
 *
 *   1. unchanged code → 0 regressions,
 *   2. a deliberate change → surfaced as `fail` and tied to the changed source file,
 *   3. approve the change → re-run → clean.
 *
 * Real Chromium, so it is opt-in (VG_E2E=1), matching capture.e2e.test.ts.
 */
const E2E = process.env.VG_E2E === "1";

const here = dirname(fileURLToPath(import.meta.url));
const sampleDir = join(here, "sample");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

describe.skipIf(!E2E)("canonical flow — CP5 (real Chromium)", () => {
  let server: Server;
  let port = 0;
  let workDir = ""; // a temp copy of the sample we can mutate + git-track
  let outRoot = ""; // .visual-guard run artifacts (temp)
  let baselineDir = ""; // the committed-baselines stand-in (temp)

  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      ["-c", "user.email=vg@example.com", "-c", "user.name=Visual Guard", "-C", workDir, ...args],
      { encoding: "utf8" },
    );

  // The same git-backed changed-file gatherer report.ts uses, scoped to the sample repo.
  const listChangedFiles = (): string[] => {
    const run = (args: string[]): string[] => {
      try {
        return execFileSync("git", ["-C", workDir, ...args], { encoding: "utf8" }).split("\n");
      } catch {
        return [];
      }
    };
    return [
      ...run(["diff", "--name-only", "HEAD"]),
      ...run(["ls-files", "--others", "--exclude-standard"]),
    ]
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };

  let config: Config;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "vg-sample-"));
    cpSync(sampleDir, workDir, { recursive: true });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "sample: initial baseline state");

    outRoot = mkdtempSync(join(tmpdir(), "vg-runs-"));
    baselineDir = mkdtempSync(join(tmpdir(), "vg-baselines-"));

    server = createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0]!;
      // "/" and "/button" (the configured route) both render the component demo.
      const rel = url === "/" || url === "/button" ? "/index.html" : url;
      const filePath = join(workDir, normalize(rel));
      // Containment: never serve outside the sample dir.
      if (!filePath.startsWith(workDir)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        const body = readFileSync(filePath);
        res.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
          // The stylesheet URL is stable across runs; without this Chromium serves the edited
          // CSS from its HTTP cache and the deliberate change would never reach the capture.
          "cache-control": "no-store, no-cache, must-revalidate",
        });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;

    const raw = JSON.parse(readFileSync(join(workDir, "visual.config.json"), "utf8"));
    raw.targets[0].url = `http://127.0.0.1:${port}`;
    config = parseConfig(raw);
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const dir of [workDir, outRoot, baselineDir]) {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  const key = "sample/button/default@400.png";

  it("runs the full unchanged → approve → change → fail → approve → clean lifecycle", async () => {
    // 1) First run: no baseline yet → the render is `new` (audit-only, not a regression).
    const r1 = await captureAll(config, { runId: "r1", outRoot });
    expect(r1.written).toContain(key);
    const c1 = await compareRun(config, { runId: "r1", outRoot, baselineDir });
    expect(c1.summary).toMatchObject({ total: 1, added: 1, failed: 0, passed: 0 });

    const m1 = report(config, { runId: "r1", outRoot }, { listChangedFiles: () => [], now: () => new Date(0) });
    expect(m1.manifest.targets[0]).toMatchObject({ instance: "sample", target: "button", status: "new" });

    // 2) Approve the first render as the baseline (the sign-off).
    const approved = runBaseline(config, { runId: "r1", outRoot, baselineDir });
    expect(approved.written).toContain(key);

    // 3) Unchanged re-run → 0 regressions (CRITERION 1).
    await captureAll(config, { runId: "r2", outRoot });
    const c2 = await compareRun(config, { runId: "r2", outRoot, baselineDir });
    expect(c2.summary).toMatchObject({ total: 1, passed: 1, failed: 0, added: 0 });

    // 4) A deliberate change: replace the spacing token with a hardcoded, larger padding
    //    (the SPEC's canonical regression — it grows the button's height).
    const cssPath = join(workDir, "src", "Button.css");
    const before = readFileSync(cssPath, "utf8");
    const after = before.replace("padding: var(--vg-space-pad);", "padding: 48px 40px;");
    expect(after).not.toBe(before); // guard against a silently-missed replacement
    writeFileSync(cssPath, after); // left uncommitted, so `git diff HEAD` surfaces it

    // 5) The change is surfaced as a regression, tied to the changed source file (CRITERION 2).
    await captureAll(config, { runId: "r3", outRoot });
    const c3 = await compareRun(config, { runId: "r3", outRoot, baselineDir });
    expect(c3.summary.failed).toBe(1);
    const failed = c3.results.find((entry) => entry.key === key);
    expect(failed?.status).toBe("fail");
    expect(failed?.ratio ?? 0).toBeGreaterThan(config.maxDiffRatio); // well over the gate

    const m3 = report(config, { runId: "r3", outRoot }, { listChangedFiles, now: () => new Date(0) });
    const buttonTarget = m3.manifest.targets.find((t) => t.target === "button");
    expect(buttonTarget?.status).toBe("fail");
    expect(buttonTarget?.changedFiles).toContain("src/Button.css");
    expect(m3.manifest.changedFiles).toContain("src/Button.css");

    // 6) Approve the change (explicit overwrite + confirmation), then re-run → clean (CRITERION 3).
    const reapproved = runBaseline(config, {
      runId: "r3",
      outRoot,
      baselineDir,
      target: "button",
      overwrite: true,
      confirmed: true,
    });
    expect(reapproved.written).toContain(key);

    await captureAll(config, { runId: "r4", outRoot });
    const c4 = await compareRun(config, { runId: "r4", outRoot, baselineDir });
    expect(c4.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
  }, 120_000);
});
