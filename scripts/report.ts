import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "./lib/config";
import type { BoundingBox } from "./lib/diff";
import type { ComparisonStatus, CompareResult } from "./compare";
// Type-only: the renders.json contract capture writes. `import type` is erased at runtime, so
// report.ts never pulls in capture.ts's heavy `playwright` import when run via tsx.
import type { RenderRecord, RendersFile } from "./capture";

/**
 * Report assembly (T-09): turn the per-image `compare.json` into `manifest.json` — the
 * machine-readable contract the `visual-reviewer` subagent consumes (Phase 1). It regroups
 * images by `<instance>/<target>`, attaches the run's changed UI files (from git, filtered
 * by `uiGlobs`), and leaves a per-image `verdict: null` placeholder the reviewer fills in.
 *
 * `buildManifest` is pure and golden/snapshot-tested so this contract can't drift silently
 * (R6). The git gathering is injected so the golden test stays deterministic.
 */

const PREFIX = "Visual Guard report";
// v2 (T-13): per-image `renderTarget` + `currentDimensions` added (additive — no field removed,
// so a v1 consumer still reads it). Bump only on a breaking shape change.
const MANIFEST_VERSION = 2;

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Manifest contract (versioned; golden-tested) -------------------------
//
// PATH ANCHOR: every *Path field below is a POSIX path **relative to the consuming
// project root** (where `.visual-guard/` and the baselineDir live). A consumer run from
// that root opens them directly. Paths are never machine-absolute, so the manifest is
// portable. `runDir` names this run's directory under the same root.

/** The reviewer's structured verdict (SPEC `visual-reviewer`). Stored as `ManifestImage.verdict`. */
export interface Verdict {
  severity: "low" | "medium" | "high";
  classification: "intentional" | "bug" | "design-system-violation";
  issue: string;
  file: string;
  line: number;
  cause: string;
  impact: string[];
  fix: string;
}

/**
 * The self-addressing JSON a Phase-1 verdict subagent (`visual-reviewer` / `token-auditor`)
 * emits: the typed {@link Verdict} plus the identifiers that route it back to its manifest
 * image. The engine strips the identifiers when persisting into `ManifestImage.verdict` (which
 * stays the 8-field {@link Verdict}). `state`/`viewport` are `null` for a file-level finding
 * (e.g. a token drift) that spans every state and viewport.
 */
export interface VerdictReport extends Verdict {
  /** The manifest target (component / page) this verdict addresses. */
  target: string;
  /** The image state, or null for a file-level finding that spans all states. */
  state: string | null;
  /** The image viewport width, or null for a file-level finding that spans all viewports. */
  viewport: number | null;
}

// Runtime field lists for the verdict contracts, kept EXHAUSTIVE at compile time by the
// `satisfies` guards below — adding/removing a Verdict or VerdictReport field breaks `tsc` here,
// so the agents' documented JSON (asserted field-for-field in the contract tests) can't drift.
const VERDICT_SHAPE = {
  severity: true,
  classification: true,
  issue: true,
  file: true,
  line: true,
  cause: true,
  impact: true,
  fix: true,
} satisfies Record<keyof Verdict, true>;

/** The 8 keys of {@link Verdict}. */
export const VERDICT_KEYS: readonly (keyof Verdict)[] = Object.keys(VERDICT_SHAPE) as (keyof Verdict)[];

const VERDICT_REPORT_SHAPE = {
  ...VERDICT_SHAPE,
  target: true,
  state: true,
  viewport: true,
} satisfies Record<keyof VerdictReport, true>;

/** The 11 keys of {@link VerdictReport} (Verdict + `target`/`state`/`viewport`). */
export const VERDICT_REPORT_KEYS: readonly (keyof VerdictReport)[] = Object.keys(
  VERDICT_REPORT_SHAPE,
) as (keyof VerdictReport)[];

/**
 * Where an image was rendered (manifest v2). Lets the `visual-reviewer` re-render the live
 * element via Playwright/Chrome-DevTools MCP to disambiguate a diff. `null` on an image when
 * the run predates v2 (no `renders.json`).
 */
