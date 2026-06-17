import { describe, it, expect, afterAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseConfig, type Config } from "../scripts/lib/config";
import type { CompareResult, ComparisonStatus, ImageComparison } from "../scripts/compare";
import type { RendersFile } from "../scripts/capture";
import {
  applyVerdicts,
  buildManifest,
  gatherChangedFiles,
  globToRegExp,
  mergeVerdicts,
  parseKey,
  report,
  storyIdFromUrl,
  VERDICT_KEYS,
  type Manifest,
  type RendersMap,
  type VerdictReport,
} from "../scripts/report";

const config: Config = parseConfig({
  targets: [{ type: "storybook", url: "http://localhost:6006" }],
  threshold: 0.1,
  maxDiffRatio: 0.01,
});

// --- Pure helpers ---------------------------------------------------------

describe("parseKey", () => {
  it("splits instance / target / state@viewport", () => {
    expect(parseKey("components/Button/Primary@1280.png")).toEqual({
      instance: "components",
      target: "Button",
      state: "Primary",
      viewport: 1280,
    });
  });

  it("handles an app route key", () => {
    expect(parseKey("web/user-settings/default@375.png")).toEqual({
      instance: "web",
      target: "user-settings",
      state: "default",
      viewport: 375,
    });
  });
});

describe("globToRegExp / gatherChangedFiles", () => {
  it("matches brace-extension globs across nested paths", () => {
    const re = globToRegExp("**/*.{tsx,jsx,vue,svelte}");
    expect(re.test("src/components/Button.tsx")).toBe(true);
    expect(re.test("Button.jsx")).toBe(true);
    expect(re.test("styles.css")).toBe(false);
  });

  it("keeps only UI files, de-duplicated and sorted", () => {
    expect(
      gatherChangedFiles(
        ["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss}"],
        ["src/Button.tsx", "a/b/x.css", "README.md", "Button.jsx", "notes.txt", "src/Button.tsx"],
      ),
    ).toEqual(["Button.jsx", "a/b/x.css", "src/Button.tsx"]);
  });
});

// --- buildManifest --------------------------------------------------------

function image(key: string, status: ComparisonStatus, over: Partial<ImageComparison> = {}): ImageComparison {
  const blank = status === "new" || status === "error";
  return {
    key,
    status,
    ratio: blank ? null : 0,
    changedPixels: blank ? null : 0,
    totalPixels: blank ? null : 100,
    dimensionDelta: null,
    regions: [],
    baselinePath: status === "new" ? null : `.visual-baselines/${key}`,
    currentPath: `current/${key}`,
    diffPath: blank ? null : `diff/${key}`,
    error: status === "error" ? "could not decode image" : null,
    ...over,
  };
}

function compareFixture(): CompareResult {
  const results: ImageComparison[] = [
    image("components/Button/default@1280.png", "pass"),
    image("components/Button/hover@1280.png", "fail", {
      ratio: 0.04,
      changedPixels: 4,
      regions: [{ x: 0, y: 0, width: 2, height: 2 }],
    }),
    image("components/Card/default@1280.png", "new"),
    image("icons/Star/default@1280.png", "error"),
    image("web/login/default@375.png", "pass"),
  ];
  return {
    runId: "RUN1",
    results,
    summary: {
      total: results.length,
      added: results.filter((r) => r.status === "new").length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
      errored: results.filter((r) => r.status === "error").length,
    },
  };
}

const CHANGED = ["src/components/Button.tsx", "src/components/button.css", "src/Card.tsx"];

const RUN_DIR = ".visual-guard/runs/RUN1";

const sb = (id: string): string => `http://localhost:6006/iframe.html?id=${id}&viewMode=story`;

/** capture's renders.json sidecar, keyed by the same relative key as each compare image (v2). */
function rendersFixture(): RendersMap {
  return {
    "components/Button/default@1280.png": {
      url: sb("button--default"),
      kind: "storybook",
      viewport: 1280,
      currentDimensions: { width: 1280, height: 480 },
    },
    "components/Button/hover@1280.png": {
      url: sb("button--hover"),
      kind: "storybook",
      viewport: 1280,
      currentDimensions: { width: 1280, height: 480 },
    },
    "components/Card/default@1280.png": {
      url: sb("card--default"),
      kind: "storybook",
      viewport: 1280,
      currentDimensions: { width: 1280, height: 600 },
    },
    "icons/Star/default@1280.png": {
      url: sb("star--default"),
      kind: "storybook",
      viewport: 1280,
      currentDimensions: { width: 1280, height: 64 },
    },
    "web/login/default@375.png": {
      url: "http://localhost:3000/login",
      kind: "app",
      viewport: 375,
      currentDimensions: { width: 375, height: 800 },
    },
  };
}

