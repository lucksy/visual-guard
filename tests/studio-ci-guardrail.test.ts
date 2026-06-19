import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { openDb, type DB } from "../scripts/lib/studio/db";
import {
  appendSnapshot,
  getComponentByKey,
  recomputeStatus,
  recordComparison,
  setFigmaLink,
  upsertComponent,
  upsertVariant,
} from "../scripts/lib/studio/store";
import { runConformance } from "../scripts/studio";
import { evaluateGate } from "../scripts/ci";
import type { Manifest } from "../scripts/report";

/**
 * P5 CI guardrail (SPEC §14): conformance (`figma_vs_code`) is advisory and can NEVER flip the CI gate.
 * Proven from both sides: (1) recording a divergent conformance row leaves `components.status` (the code
 * axis the gate cares about) untouched — only `parity_status` moves; (2) `evaluateGate` (ci.ts) is a pure
 * function of the run manifest and never reads the studio DB at all.
 */

describe("recomputeStatus keeps the code axis independent of conformance", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("a figma_vs_code 'changed' row moves parity_status but NOT components.status", () => {
    const id = upsertComponent(db, { key: "buttons/button", name: "Button", codeInstance: "sb", codeTarget: "Button" });
    const v = upsertVariant(db, { componentId: id, source: "code", name: "default@1280" });
    const base = appendSnapshot(db, { componentId: id, variantId: v, source: "code", imagePath: ".visual-baselines/b.png", imageHash: "base", approved: true });
    const cur = appendSnapshot(db, { componentId: id, variantId: v, source: "current", imagePath: ".visual-guard/cache/blobs/aa.png", imageHash: "aa" });
    // The trustworthy code axis: a clean pass.
    recordComparison(db, { componentId: id, axis: "current_vs_baseline", fromSnapshot: base.id, toSnapshot: cur.id, diffRatio: 0, status: "same" });
    recomputeStatus(db, id);
    expect(getComponentByKey(db, "buttons/button")?.status).toBe("same");

    // Now a DIVERGENT conformance verdict (recorded as advisory 'changed' on the figma axis).
    const figma = appendSnapshot(db, { componentId: id, source: "figma", imagePath: ".visual-baselines/.figma/f.png", imageHash: "f", approved: true });
    recordComparison(db, { componentId: id, axis: "figma_vs_code", fromSnapshot: figma.id, toSnapshot: cur.id, diffRatio: 0.9, status: "changed" });
    recomputeStatus(db, id);

    const row = getComponentByKey(db, "buttons/button");
    expect(row?.status).toBe("same"); // CODE axis UNCHANGED — conformance cannot regress it
    expect(row?.parity_status).toBe("changed"); // the advisory axis reflects the divergence
  });
});

describe("evaluateGate is a pure function of the manifest (never the studio DB)", () => {
  const cleanManifest: Manifest = {
    version: 2,
    runId: "r1",
    runDir: ".visual-guard/runs/r1",
    generatedAt: "2026-06-16T00:00:00.000Z",
    gates: { threshold: 0.1, maxDiffRatio: 0.01 },
    changedFiles: [],
    summary: { targets: 1, images: 1, pass: 1, fail: 0, new: 0, error: 0, skipped: 0 },
    targets: [{ instance: "sb", target: "Button", status: "pass", changedFiles: [], images: [] }],
  };

  it("a clean (all-pass) manifest gates green regardless of any conformance signal", () => {
    const result = evaluateGate(cleanManifest, { allowNew: false, allowError: false });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // ci.ts imports only ./report + ./compare + ./baseline — never any studio module — so a divergent
    // figma_vs_code row simply cannot reach this decision.
  });

  it("the gate flips ONLY on a code-axis fail in the manifest", () => {
    const failing: Manifest = {
      ...cleanManifest,
      summary: { ...cleanManifest.summary, pass: 0, fail: 1 },
      targets: [{ instance: "sb", target: "Button", status: "fail", changedFiles: [], images: [] }],
    };
    expect(evaluateGate(failing, { allowNew: false, allowError: false }).exitCode).toBe(1);
  });
});