export interface RenderInfo {
  /** Fully-resolved URL the render was captured from. */
  url: string;
  kind: RenderRecord["kind"];
  /** Storybook story id (parsed from the iframe URL), or null for an app/ladle route. */
  storyId: string | null;
  /** Viewport width the render was captured at. */
  viewport: number;
}

export interface ManifestImage {
  state: string;
  viewport: number;
  status: ComparisonStatus;
  ratio: number | null;
  dimensionDelta: { width: number; height: number } | null;
  regions: BoundingBox[];
  baselinePath: string | null;
  currentPath: string;
  diffPath: string | null;
  error: string | null;
  /** Filled by the visual-reviewer subagent in Phase 1; null until then. */
  verdict: Verdict | null;
  /** v2: where this image was rendered, so the reviewer can re-render it live. Null pre-v2. */
  renderTarget: RenderInfo | null;
  /** v2: pixel dimensions of the captured `current` PNG. Null pre-v2 or if unreadable. */
  currentDimensions: { width: number; height: number } | null;
  /**
   * True when this render was NOT screenshotted — its inputs were byte-identical to approval, so the
   * approved baseline was copied forward (capture fingerprint-skip). It still compares to `pass`; this
   * flag keeps the report honest ("trusted the baseline", never silently folded into "all good").
   */
  skipped: boolean;
}

export interface ManifestTarget {
  instance: string;
  target: string;
  /** Worst status across this target's images (fail > error > new > pass). */
  status: ComparisonStatus;
  /** Changed UI files whose path contains this target's name as a token (Phase-0 heuristic). */
  changedFiles: string[];
  images: ManifestImage[];
}

export interface Manifest {
  version: number;
  runId: string;
  /** This run's directory, relative to the consuming project root. */
  runDir: string;
  generatedAt: string;
  gates: { threshold: number; maxDiffRatio: number };
  /** All changed UI files in the run (git, filtered by uiGlobs), project-root-relative. */
  changedFiles: string[];
  summary: {
    targets: number;
    images: number;
    pass: number;
    fail: number;
    new: number;
    error: number;
    /** Of `pass`, how many were COPIED from the baseline (fingerprint-skip), not screenshotted. */
    skipped: number;
  };
  targets: ManifestTarget[];
}

// --- Pure helpers ---------------------------------------------------------

/**
 * Split an `<instance>/<target>/<state>@<viewport>.png` key into its parts. Keys from
 * capture always have exactly three segments (each a sanitized, slash-free path segment);
 * the multi-segment fallback is defensive only.
 */
export function parseKey(key: string): {
  instance: string;
  target: string;
  state: string;
  viewport: number;
} {
  const parts = key.split("/");
  const instance = parts.length > 0 ? (parts[0] ?? "") : "";
  const leaf = parts.length > 0 ? (parts[parts.length - 1] ?? key) : key;
  const target = parts.length > 2 ? parts.slice(1, -1).join("/") : "";
  const match = /^(.+)@(\d+)\.png$/.exec(leaf);
  const state = match ? match[1]! : leaf.replace(/\.png$/, "");
  const viewport = match ? Number(match[2]) : 0;
  return { instance, target, state, viewport };
}

/** Render records keyed by the shared `<instance>/<target>/<state>@<viewport>.png` key. */
export type RendersMap = Record<string, RenderRecord>;

/** Extract a Storybook story id from a capture URL (`…/iframe.html?id=<id>&…`), else null. */
export function storyIdFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("id");
  } catch {
    return null;
  }
}

/** Extract a Ladle story id from a capture URL (`…/?story=<id>&mode=preview`), else null. */
function ladleStoryIdFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("story");
  } catch {
    return null;
  }
}

/** Build the manifest's per-image `renderTarget` from a persisted render record. */
function renderInfoOf(record: RenderRecord): RenderInfo {
  // A story explorer carries a story id (Storybook `?id=`, Ladle `?story=`) so the reviewer can
  // re-render it; an app route never does.
  const storyId =
    record.kind === "storybook"
      ? storyIdFromUrl(record.url)
      : record.kind === "ladle"
        ? ladleStoryIdFromUrl(record.url)
        : null;
  return {
    url: record.url,
    kind: record.kind,
    storyId,
    viewport: record.viewport,
  };
}

