import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { latestRunId } from "./baseline";
import { evaluateGate, type GatePolicy } from "./ci";
import { STATUS_RANK, type Manifest, type ManifestImage, type ManifestTarget, type Verdict } from "./report";

/**
 * PR-comment generator (T-22): render a run's `manifest.json` as a Markdown report suitable for a
 * pull-request comment — a status header + gate line, a summary table, and a per-flagged-target
 * section that shows **evidence (pixels) before the verdict** (the SPEC boundary).
 *
 * GENERATE, NOT POST (Decision D3): this only produces Markdown (to `<runDir>/pr-comment.md` and
 * stdout). Visual Guard sends nothing to any external service — the CI system posts the file
 * itself (e.g. `gh pr comment -F .visual-guard/runs/<id>/pr-comment.md`). No screenshots are
 * embedded/uploaded; the report links the run-relative diff-PNG paths so a reviewer can open them.
 *
 * `renderPrComment` is pure and unit-tested. The gate verdict reuses `evaluateGate` (ci.ts) so the
 * PR header and the CI exit code can never disagree.
 */

const PREFIX = "Visual Guard PR report";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

/** A changed-pixel ratio as a percentage, or "—" when there is no ratio (new / error). */
function pct(ratio: number | null): string {
  return ratio === null ? "—" : `${(ratio * 100).toFixed(2)}%`;
}

/** A dimension delta (current − baseline) as `+W×+H px`, or null when there was no size change. */
function fmtDelta(delta: { width: number; height: number } | null): string | null {
  if (delta === null) {
    return null;
  }
  const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
  return `${sign(delta.width)}×${sign(delta.height)} px`;
}

/**
 * Is image `a` more significant than `b` for the summary cell? Rank by status first (the same
 * STATUS_RANK report.ts rolls a target up by), so a dimension-only `fail` (which `classify` flags
 * regardless of ratio) is never masked by a higher-ratio `pass` image; within the same status,
 * prefer one carrying a dimension change, then the larger pixel ratio.
 */
function moreSignificant(a: ManifestImage, b: ManifestImage): boolean {
  if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
    return STATUS_RANK[a.status] > STATUS_RANK[b.status];
  }
  const aDim = a.dimensionDelta !== null;
  const bDim = b.dimensionDelta !== null;
  if (aDim !== bDim) {
    return aDim;
  }
  return (a.ratio ?? 0) > (b.ratio ?? 0);
}

/** The image that best explains the target's status — used for the summary-table cells. */
function worstImage(target: ManifestTarget): ManifestImage | undefined {
  let worst: ManifestImage | undefined;
  for (const image of target.images) {
    if (worst === undefined || moreSignificant(image, worst)) {
      worst = image;
    }
  }
  return worst;
}

/** A compact "what changed" cell for the summary table. */
function changeCell(target: ManifestTarget): string {
  if (target.status === "pass") {
    return "—";
  }
  if (target.status === "new") {
    return "no baseline yet";
  }
  const image = worstImage(target);
  if (image === undefined) {
    return "—";
  }
  if (target.status === "error") {
    return "render error";
  }
  const parts = [pct(image.ratio)];
  const delta = fmtDelta(image.dimensionDelta);
  if (delta !== null) {
    parts.push(delta);
  }
  return parts.join(" · ");
}

/**
 * The verdict classification cell (em-dash when unreviewed). Prefers the verdict on the same image
 * the "Change" cell describes (so the two columns of a row never describe different images), falling
 * back to any image's verdict only if the worst image is unreviewed.
 */
function verdictCell(target: ManifestTarget): string {
  const verdict =
    worstImage(target)?.verdict ?? target.images.find((image) => image.verdict !== null)?.verdict;
  return verdict?.classification ?? "—";
}

/** Render one image's evidence-then-verdict bullet block. */
function renderImage(image: ManifestImage, gates: Manifest["gates"]): string[] {
  const lines: string[] = [];
  const head = `- **${image.state} @ ${image.viewport}** — ${image.status}`;
  if (image.status === "new") {
    lines.push(`${head} · no baseline yet (first render)`);
    return lines;
  }
  if (image.status === "error") {
    lines.push(`${head}${image.error ? ` · ${image.error}` : ""}`);
    return lines;
  }

  // Evidence first.
  const evidence = [`ratio **${pct(image.ratio)}** (gate ${pct(gates.maxDiffRatio)})`];
  const delta = fmtDelta(image.dimensionDelta);
  if (delta !== null) {
    evidence.push(`dimension **${delta}**`);
  }
  if (image.regions.length > 0) {
    evidence.push(`${image.regions.length} changed region(s)`);
  }
  lines.push(`${head} · ${evidence.join(" · ")}`);
  if (image.diffPath !== null) {
    lines.push(`  - diff: \`${image.diffPath}\``);
  }

  // Verdict second.
  const verdict: Verdict | null = image.verdict;
  if (verdict !== null) {
    lines.push(`  - **${verdict.classification} (${verdict.severity})** — ${verdict.issue}`);
    lines.push(`    - cause: ${verdict.cause} (\`${verdict.file}:${verdict.line}\`)`);
    if (verdict.impact.length > 0) {
      lines.push(`    - impact: ${verdict.impact.join(" · ")}`);
    }
    lines.push(`    - fix: ${verdict.fix}`);
  }
  return lines;
}