describe("buildManifest", () => {
  const manifest = buildManifest(compareFixture(), CHANGED, config, {
    generatedAt: "2026-06-13T00:00:00.000Z",
    runDir: RUN_DIR,
    renders: rendersFixture(),
  });

  it("groups per-image results into per-target entries (instance/target)", () => {
    expect(manifest.targets.map((t) => `${t.instance}/${t.target}`)).toEqual([
      "components/Button",
      "components/Card",
      "icons/Star",
      "web/login",
    ]);
    const button = manifest.targets.find((t) => t.target === "Button");
    expect(button?.images.map((i) => i.state)).toEqual(["default", "hover"]);
  });

  it("rolls each target up to its worst status (fail > error > new > pass)", () => {
    const status = (target: string) => manifest.targets.find((t) => t.target === target)?.status;
    expect(status("Button")).toBe("fail"); // pass + fail → fail
    expect(status("Card")).toBe("new");
    expect(status("Star")).toBe("error");
    expect(status("login")).toBe("pass");
  });

  it("attaches changed files to a target by name heuristic", () => {
    const button = manifest.targets.find((t) => t.target === "Button");
    expect(button?.changedFiles).toEqual(["src/components/Button.tsx", "src/components/button.css"]);
    expect(manifest.targets.find((t) => t.target === "Star")?.changedFiles).toEqual([]);
  });

  it("matches a target name as a whole token, not a loose substring (Card != Dashcard)", () => {
    const m = buildManifest(
      compareFixture(),
      ["src/Dashcard/Wizard.tsx", "src/components/Card.tsx"],
      config,
      { generatedAt: "2026-06-13T00:00:00.000Z", runDir: RUN_DIR },
    );
    expect(m.targets.find((t) => t.target === "Card")?.changedFiles).toEqual([
      "src/components/Card.tsx",
    ]);
  });

  it("rebases current/diff paths onto the run dir (single project-root anchor)", () => {
    const img = manifest.targets
      .find((t) => t.target === "Button")
      ?.images.find((i) => i.state === "hover");
    expect(img?.currentPath).toBe(`${RUN_DIR}/current/components/Button/hover@1280.png`);
    expect(img?.diffPath).toBe(`${RUN_DIR}/diff/components/Button/hover@1280.png`);
    expect(img?.baselinePath).toBe(".visual-baselines/components/Button/hover@1280.png");
    expect(manifest.runDir).toBe(RUN_DIR);
  });

  it("leaves a per-image verdict placeholder and echoes gates + summary", () => {
    expect(manifest.targets.every((t) => t.images.every((i) => i.verdict === null))).toBe(true);
    expect(manifest.gates).toEqual({ threshold: 0.1, maxDiffRatio: 0.01 });
    expect(manifest.summary).toEqual({ targets: 4, images: 5, pass: 2, fail: 1, new: 1, error: 1 });
    expect(manifest.version).toBe(2);
  });

  it("surfaces a capture-time render error (failFast:false) as a synthetic error image", () => {
    const renders: RendersMap = {
      ...rendersFixture(),
      // A render that threw during capture: in renders.json with an `error` but NO png, so it never
      // appears in compare.results — report must inject it instead of letting it vanish silently.
      "ui/Modal/open@1280.png": {
        url: "http://localhost:61000/?story=modal--open&mode=preview",
        kind: "ladle",
        viewport: 1280,
        currentDimensions: null,
        error: "net::ERR_ABORTED loading story",
      },
    };
    const m = buildManifest(compareFixture(), CHANGED, config, {
      generatedAt: "2026-06-13T00:00:00.000Z",
      runDir: RUN_DIR,
      renders,
    });
    const modal = m.targets.find((t) => t.target === "Modal");
    expect(modal?.status).toBe("error");
    const img = modal?.images[0];
    expect(img?.status).toBe("error");
    expect(img?.error).toMatch(/ERR_ABORTED/);
    expect(img?.currentDimensions).toBeNull();
    expect(img?.renderTarget?.kind).toBe("ladle");
    expect(img?.currentPath).toBe(`${RUN_DIR}/current/ui/Modal/open@1280.png`);
    // Counted in the summary on top of the compare totals (icons/Star is a compare-time error).
    expect(m.summary.error).toBe(2);
    expect(m.summary.images).toBe(6);
  });

  it("attaches per-image renderTarget + currentDimensions from renders.json (v2)", () => {
    const hover = manifest.targets
      .find((t) => t.target === "Button")
      ?.images.find((i) => i.state === "hover");
    expect(hover?.renderTarget).toEqual({
      url: sb("button--hover"),
      kind: "storybook",
      storyId: "button--hover", // parsed from the iframe url's ?id=
      viewport: 1280,
    });
    expect(hover?.currentDimensions).toEqual({ width: 1280, height: 480 });

    // An app route carries no story id, and its kind is "app".
    const login = manifest.targets.find((t) => t.target === "login")?.images[0];
    expect(login?.renderTarget).toEqual({
      url: "http://localhost:3000/login",
      kind: "app",
      storyId: null,
      viewport: 375,
    });
    // The `new` (Card) and `error` (Star) renders still get their render info — capture wrote
    // a current PNG for both, so neither is dropped from renders.json.
    const card = manifest.targets.find((t) => t.target === "Card")?.images[0];
    expect(card?.renderTarget?.storyId).toBe("card--default");
    expect(card?.currentDimensions).toEqual({ width: 1280, height: 600 });
  });

  it("leaves v2 fields null on a pre-v2 run (no renders.json — v1→v2 is additive)", () => {
    const legacy = buildManifest(compareFixture(), CHANGED, config, {
      generatedAt: "2026-06-13T00:00:00.000Z",
      runDir: RUN_DIR,
    });
    expect(
      legacy.targets.every((t) =>
        t.images.every((i) => i.renderTarget === null && i.currentDimensions === null),
      ),
    ).toBe(true);
    // Still v2-shaped (the keys exist), just unpopulated — so a consumer never sees a missing field.
    expect(legacy.version).toBe(2);
  });

  it("matches the locked golden manifest shape (R6 — contract can't drift)", () => {
    expect(manifest).toMatchSnapshot();
  });
});

