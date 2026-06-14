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
import { report, applyVerdicts, type VerdictReport } from "../../scripts/report";
import { auditTokens } from "../../scripts/lib/tokens";

/**
 * CP6 — the Phase-1 exit, end-to-end on the bundled sample extended to TWO components (T-20). It
 * drives the deterministic engine across both components and proves the Phase-1 success criteria:
 *
 *   1. multi-component capture → compare → report flags the Button's pixel-visible geometry change,
 *   2. the Badge's **sub-threshold token drift** (the `--vg-brand` color inlined as its identical
 *      hex) is INVISIBLE to the luminance-normalized pixel diff (the Badge target passes) yet is
 *      CAUGHT by `auditTokens` — the SPEC criterion "flagged even when the pixels don't move",
 *   3. a structured reviewer verdict merges back into `manifest.json` (the /visual-check contract).
 *
 * The live `visual-reviewer`/`token-auditor` subagents and the `/visual-review` workflow are not
 * exercised here (they need the Claude runtime, not vitest) — their quality is a manual spot-check
 * per the SPEC, and the workflow's structure is pinned by tests/visual-review-template.test.ts.
 * This test proves the deterministic engine those AI layers consume. Real Chromium, so opt-in.
 */
const E2E = process.env.VG_E2E === "1";

const here = dirname(fileURLToPath(import.meta.url));
const sampleDir = join(here, "sample");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