export interface PrCommentOptions {
  /** Gate policy for the header verdict; defaults to strict (new/error block). */
  policy?: GatePolicy;
}

/**
 * Render a manifest as a PR-comment Markdown string (pure). Shows the gate verdict, a summary
 * table of every target, and a detailed evidence→verdict block for each flagged (non-`pass`)
 * target. Deterministic given the manifest.
 */
export function renderPrComment(manifest: Manifest, options: PrCommentOptions = {}): string {
  const policy = options.policy ?? { allowNew: false, allowError: false };
  const gate = evaluateGate(manifest, policy);
  const flagged = manifest.targets.filter((target) => target.status !== "pass");

  const out: string[] = [];

  // Header.
  if (gate.ok) {
    out.push(`## Visual Guard — 0 regressions`);
  } else {
    const n = gate.blockingTargets.length;
    out.push(`## Visual Guard — ${n} blocking change${n === 1 ? "" : "s"}`);
  }
  out.push("");
  out.push(gate.summaryLine);
  out.push("");

  if (manifest.targets.length === 0) {
    out.push("_No targets were captured in this run._");
    return `${out.join("\n")}\n`;
  }

  // Summary table.
  out.push("| Target | Status | Change | Verdict |");
  out.push("| --- | --- | --- | --- |");
  for (const target of manifest.targets) {
    out.push(
      `| \`${target.instance}/${target.target}\` | ${target.status} ` +
        `| ${changeCell(target)} | ${verdictCell(target)} |`,
    );
  }
  out.push("");

  if (flagged.length === 0) {
    out.push(`All ${manifest.targets.length} target(s) match their baseline.`);
  } else {
    for (const target of flagged) {
      out.push(`### \`${target.instance}/${target.target}\` — ${target.status}`);
      out.push("");
      if (target.changedFiles.length > 0) {
        out.push(`**Changed files:** ${target.changedFiles.map((f) => `\`${f}\``).join(", ")}`);
        out.push("");
      }
      const changed = target.images.filter((image) => image.status !== "pass");
      for (const image of changed) {
        out.push(...renderImage(image, manifest.gates));
      }
      out.push("");
    }
  }

  // Footer — make the local-only / sign-off boundary explicit in the PR.
  out.push("---");
  out.push(
    "_Baselines are local and committed to the repo; approve an intended change with " +
      "`/visual-baseline <target>` and commit the new baseline. Visual Guard runs entirely " +
      "locally — no screenshots are uploaded._",
  );
  return `${out.join("\n")}\n`;
}

export interface WritePrCommentOptions extends PrCommentOptions {
  runId?: string;
  outRoot?: string;
}

export interface WritePrCommentResult {
  path: string;
  markdown: string;
  runId: string;
}

/** Resolve a run's manifest, render the PR comment, and write it to `<runDir>/pr-comment.md`. */
export function writePrComment(options: WritePrCommentOptions = {}): WritePrCommentResult {
  const outRoot = options.outRoot ?? ".visual-guard";
  const runsDir = join(outRoot, "runs");
  const runId =
    options.runId ??
    latestRunId(runsDir) ??
    fail(`no runs under ${runsDir} — run /visual-check (or capture→compare→report) first.`);

  const runDir = join(runsDir, runId);
  const manifestPath = join(runDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`no manifest.json at ${manifestPath} — run report.ts for run ${JSON.stringify(runId)} first.`);
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch (err) {
    return fail(
      `manifest.json at ${manifestPath} is not valid JSON ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  const markdown = renderPrComment(manifest, { policy: options.policy });
  const path = join(runDir, "pr-comment.md");
  writeFileSync(path, markdown);
  return { path, markdown, runId };
}

// --- CLI ------------------------------------------------------------------

export interface PrReportCliArgs {
  runId?: string;
  outRoot?: string;
  allowNew: boolean;
  allowError: boolean;
}

export function parseArgs(argv: string[]): PrReportCliArgs {
  let runId: string | undefined;
  let outRoot: string | undefined;
  let allowNew = false;
  let allowError = false;

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
      case "--run":
        runId = value(++i, "--run");
        break;
      case "--out":
        outRoot = value(++i, "--out");
        break;
      case "--allow-new":
        allowNew = true;
        break;
      case "--allow-error":
        allowError = true;
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  return { runId, outRoot, allowNew, allowError };
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const result = writePrComment({
    runId: args.runId,
    outRoot: args.outRoot,
    policy: { allowNew: args.allowNew, allowError: args.allowError },
  });
  // The Markdown to stdout (so CI can pipe it), then a note about where it was written.
  console.log(result.markdown);
  console.error(`${PREFIX}: wrote ${result.path}`);
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