describe("storyIdFromUrl", () => {
  it("parses the Storybook iframe id and returns null otherwise", () => {
    expect(storyIdFromUrl(sb("button--primary"))).toBe("button--primary");
    expect(storyIdFromUrl("http://localhost:3000/login")).toBeNull();
    expect(storyIdFromUrl("not a url")).toBeNull();
  });
});

// --- report() I/O ---------------------------------------------------------

describe("report", () => {
  const tmps: string[] = [];
  afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("reads compare.json, filters changed files by uiGlobs, and writes manifest.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vg-report-"));
    tmps.push(tmp);
    const runDir = join(tmp, ".visual-guard", "runs", "RUN1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "compare.json"), JSON.stringify(compareFixture()));
    // The v2 sidecar capture writes — report should read it and populate renderTarget.
    const renders: RendersFile = { version: 1, renders: rendersFixture() };
    writeFileSync(join(runDir, "renders.json"), JSON.stringify(renders));

    const result = report(
      config,
      { runId: "RUN1", outRoot: join(tmp, ".visual-guard") },
      {
        // a mix of UI and non-UI changes; only UI files should survive
        listChangedFiles: () => ["src/components/Button.tsx", "README.md", "src/components/button.css"],
        now: () => new Date("2026-06-13T00:00:00.000Z"),
      },
    );

    const onDisk = JSON.parse(readFileSync(result.manifestPath, "utf8")) as Manifest;
    expect(onDisk).toEqual(result.manifest);
    expect(onDisk.changedFiles).toEqual(["src/components/Button.tsx", "src/components/button.css"]);
    expect(onDisk.runId).toBe("RUN1");
    expect(onDisk.summary.targets).toBe(4);
    expect(onDisk.version).toBe(2);
    // renders.json was read off disk and threaded into the manifest.
    const buttonDefault = onDisk.targets
      .find((t) => t.target === "Button")
      ?.images.find((i) => i.state === "default");
    expect(buttonDefault?.renderTarget?.storyId).toBe("button--default");
    expect(buttonDefault?.currentDimensions).toEqual({ width: 1280, height: 480 });
  });

  it("populates v2 fields as null when renders.json is absent (older run)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vg-report-"));
    tmps.push(tmp);
    const runDir = join(tmp, ".visual-guard", "runs", "RUN1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "compare.json"), JSON.stringify(compareFixture()));

    const result = report(
      config,
      { runId: "RUN1", outRoot: join(tmp, ".visual-guard") },
      { listChangedFiles: () => [], now: () => new Date("2026-06-13T00:00:00.000Z") },
    );
    expect(
      result.manifest.targets.every((t) =>
        t.images.every((i) => i.renderTarget === null && i.currentDimensions === null),
      ),
    ).toBe(true);
  });

  it("throws an actionable error when compare.json is missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vg-report-"));
    tmps.push(tmp);
    expect(() =>
      report(config, { runId: "nope", outRoot: join(tmp, ".visual-guard") }, {
        listChangedFiles: () => [],
        now: () => new Date(),
      }),
    ).toThrow(/no compare\.json/);
  });
});