describe("runConformance records figma_vs_code without touching the code axis", () => {
  let tmp = "";
  let db: DB;
  const put = async (
    rel: string,
    rgb: [number, number, number],
    dim: [number, number] = [40, 40],
  ): Promise<{ path: string; hash: string }> => {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const png = await sharp({ create: { width: dim[0], height: dim[1], channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } } }).png().toBuffer();
    writeFileSync(abs, png);
    // A real content hash (like the engine) — so re-screenshotting a node with new bytes appends a NEW
    // snapshot rather than being deduped, which is what the from_snapshot idempotency key relies on.
    return { path: rel, hash: createHash("sha256").update(png).digest("hex") };
  };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-conf-"));
    db = openDb(join(tmp, ".visual-guard", "studio.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("scores a divergent pair → parity 'changed', code status untouched", async () => {
    const id = upsertComponent(db, { key: "buttons/button", name: "Button", codeInstance: "sb", codeTarget: "Button" });
    setFigmaLink(db, "buttons/button", "ACME1", "10:2");
    const vf = upsertVariant(db, { componentId: id, source: "figma", name: "default@0" });
    const vc = upsertVariant(db, { componentId: id, source: "code", name: "default@1280" });
    // A clean code baseline first, so the code axis reads 'same'.
    const codeImg = await put(".visual-baselines/sb/Button/default@1280.png", [0, 0, 255]); // blue
    const base = appendSnapshot(db, { componentId: id, variantId: vc, source: "code", imagePath: codeImg.path, imageHash: codeImg.hash, approved: true });
    recordComparison(db, { componentId: id, axis: "current_vs_baseline", fromSnapshot: base.id, toSnapshot: base.id, diffRatio: 0, status: "same" });
    recomputeStatus(db, id);
    // A clearly different Figma design (red vs blue) → divergent.
    const figmaImg = await put(".visual-baselines/.figma/ACME1/10-2/default@0.png", [255, 0, 0]);
    appendSnapshot(db, { componentId: id, variantId: vf, source: "figma", imagePath: figmaImg.path, imageHash: figmaImg.hash, approved: true });

    const summary = await runConformance({ db, cwd: tmp });
    expect(summary.scored).toBe(1);
    expect(summary.byLevel.divergent).toBe(1);

    const row = getComponentByKey(db, "buttons/button");
    expect(row?.parity_status).toBe("changed"); // advisory: divergent → 'changed'
    expect(row?.status).toBe("same"); // the CI-relevant code axis is untouched

    // Idempotent: a second pass on the unchanged DS records no new figma_vs_code row.
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM regressions WHERE axis='figma_vs_code'`).get() as { n: number }).n;
    const again = await runConformance({ db, cwd: tmp });
    expect(again.scored).toBe(1); // still scored…
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM regressions WHERE axis='figma_vs_code'`).get() as { n: number }).n;
    expect(after).toBe(before); // …but no duplicate row appended
  });

  it("does NOT resurrect a stale (non-rendered) code-regression lane — conformance can't move the code axis", async () => {
    // A figma-linked component with a LIVE 'default' lane (clean) + a STALE 'hover' lane (regressed,
    // e.g. a deleted story not re-rendered this cycle). The honest live status is 'same'.
    const id = upsertComponent(db, { key: "buttons/button", name: "Button", codeInstance: "sb", codeTarget: "Button" });
    setFigmaLink(db, "buttons/button", "ACME1", "10:2");
    const vDefault = upsertVariant(db, { componentId: id, source: "code", name: "default@1280" });
    const vHover = upsertVariant(db, { componentId: id, source: "code", name: "hover@1280" });
    const codeImg = await put(".visual-baselines/sb/Button/default@1280.png", [0, 0, 255]);
    const base = appendSnapshot(db, { componentId: id, variantId: vDefault, source: "code", imagePath: codeImg.path, imageHash: codeImg.hash, approved: true });
    recordComparison(db, { componentId: id, axis: "current_vs_baseline", fromSnapshot: base.id, toSnapshot: base.id, diffRatio: 0, status: "same" });
    // The stale hover lane carries a 'regression' verdict that should NOT pin the component anymore.
    const hoverCur = appendSnapshot(db, { componentId: id, variantId: vHover, source: "current", imagePath: ".visual-guard/cache/blobs/h.png", imageHash: "h" });
    recordComparison(db, { componentId: id, axis: "current_vs_baseline", fromSnapshot: hoverCur.id, toSnapshot: hoverCur.id, status: "regression" });
    // Honest live status (scoped to the rendered lane) = 'same'.
    recomputeStatus(db, id, new Set<number | null>([vDefault]));
    expect(getComponentByKey(db, "buttons/button")?.status).toBe("same");

    const figmaImg = await put(".visual-baselines/.figma/ACME1/10-2/default@0.png", [255, 0, 0]);
    appendSnapshot(db, { componentId: id, source: "figma", imagePath: figmaImg.path, imageHash: figmaImg.hash, approved: true });
    await runConformance({ db, cwd: tmp });

    const row = getComponentByKey(db, "buttons/button");
    expect(row?.status).toBe("same"); // NOT resurrected to 'regression' by the stale hover lane
    expect(row?.parity_status).toBe("changed"); // parity advisory moved (red vs blue → divergent)
  });

  it("re-records when the Figma snapshot changes even if the verdict status is unchanged (from_snapshot in the key)", async () => {
    const id = upsertComponent(db, { key: "buttons/button", name: "Button", codeInstance: "sb", codeTarget: "Button" });
    setFigmaLink(db, "buttons/button", "ACME1", "10:2");
    const vc = upsertVariant(db, { componentId: id, source: "code", name: "default@1280" });
    const codeImg = await put(".visual-baselines/sb/Button/default@1280.png", [0, 0, 255]); // blue
    appendSnapshot(db, { componentId: id, variantId: vc, source: "code", imagePath: codeImg.path, imageHash: codeImg.hash, approved: true });
    // First design: red (divergent → 'changed').
    const f1 = await put(".visual-baselines/.figma/ACME1/10-2/default@0.png", [255, 0, 0]);
    appendSnapshot(db, { componentId: id, source: "figma", imagePath: f1.path, imageHash: f1.hash, approved: true });
    await runConformance({ db, cwd: tmp });
    const after1 = (db.prepare(`SELECT COUNT(*) AS n FROM regressions WHERE axis='figma_vs_code'`).get() as { n: number }).n;

    // The Figma design changes to green (a NEW figma snapshot) — still divergent → still status 'changed'.
    const f2 = await put(".visual-baselines/.figma/ACME1/10-2/default@0.png", [0, 200, 0]);
    appendSnapshot(db, { componentId: id, source: "figma", imagePath: f2.path, imageHash: f2.hash, approved: true });
    await runConformance({ db, cwd: tmp });
    const after2 = (db.prepare(`SELECT COUNT(*) AS n FROM regressions WHERE axis='figma_vs_code'`).get() as { n: number }).n;
    expect(after2).toBe(after1 + 1); // a genuine Figma change is recorded, not dropped by the guard
  });

  it("persists diff_ratio = max(dimensionDelta, paletteDelta) — a dimension-only divergence is not ~0", async () => {
    const id = upsertComponent(db, { key: "buttons/button", name: "Button", codeInstance: "sb", codeTarget: "Button" });
    setFigmaLink(db, "buttons/button", "ACME1", "10:2");
    const vc = upsertVariant(db, { componentId: id, source: "code", name: "default@1280" });
    // SAME color (paletteDelta ≈ 0) but very different dimensions: 40×40 code vs 160×40 figma →
    // dimensionDelta = 120/160 = 0.75. The persisted diff_ratio must be the dimension term, not palette's ~0.
    const codeImg = await put(".visual-baselines/sb/Button/default@1280.png", [0, 0, 255], [40, 40]);
    appendSnapshot(db, { componentId: id, variantId: vc, source: "code", imagePath: codeImg.path, imageHash: codeImg.hash, approved: true });
    const figmaImg = await put(".visual-baselines/.figma/ACME1/10-2/default@0.png", [0, 0, 255], [160, 40]);
    appendSnapshot(db, { componentId: id, source: "figma", imagePath: figmaImg.path, imageHash: figmaImg.hash, approved: true });

    await runConformance({ db, cwd: tmp });

    const row = db
      .prepare(`SELECT diff_ratio AS r FROM regressions WHERE component_id=? AND axis='figma_vs_code' ORDER BY id DESC LIMIT 1`)
      .get(id) as { r: number };
    expect(row.r).toBeGreaterThan(0.5); // reverting to paletteDelta alone would store ~0 here
    expect(row.r).toBeCloseTo(0.75, 2);
  });

  it("scores aligned (identical) → parity 'same', and skips a one-sided (figma-only) component", async () => {
    // figma-only component → skipped (no code side to compare).
    const figmaOnly = upsertComponent(db, { key: "overlay/tip", name: "Tip" });
    setFigmaLink(db, "overlay/tip", "ACME1", "9:9");
    const tipImg = await put(".visual-baselines/.figma/ACME1/9-9/default@0.png", [10, 20, 30]);
    appendSnapshot(db, { componentId: figmaOnly, source: "figma", imagePath: tipImg.path, imageHash: tipImg.hash, approved: true });

    // aligned component → identical figma + code → 'same'.
    const id = upsertComponent(db, { key: "layout/card", name: "Card", codeInstance: "sb", codeTarget: "Card" });
    setFigmaLink(db, "layout/card", "ACME1", "11:5");
    const vc = upsertVariant(db, { componentId: id, source: "code", name: "default@1280" });
    const same = await put(".visual-baselines/sb/Card/default@1280.png", [40, 160, 80]);
    appendSnapshot(db, { componentId: id, variantId: vc, source: "code", imagePath: same.path, imageHash: same.hash, approved: true });
    const sameFigma = await put(".visual-baselines/.figma/ACME1/11-5/default@0.png", [40, 160, 80]); // identical color
    appendSnapshot(db, { componentId: id, source: "figma", imagePath: sameFigma.path, imageHash: sameFigma.hash, approved: true });

    const summary = await runConformance({ db, cwd: tmp });
    expect(summary.skipped).toBe(1); // the figma-only Tip
    expect(summary.byLevel.aligned).toBe(1); // the identical Card
    expect(getComponentByKey(db, "layout/card")?.parity_status).toBe("same");
  });
});