/** Severity ordering of a comparison status: worst wins (a target rolls up to its worst image). */
export const STATUS_RANK: Record<ComparisonStatus, number> = { pass: 0, new: 1, error: 2, fail: 3 };

function worstStatus(statuses: ComparisonStatus[]): ComparisonStatus {
  let worst: ComparisonStatus = "pass";
  for (const status of statuses) {
    if (STATUS_RANK[status] > STATUS_RANK[worst]) {
      worst = status;
    }
  }
  return worst;
}

const posixJoin = (base: string, rel: string): string => `${base.replace(/\/+$/, "")}/${rel}`;

/**
 * Does a changed file relate to a target? Phase-0 heuristic: the target name must appear as
 * a whole token in the path (bounded by a non-alphanumeric char), so "Button" matches
 * "src/Button.tsx" and "button.css" but "Card" does NOT match "src/Dashcard/Wizard.tsx".
 */
function fileMatchesTarget(file: string, target: string): boolean {
  if (target.length === 0) {
    return false;
  }
  const escaped = target.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-zA-Z0-9])${escaped}(?:[^a-zA-Z0-9]|$)`, "i").test(file);
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** Convert a minimal glob (`**`, `*`, `?`, `{a,b}`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += "[^]*"; // ** matches anything, including "/"
        i++;
        if (glob[i + 1] === "/") {
          i++; // consume the slash after **
        }
      } else {
        re += "[^/]*"; // * matches anything but "/"
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        continue;
      }
      re += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map(escapeLiteral)
        .join("|")})`;
      i = end;
    } else {
      re += escapeLiteral(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

/** Keep the changed files that match any UI glob, de-duplicated and sorted. */
export function gatherChangedFiles(uiGlobs: string[], files: string[]): string[] {
  const matchers = uiGlobs.map(globToRegExp);
  const matched = new Set(files.filter((file) => matchers.some((matcher) => matcher.test(file))));
  return [...matched].sort();
}

/**
 * Assemble the manifest from a comparison result. Pure — golden-tested (R6). `runDir` is the
 * run directory relative to the project root; current/diff paths are rebased onto it so every
 * manifest path shares one anchor (the project root).
 */
export function buildManifest(
  compare: CompareResult,
  changedFiles: string[],
  config: Config,
  meta: { generatedAt: string; runDir: string; renders?: RendersMap },
): Manifest {
  // renders.json (capture, v2) keyed by the same relative key as each compare image; absent on
  // a pre-v2 run, in which case renderTarget/currentDimensions stay null.
  const renders = meta.renders ?? {};
  // Group by instance/target with a struct map (insertion order = first-seen = deterministic,
  // since compare.results is sorted by key) — no fragile delimiter to split back out.
  const groups = new Map<string, { instance: string; target: string; images: ManifestImage[] }>();

  for (const image of compare.results) {
    const { instance, target, state, viewport } = parseKey(image.key);
    const groupKey = `${instance} ${target}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { instance, target, images: [] };
      groups.set(groupKey, group);
    }
    const record = renders[image.key];
    group.images.push({
      state,
      viewport,
      status: image.status,
      ratio: image.ratio,
      dimensionDelta: image.dimensionDelta,
      regions: image.regions,
      // Rebase run-dir-relative paths onto the project root; baseline is already root-relative.
      baselinePath: image.baselinePath,
      currentPath: posixJoin(meta.runDir, image.currentPath),
      diffPath: image.diffPath === null ? null : posixJoin(meta.runDir, image.diffPath),
      error: image.error,
      verdict: null,
      renderTarget: record === undefined ? null : renderInfoOf(record),
      currentDimensions: record?.currentDimensions ?? null,
      skipped: record?.skipped === true,
    });
  }

  // Surface capture-time failures (failFast:false): a render that threw wrote NO png, so it never
  // reaches compare — inject a synthetic `error` image from renders.json so the failure is visible
  // and counted, instead of silently vanishing from the manifest.
  const comparedKeys = new Set(compare.results.map((result) => result.key));
  let captureErrors = 0;
  for (const [key, record] of Object.entries(renders)) {
    if (record.error === undefined || comparedKeys.has(key)) {
      continue;
    }
    const { instance, target, state, viewport } = parseKey(key);
    const groupKey = `${instance} ${target}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { instance, target, images: [] };
      groups.set(groupKey, group);
    }
    group.images.push({
      state,
      viewport,
      status: "error",
      ratio: null,
      dimensionDelta: null,
      regions: [],
      baselinePath: null,
      // No png was written; this is the path it WOULD occupy (run-root-relative, like other images).
      currentPath: posixJoin(meta.runDir, posixJoin("current", key)),
      diffPath: null,
      error: record.error,
      verdict: null,
      renderTarget: renderInfoOf(record),
      currentDimensions: null,
      skipped: false,
    });
    captureErrors += 1;
  }

  const targets: ManifestTarget[] = [...groups.values()].map((group) => ({
    instance: group.instance,
    target: group.target,
    status: worstStatus(group.images.map((image) => image.status)),
    changedFiles: changedFiles.filter((file) => fileMatchesTarget(file, group.target)),
    images: group.images,
  }));

  return {
    version: MANIFEST_VERSION,
    runId: compare.runId,
    runDir: meta.runDir,
    generatedAt: meta.generatedAt,
    gates: { threshold: config.threshold, maxDiffRatio: config.maxDiffRatio },
    changedFiles,
    summary: {
      targets: targets.length,
      images: compare.results.length + captureErrors,
      pass: compare.summary.passed,
      fail: compare.summary.failed,
      new: compare.summary.added,
      error: compare.summary.errored + captureErrors,
      skipped: Object.values(renders).filter((record) => record.skipped === true).length,
    },
    targets,
  };
}

export interface VerdictMergeResult {
  /** The same manifest, with matched images' `verdict` populated (mutated in place). */
  manifest: Manifest;
  /** How many reports were routed to an image. */
  applied: number;
  /** Reports whose `(target, state, viewport)` matched no manifest image — surfaced, not dropped. */
  unmatched: VerdictReport[];
}

/**
 * Merge a `visual-reviewer` run's {@link VerdictReport} array back into a manifest (T-15): route
 * each report to its image by `(target, state, viewport)` and store the 8-field {@link Verdict}
 * in `ManifestImage.verdict` (the routing identifiers are stripped). Pure-ish — it mutates the
 * passed manifest's images and returns it. A report that matches no image is returned in
 * `unmatched` (never silently dropped); a source-level finding with `state`/`viewport` `null`
 * (the token-auditor) matches no per-image slot by design and lands in `unmatched`.
 *
 * The `VerdictReport` carries no `instance`, so when two instances expose the **same** component
 * name at the same state×viewport (the Phase-0 multi-instance scheme), `(target, state, viewport)`
 * is ambiguous. Rather than mis-route to an arbitrary instance, such reports are routed to NONE
 * and returned in `unmatched` — safe by construction. (Disambiguating needs `instance` on the
 * verdict; deferred until a multi-instance run actually needs per-instance verdicts.)
 */
export function mergeVerdicts(manifest: Manifest, reports: VerdictReport[]): VerdictMergeResult {
  // JSON-stringified key (no fragile single-char delimiter — see the NUL-byte lesson in groupKey).
  const keyOf = (target: string, state: string | null, viewport: number | null): string =>
    JSON.stringify([target, state, viewport]);

  const index = new Map<string, ManifestImage>();
  const ambiguous = new Set<string>();
  for (const target of manifest.targets) {
    for (const image of target.images) {
      const key = keyOf(target.target, image.state, image.viewport);
      if (index.has(key)) {
        ambiguous.add(key); // same component name in another instance — can't route by name alone
      } else {
        index.set(key, image);
      }
    }
  }

  const unmatched: VerdictReport[] = [];
  let applied = 0;
  for (const report of reports) {
    const key = keyOf(report.target, report.state, report.viewport);
    // An ambiguous key is treated as no-match so a verdict is never routed to the wrong instance.
    const image = ambiguous.has(key) ? undefined : index.get(key);
    if (image === undefined) {
      unmatched.push(report);
      continue;
    }
    // Store exactly the typed Verdict — explicitly pick the 8 fields so the routing identifiers
    // (target/state/viewport) never leak into ManifestImage.verdict.
    image.verdict = {
      severity: report.severity,
      classification: report.classification,
      issue: report.issue,
      file: report.file,
      line: report.line,
      cause: report.cause,
      impact: report.impact,
      fix: report.fix,
    };
    applied++;
  }
  return { manifest, applied, unmatched };
}

// --- I/O ------------------------------------------------------------------

/**
 * Read a run's `renders.json` (capture's v2 sidecar) into a render map. Returns {} when it is
 * absent (a pre-v2 run) or unreadable/malformed — so a missing sidecar degrades to null v2
 * fields rather than failing the report.
 */
function readRenders(runDir: string): RendersMap {
  const rendersPath = join(runDir, "renders.json");
  if (!existsSync(rendersPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(rendersPath, "utf8")) as Partial<RendersFile>;
    return parsed.renders ?? {};
  } catch {
    return {};
  }
}

/** Changed files in the working tree vs HEAD plus untracked, or [] outside a git repo. */
function gitChangedFiles(): string[] {
  const run = (args: string[]): string[] => {
    try {
      // stdio: ignore stdin + stderr (capture only stdout). Outside a git repo / on any git error,
      // git prints a multi-line usage/"fatal: not a git repository" message to stderr; without this
      // it would leak to the console and look like a failure, even though we treat the error as
      // "no changed files" (returning []). Visual Guard runs in non-git projects too — stay quiet.
      return execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).split("\n");
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
}

export interface ReportOptions {
  runId: string;
  outRoot?: string;
}

export interface ReportDeps {
  listChangedFiles: () => string[];
  now: () => Date;
}

const defaultDeps: ReportDeps = {
  listChangedFiles: gitChangedFiles,
  now: () => new Date(),
};

export interface ReportResult {
  manifestPath: string;
  manifest: Manifest;
}

/** Read a run's compare.json, gather changed files, and write manifest.json. */
export function report(
  config: Config,
  options: ReportOptions,
  deps: ReportDeps = defaultDeps,
): ReportResult {
  const outRoot = options.outRoot ?? ".visual-guard";
  const runDir = join(outRoot, "runs", options.runId);
  const comparePath = join(runDir, "compare.json");
  if (!existsSync(comparePath)) {
    fail(`no compare.json at ${comparePath} — run compare.ts for this run first.`);
  }

  const compare = JSON.parse(readFileSync(comparePath, "utf8")) as CompareResult;
  const changedFiles = gatherChangedFiles(config.uiGlobs, deps.listChangedFiles());
  const manifest = buildManifest(compare, changedFiles, config, {
    generatedAt: deps.now().toISOString(),
    runDir,
    renders: readRenders(runDir),
  });

  const manifestPath = join(runDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, manifest };
}

export interface ApplyVerdictsOptions {
  runId: string;
  outRoot?: string;
  /** Reviewer-output JSON file; defaults to `<runDir>/verdicts.json`. */
  verdictsPath?: string;
}

export interface ApplyVerdictsResult {
  manifestPath: string;
  applied: number;
  unmatched: number;
}

/**
 * T-15 persistence: read a run's `manifest.json` and a reviewer-output `verdicts.json` (a
 * {@link VerdictReport} array), {@link mergeVerdicts} the verdicts into the matching images, and
 * write `manifest.json` back. The command writes the subagent output to `verdicts.json` and calls
 * this — keeping the safety-critical merge in tested code rather than hand-edited JSON. Writes
 * only the run artifact under `.visual-guard/` (never source); never approves a baseline.
 */
export function applyVerdicts(options: ApplyVerdictsOptions): ApplyVerdictsResult {
  const outRoot = options.outRoot ?? ".visual-guard";
  const runDir = join(outRoot, "runs", options.runId);
  const manifestPath = join(runDir, "manifest.json");
  const verdictsPath = options.verdictsPath ?? join(runDir, "verdicts.json");

  if (!existsSync(manifestPath)) {
    fail(`no manifest.json at ${manifestPath} — run report.ts for this run first.`);
  }
  if (!existsSync(verdictsPath)) {
    fail(`no verdicts.json at ${verdictsPath} — write the reviewer output there first.`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  let reports: unknown;
  try {
    reports = JSON.parse(readFileSync(verdictsPath, "utf8"));
  } catch (err) {
    return fail(`verdicts.json at ${verdictsPath} is not valid JSON (${detailOf(err)}).`);
  }
  if (!Array.isArray(reports)) {
    fail(`verdicts.json must be a JSON array of verdict objects.`);
  }

  const result = mergeVerdicts(manifest, reports as VerdictReport[]);
  writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  return { manifestPath, applied: result.applied, unmatched: result.unmatched.length };
}

// --- CLI ------------------------------------------------------------------

export interface ReportCliArgs {
  config: string;
  runId: string;
  /** When set, merge `<runDir>/verdicts.json` into the existing manifest instead of building it. */
  applyVerdicts: boolean;
  /** Optional reviewer-output path override for `--apply-verdicts`. */
  verdictsPath?: string;
}

export function parseArgs(argv: string[]): ReportCliArgs {
  let config = "config/visual.config.json";
  let runId: string | undefined;
  let applyVerdicts = false;
  let verdictsPath: string | undefined;

  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined) {
      fail(`missing value for ${flag}.`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--config":
        config = value(++i, "--config");
        break;
      case "--run":
        runId = value(++i, "--run");
        break;
      case "--apply-verdicts":
        applyVerdicts = true;
        break;
      case "--verdicts":
        verdictsPath = value(++i, "--verdicts");
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  if (runId === undefined) {
    fail(`--run <id> is required.`);
  }
  return { config, runId, applyVerdicts, verdictsPath };
}

function main(argv: string[]): void {
  const args = parseArgs(argv);

  // T-15: merge the reviewer's verdicts into an already-built manifest (no config needed).
  if (args.applyVerdicts) {
    const { manifestPath, applied, unmatched } = applyVerdicts({
      runId: args.runId,
      verdictsPath: args.verdictsPath,
    });
    console.log(
      `${PREFIX}: applied ${applied} verdict(s)` +
        (unmatched > 0 ? `, ${unmatched} unmatched` : "") +
        ` -> ${manifestPath}`,
    );
    return;
  }

  const config = loadConfig(args.config);
  const { manifestPath, manifest } = report(config, { runId: args.runId });
  const { summary } = manifest;
  const captured = summary.images - summary.skipped;
  console.log(
    `${PREFIX}: ${summary.targets} target(s), ${summary.images} image(s) — ` +
      `${summary.fail} fail, ${summary.new} new, ${summary.error} error -> ${manifestPath}`,
  );
  // Honest accounting + trust boundary whenever fingerprint-skip copied baselines forward: a skip means
  // "the inputs are byte-identical to approval", NEVER "verified unchanged". State what skip does NOT
  // re-check so the user can audit it / run the true backstop.
  if (summary.skipped > 0) {
    console.log(
      `${PREFIX}: ${captured} captured, ${summary.skipped} skipped (inputs unchanged since approval). ` +
        `Skip trusts the baseline; it does NOT re-check host fonts, the Chromium binary if unpinned, ` +
        `remote/CDN assets, or shell env — but a rotating sample (~sqrt of the skipped set) IS re-shot ` +
        `each run, so any such drift is caught within a bounded number of runs. For a full re-verification ` +
        `now, run /visual-check --all (without --skip-unchanged).`,
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