// --- mergeVerdicts / applyVerdicts (T-15) ---------------------------------

const verdictReport = (over: Partial<VerdictReport> = {}): VerdictReport => ({
  target: "Button",
  state: "hover",
  viewport: 1280,
  severity: "medium",
  classification: "design-system-violation",
  issue: "Button padding grew",
  file: "src/Button.css",
  line: 12,
  cause: "padding: 8px replaces var(--space-md)",
  impact: ["off-system spacing"],
  fix: "restore padding: var(--space-md)",
  ...over,
});

function manifestFixture(): Manifest {
  return buildManifest(compareFixture(), CHANGED, config, {
    generatedAt: "2026-06-13T00:00:00.000Z",
    runDir: RUN_DIR,
    renders: rendersFixture(),
  });
}

describe("mergeVerdicts", () => {
  it("routes a verdict to its image by (target,state,viewport) and stores the 8-field Verdict", () => {
    const manifest = manifestFixture();
    const { applied, unmatched } = mergeVerdicts(manifest, [verdictReport()]);
    expect(applied).toBe(1);
    expect(unmatched).toEqual([]);

    const hover = manifest.targets
      .find((t) => t.target === "Button")
      ?.images.find((i) => i.state === "hover");
    // Stored verdict is exactly the 8-field Verdict — routing identifiers stripped.
    expect(hover?.verdict).toEqual({
      severity: "medium",
      classification: "design-system-violation",
      issue: "Button padding grew",
      file: "src/Button.css",
      line: 12,
      cause: "padding: 8px replaces var(--space-md)",
      impact: ["off-system spacing"],
      fix: "restore padding: var(--space-md)",
    });
    // Exactly the 8 Verdict keys — no target/state/viewport identifier leaked through.
    expect(Object.keys(hover!.verdict!).sort()).toEqual([...VERDICT_KEYS].sort());
    // A sibling image is left untouched.
    const def = manifest.targets
      .find((t) => t.target === "Button")
      ?.images.find((i) => i.state === "default");
    expect(def?.verdict).toBeNull();
  });

  it("returns unmatched reports (wrong identifiers, or a null-addressed source-level finding)", () => {
    const manifest = manifestFixture();
    const wrong = verdictReport({ target: "Nonexistent", state: "default", viewport: 1280 });
    // A token-auditor finding (state/viewport null) addresses no per-image slot by design.
    const tokenDrift = verdictReport({ target: "Button", state: null, viewport: null });
    const { applied, unmatched } = mergeVerdicts(manifest, [wrong, tokenDrift]);
    expect(applied).toBe(0);
    expect(unmatched).toHaveLength(2);
    expect(manifest.targets.every((t) => t.images.every((i) => i.verdict === null))).toBe(true);
  });

  it("never mis-routes a same-name-different-instance verdict (ambiguous → unmatched)", () => {
    // Two instances expose a component named "Button" at the same state×viewport — the verdict's
    // (target,state,viewport) is ambiguous, so it must NOT land on an arbitrary instance's image.
    const results: ImageComparison[] = [
      image("components/Button/default@1280.png", "fail", { ratio: 0.04 }),
      image("icons/Button/default@1280.png", "fail", { ratio: 0.04 }),
    ];
    const compare: CompareResult = {
      runId: "R",
      results,
      summary: { total: 2, added: 0, passed: 0, failed: 2, errored: 0 },
    };
    const manifest = buildManifest(compare, [], config, {
      generatedAt: "2026-06-13T00:00:00.000Z",
      runDir: RUN_DIR,
    });
    expect(manifest.targets.map((t) => `${t.instance}/${t.target}`)).toEqual([
      "components/Button",
      "icons/Button",
    ]);

    const { applied, unmatched } = mergeVerdicts(manifest, [
      verdictReport({ target: "Button", state: "default", viewport: 1280 }),
    ]);
    expect(applied).toBe(0);
    expect(unmatched).toHaveLength(1);
    expect(manifest.targets.every((t) => t.images.every((i) => i.verdict === null))).toBe(true);
  });
});

