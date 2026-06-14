import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, type Config } from "../../scripts/lib/config";
import { captureAll } from "../../scripts/capture";
import { compareRun } from "../../scripts/compare";
import { runBaseline } from "../../scripts/baseline";
import { report } from "../../scripts/report";
import { runGate } from "../../scripts/ci";
import { writePrComment } from "../../scripts/pr-report";

/**
 * CP7 — the Phase-2 exit, end-to-end on the bundled sample (T-26). It proves Visual Guard can gate a
 * CI pipeline and produce a PR report off the deterministic engine:
 *
 *   1. an UNAPPROVED render (`new`, no baseline) BLOCKS the strict gate (exit 1) but passes with
 *      `--allow-new` — the SPEC "exit non-zero on unapproved regressions",
 *   2. once approved, an unchanged re-run is CLEAN (exit 0) and the PR report says "0 regressions",
 *   3. a real Button geometry regression BLOCKS the gate (exit 1) and the generated PR-comment
 *      Markdown cites the flagged target with evidence.
 *
 * Real Chromium, so opt-in (`VG_E2E=1`). Mirrors review-flow.e2e's sample harness.
 */
const E2E = process.env.VG_E2E === "1";

const here = dirname(fileURLToPath(import.meta.url));
const sampleDir = join(here, "sample");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const strict = { allowNew: false, allowError: false };

describe.skipIf(!E2E)("ci flow — CP7 (real Chromium)", () => {
  let server: Server;
  let port = 0;
  let workDir = "";
  let outRoot = "";
  let baselineDir = "";

  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      ["-c", "user.email=vg@example.com", "-c", "user.name=Visual Guard", "-C", workDir, ...args],
      { encoding: "utf8" },
    );

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

  const reportDeps = { listChangedFiles, now: (): Date => new Date(0) };
  let config: Config;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "vg-ci-sample-"));
    cpSync(sampleDir, workDir, { recursive: true });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "sample: initial 2-component baseline state");

    outRoot = mkdtempSync(join(tmpdir(), "vg-ci-runs-"));
    baselineDir = mkdtempSync(join(tmpdir(), "vg-ci-baselines-"));

    server = createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0]!;
      const rel =
        url === "/" || url === "/button" ? "/index.html" : url === "/badge" ? "/badge.html" : url;
      const filePath = join(workDir, normalize(rel));
      if (!filePath.startsWith(workDir)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        const body = readFileSync(filePath);
        res.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
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

    config = parseConfig({
      detect: "auto",
      targets: [
        { type: "app", name: "sample", url: `http://127.0.0.1:${port}`, routes: ["/button", "/badge"] },
      ],
      viewports: [400],
      states: ["default"],
      threshold: 0.1,
      maxDiffRatio: 0.01,
      baselineDir,
      tokens: { source: "src/Button.css" },
    });
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

  it("gates an unapproved regression non-zero and generates a PR report", async () => {
    // 1) First run: no baseline → both targets `new`. Strict gate BLOCKS; --allow-new passes.
    await captureAll(config, { runId: "r1", outRoot });
    await compareRun(config, { runId: "r1", outRoot, baselineDir });
    report(config, { runId: "r1", outRoot }, reportDeps);

    const newStrict = runGate({ runId: "r1", outRoot, policy: strict });
    expect(newStrict.ok).toBe(false);
    expect(newStrict.exitCode).toBe(1); // unapproved renders block CI
    const newAllowed = runGate({ runId: "r1", outRoot, policy: { allowNew: true, allowError: false } });
    expect(newAllowed.ok).toBe(true);
    expect(newAllowed.exitCode).toBe(0);

    // 2) Approve both as baseline; an unchanged re-run is CLEAN and the PR report says so.
    runBaseline(config, { runId: "r1", outRoot, baselineDir });
    await captureAll(config, { runId: "r2", outRoot });
    await compareRun(config, { runId: "r2", outRoot, baselineDir });
    report(config, { runId: "r2", outRoot }, reportDeps);

    const cleanGate = runGate({ runId: "r2", outRoot, policy: strict });
    expect(cleanGate.ok).toBe(true);
    expect(cleanGate.exitCode).toBe(0);
    const cleanPr = writePrComment({ runId: "r2", outRoot });
    expect(cleanPr.markdown).toContain("0 regressions");
    expect(cleanPr.markdown).toContain("match their baseline");

    // 3) Introduce a real geometry regression on the Button (spacing token → larger hardcoded padding).
    const buttonCss = join(workDir, "src", "Button.css");
    const before = readFileSync(buttonCss, "utf8");
    const after = before.replace("padding: var(--vg-space-pad);", "padding: 48px 40px;");
    expect(after).not.toBe(before);
    writeFileSync(buttonCss, after);

    await captureAll(config, { runId: "r3", outRoot });
    await compareRun(config, { runId: "r3", outRoot, baselineDir });
    report(config, { runId: "r3", outRoot }, reportDeps);

    const blocked = runGate({ runId: "r3", outRoot, policy: strict });
    expect(blocked.ok).toBe(false);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.blockingTargets.map((t) => t.target)).toContain("button");

    // The PR report cites the flagged target with evidence, and is written to the run dir.
    const pr = writePrComment({ runId: "r3", outRoot });
    expect(pr.markdown).toContain("BLOCKED");
    expect(pr.markdown).toContain("`sample/button`");
    expect(pr.markdown).toMatch(/ratio \*\*\d+\.\d+%\*\*/);
    expect(existsSync(join(outRoot, "runs", "r3", "pr-comment.md"))).toBe(true);
  }, 120_000);
});