describe.skipIf(!E2E)("review flow — CP6 (real Chromium)", () => {
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

  // The git-backed changed-file gatherer report.ts uses, scoped to the sample repo.
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

  // auditTokens reads source text relative to the work dir (config paths are project-relative).
  const tokenIo = { readFile: (p: string): string => readFileSync(join(workDir, p), "utf8") };

  let config: Config;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "vg-review-sample-"));
    cpSync(sampleDir, workDir, { recursive: true });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "sample: initial 2-component baseline state");

    outRoot = mkdtempSync(join(tmpdir(), "vg-review-runs-"));
    baselineDir = mkdtempSync(join(tmpdir(), "vg-review-baselines-"));

    server = createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0]!;
      // Map each route to its component's HTML; serve /src/*.css straight through.
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
          // Stable URLs across runs — without this Chromium serves the edited CSS from its cache.
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

    // review-flow's own two-route config (the bundled sample config is one-route, for CP5).
    config = parseConfig({
      detect: "auto",
      targets: [
        {
          type: "app",
          name: "sample",
          url: `http://127.0.0.1:${port}`,
          routes: ["/button", "/badge"],
        },
      ],
      viewports: [400],
      states: ["default"],
      threshold: 0.1,
      maxDiffRatio: 0.01,
      baselineDir,
      tokens: { source: "src/Button.css" }, // the :root token definitions live here
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

  const buttonKey = "sample/button/default@400.png";
  const badgeKey = "sample/badge/default@400.png";

  it("flags the Button geometry regression AND the Badge's sub-threshold token drift", async () => {
    // 1) First run: no baseline → both components are `new`.
    const r1 = await captureAll(config, { runId: "r1", outRoot });
    expect(r1.written).toEqual(expect.arrayContaining([buttonKey, badgeKey]));
    const c1 = await compareRun(config, { runId: "r1", outRoot, baselineDir });
    expect(c1.summary).toMatchObject({ total: 2, added: 2, failed: 0, passed: 0 });

    // 2) Approve both as baseline.
    runBaseline(config, { runId: "r1", outRoot, baselineDir });

    // 3) Unchanged re-run → 0 regressions on either component.
    await captureAll(config, { runId: "r2", outRoot });
    const c2 = await compareRun(config, { runId: "r2", outRoot, baselineDir });
    expect(c2.summary).toMatchObject({ total: 2, passed: 2, failed: 0, added: 0 });

    // 4) Two deliberate drifts:
    //    (a) Button — spacing token → larger hardcoded padding (a PIXEL-VISIBLE geometry change).
    const buttonCss = join(workDir, "src", "Button.css");
    const buttonBefore = readFileSync(buttonCss, "utf8");
    const buttonAfter = buttonBefore.replace(
      "padding: var(--vg-space-pad);",
      "padding: 48px 40px;",
    );
    expect(buttonAfter).not.toBe(buttonBefore);
    writeFileSync(buttonCss, buttonAfter);
    //    (b) Badge — color token → its IDENTICAL hardcoded hex (a SUB-THRESHOLD drift: 0 pixels move).
    const badgeCss = join(workDir, "src", "Badge.css");
    const badgeBefore = readFileSync(badgeCss, "utf8");
    const badgeAfter = badgeBefore.replace("background: var(--vg-brand);", "background: #2563eb;");
    expect(badgeAfter).not.toBe(badgeBefore);
    writeFileSync(badgeCss, badgeAfter);

    // 5) Capture + compare the changed run.
    await captureAll(config, { runId: "r3", outRoot });
    const c3 = await compareRun(config, { runId: "r3", outRoot, baselineDir });

    const button = c3.results.find((r) => r.key === buttonKey);
    const badge = c3.results.find((r) => r.key === badgeKey);
    // The Button's geometry change is a pixel regression, well over the gate.
    expect(button?.status).toBe("fail");
    expect(button?.ratio ?? 0).toBeGreaterThan(config.maxDiffRatio);
    // The Badge's inlined color is INVISIBLE to the pixel diff — it passes (the regression hides).
    expect(badge?.status).toBe("pass");
    expect(badge?.ratio ?? 1).toBeLessThanOrEqual(config.maxDiffRatio);
    expect(c3.summary).toMatchObject({ failed: 1, passed: 1 });

    // 6) The token-drift auditor CATCHES the Badge drift the pixels missed (the SPEC criterion).
    const drift = auditTokens(config, ["src/Badge.css"], tokenIo);
    const brandDrift = drift.find(
      (d) => d.literal.toLowerCase().includes("2563eb") && d.suggestedToken.includes("vg-brand"),
    );
    expect(brandDrift).toBeDefined();
    expect(brandDrift?.type).toBe("color");
    // Control: the unchanged (token-referencing) Badge source has no drift. The io must still
    // supply the real Button.css token defs — only Badge.css is swapped for its baseline — or
    // loadTokens would see no tokens and return [] for the wrong reason.
    const baselineIo = {
      readFile: (p: string) => (p.endsWith("Badge.css") ? badgeBefore : tokenIo.readFile(p)),
    };
    expect(auditTokens(config, ["src/Badge.css"], baselineIo)).toEqual([]);

    // 7) Build the manifest, then merge a structured reviewer verdict for the Button (the
    //    /visual-check Phase-1 contract: the verdict field is populated, not left null).
    const m3 = report(
      config,
      { runId: "r3", outRoot },
      { listChangedFiles, now: () => new Date(0) },
    );
    expect(m3.manifest.targets.find((t) => t.target === "button")?.status).toBe("fail");
    expect(m3.manifest.targets.find((t) => t.target === "badge")?.status).toBe("pass");

    const verdict: VerdictReport = {
      target: "button",
      state: "default",
      viewport: 400,
      severity: "high",
      classification: "design-system-violation",
      issue: "Button padding grew because the spacing token was inlined as a hardcoded value",
      file: "src/Button.css",
      line: 1,
      cause: "padding: 48px 40px replaces var(--vg-space-pad)",
      impact: ["off-system spacing", "taller button"],
      fix: "restore padding: var(--vg-space-pad)",
    };
    writeFileSync(join(outRoot, "runs", "r3", "verdicts.json"), JSON.stringify([verdict]));
    const applied = applyVerdicts({ runId: "r3", outRoot });
    expect(applied.applied).toBe(1);

    const merged = JSON.parse(readFileSync(applied.manifestPath, "utf8")) as typeof m3.manifest;
    const buttonVerdict = merged.targets
      .find((t) => t.target === "button")
      ?.images.find((i) => i.state === "default")?.verdict;
    expect(buttonVerdict?.classification).toBe("design-system-violation");
    expect(buttonVerdict?.fix).toMatch(/var\(--vg-space-pad\)/);
    expect(buttonVerdict).not.toHaveProperty("target"); // identifiers stripped on store
  }, 120_000);
});