describe("applyVerdicts (I/O)", () => {
  const tmps: string[] = [];
  afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const seedRun = (): { outRoot: string; runDir: string } => {
    const tmp = mkdtempSync(join(tmpdir(), "vg-verdicts-"));
    tmps.push(tmp);
    const outRoot = join(tmp, ".visual-guard");
    const runDir = join(outRoot, "runs", "RUN1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifestFixture()));
    return { outRoot, runDir };
  };

  it("merges verdicts.json into manifest.json on disk", () => {
    const { outRoot, runDir } = seedRun();
    writeFileSync(join(runDir, "verdicts.json"), JSON.stringify([verdictReport()]));

    const result = applyVerdicts({ runId: "RUN1", outRoot });
    expect(result.applied).toBe(1);
    expect(result.unmatched).toBe(0);

    const onDisk = JSON.parse(readFileSync(result.manifestPath, "utf8")) as Manifest;
    const hover = onDisk.targets
      .find((t) => t.target === "Button")
      ?.images.find((i) => i.state === "hover");
    expect(hover?.verdict?.cause).toBe("padding: 8px replaces var(--space-md)");
  });

  it("throws when manifest.json or verdicts.json is missing", () => {
    const { outRoot } = seedRun();
    // manifest exists, verdicts.json does not
    expect(() => applyVerdicts({ runId: "RUN1", outRoot })).toThrow(/no verdicts\.json/);
    // neither exists for an unknown run
    expect(() => applyVerdicts({ runId: "ghost", outRoot })).toThrow(/no manifest\.json/);
  });

  it("throws when verdicts.json is not a JSON array", () => {
    const { outRoot, runDir } = seedRun();
    writeFileSync(join(runDir, "verdicts.json"), JSON.stringify({ not: "an array" }));
    expect(() => applyVerdicts({ runId: "RUN1", outRoot })).toThrow(/must be a JSON array/);
  });

  it("throws an actionable error when verdicts.json is not valid JSON", () => {
    const { outRoot, runDir } = seedRun();
    // verdicts.json is written from subagent output, which can be truncated/non-JSON.
    writeFileSync(join(runDir, "verdicts.json"), "[{ not json");
    expect(() => applyVerdicts({ runId: "RUN1", outRoot })).toThrow(/is not valid JSON/);
  });

  it("is idempotent and writes only the run artifact (re-run → byte-identical manifest)", () => {
    const { outRoot, runDir } = seedRun();
    writeFileSync(join(runDir, "verdicts.json"), JSON.stringify([verdictReport()]));
    const manifestPath = join(runDir, "manifest.json");

    applyVerdicts({ runId: "RUN1", outRoot });
    const afterFirst = readFileSync(manifestPath, "utf8");
    applyVerdicts({ runId: "RUN1", outRoot });
    const afterSecond = readFileSync(manifestPath, "utf8");
    expect(afterSecond).toBe(afterFirst); // re-running the merge changes nothing

    // It only ever writes manifest.json under the run dir — no baseline / no source touched.
    expect(JSON.parse(afterSecond).version).toBe(2);
  });
});

describe("report CLI — non-git project robustness", () => {
  // Real-world shakedown finding: run in a project that is NOT a git repo, git prints a multi-line
  // usage / "fatal: not a git repository" message; gitChangedFiles must swallow it (return []) AND
  // not leak it to stderr (it suppresses the child's stderr). Verified by a real subprocess run.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
  const reportScript = join(repoRoot, "scripts", "report.ts");
  let tmp = "";

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("runs cleanly with no git stderr leak when cwd is not a git repository", () => {
    tmp = mkdtempSync(join(tmpdir(), "vg-report-nogit-")); // a fresh temp dir — NOT a git repo
    writeFileSync(
      join(tmp, "visual.config.json"),
      JSON.stringify({ targets: [{ type: "storybook", url: "http://localhost:6006" }] }),
    );
    const runDir = join(tmp, ".visual-guard", "runs", "RUN");
    mkdirSync(runDir, { recursive: true });
    const compare = {
      runId: "RUN",
      results: [
        {
          key: "i/t/default@1280.png",
          status: "new",
          ratio: null,
          changedPixels: null,
          totalPixels: null,
          dimensionDelta: null,
          regions: [],
          baselinePath: null,
          currentPath: "current/i/t/default@1280.png",
          diffPath: null,
          error: null,
        },
      ],
      summary: { total: 1, added: 1, passed: 0, failed: 0, errored: 0 },
    };
    writeFileSync(join(runDir, "compare.json"), JSON.stringify(compare));

    const res = spawnSync(tsx, [reportScript, "--config", "visual.config.json", "--run", "RUN"], {
      cwd: tmp,
      encoding: "utf8",
    });

    expect(res.status).toBe(0);
    // The bug this guards: git's usage/"not a git repository" text leaking to the user's console.
    expect(res.stderr).not.toMatch(/not a git repository|git diff --no-index/);
    const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
    expect(manifest.changedFiles).toEqual([]); // no git → empty changedFiles, not a crash
  });
});
