import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { openDb, type DB } from "../scripts/lib/studio/db";
import {
  appendSnapshot,
  componentRegressions,
  getComponentById,
  latestRegression,
  latestSnapshotForSource,
  upsertComponent,
  upsertVariant,
} from "../scripts/lib/studio/store";
import { approveSnapshotAsBaseline } from "../scripts/lib/studio/approve";
import { blobPath } from "../scripts/lib/studio/keys";

/**
 * `approveSnapshotAsBaseline` is the studio's "approve as baseline" — it WRITES a committed PNG (the
 * durable source of truth) and mirrors it into the DB. These tests run over a real temp project dir (file
 * I/O) + an in-memory DB.
 */

const BASELINE = ".visual-baselines";

async function png(w: number, h: number, r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png()
    .toBuffer();
}

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

let tmp = "";
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vg-approve-"));
  // Both image roots must exist (resolveServableImage realpaths them).
  mkdirSync(join(tmp, ".visual-guard", "cache", "blobs"), { recursive: true });
  mkdirSync(join(tmp, BASELINE), { recursive: true });
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Seed a code component + variant + a `current` snapshot whose blob exists on disk. Returns ids. */
async function seedCurrent(): Promise<{ cid: number; vid: number; snapId: number; hash: string }> {
  const bytes = await png(10, 8, 200, 30, 30);
  const hash = sha256(bytes);
  const rel = blobPath(hash); // ".visual-guard/cache/blobs/<hash>.png"
  writeFileSync(join(tmp, rel), bytes);
  const cid = upsertComponent(db, {
    key: "inst/Button",
    name: "Button",
    codeInstance: "inst",
    codeTarget: "Button",
  });
  const vid = upsertVariant(db, { componentId: cid, source: "code", name: "Default@1280" });
  const snap = appendSnapshot(db, {
    componentId: cid,
    variantId: vid,
    source: "current",
    imagePath: rel.split("\\").join("/"),
    imageHash: hash,
    width: 10,
    height: 8,
  });
  return { cid, vid, snapId: snap.id, hash };
}

describe("approveSnapshotAsBaseline — promote a current render to the committed baseline", () => {
  it("writes the committed baseline PNG and mirrors it into the DB, clearing the regression", async () => {
    const { cid, snapId } = await seedCurrent();
    // Pretend the component currently reads as a regression.
    db.prepare(`UPDATE components SET status='regression' WHERE id=?`).run(cid);

    const result = approveSnapshotAsBaseline({
      db,
      projectRoot: tmp,
      baselineDir: BASELINE,
      snapshotId: snapId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.promoted).toBe(true);
    expect(result.key).toBe("inst/Button/Default@1280.png");
    expect(result.baselinePath).toBe(".visual-baselines/inst/Button/Default@1280.png");

    // The committed PNG was written under the baseline dir.
    const writtenAbs = join(tmp, BASELINE, "inst", "Button", "Default@1280.png");
    expect(existsSync(writtenAbs)).toBe(true);

    // A `code` (approved) snapshot now exists and a `same` comparison cleared the regression.
    const baseline = latestSnapshotForSource(db, cid, "code");
    expect(baseline?.approved).toBe(1);
    expect(baseline?.image_hash).toBe(sha256(readFileSync(writtenAbs)));
    expect(latestRegression(db, cid, "current_vs_baseline")?.status).toBe("same");
    expect(getComponentById(db, cid)?.status).toBe("same");
  });

  it("is idempotent: approving an already-approved committed baseline is a no-op", async () => {
    const { snapId } = await seedCurrent();
    approveSnapshotAsBaseline({ db, projectRoot: tmp, baselineDir: BASELINE, snapshotId: snapId });
    // The promoted `code` snapshot is itself already an approved baseline.
    const baselineId = latestSnapshotForSource(db, /* cid */ 1, "code")!.id;
    const again = approveSnapshotAsBaseline({
      db,
      projectRoot: tmp,
      baselineDir: BASELINE,
      snapshotId: baselineId,
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.promoted).toBe(false);
  });

  it("is idempotent on the SAME current snapshot — a re-approve is a no-op (no redundant comparison row)", async () => {
    const { cid, snapId } = await seedCurrent();
    const first = approveSnapshotAsBaseline({ db, projectRoot: tmp, baselineDir: BASELINE, snapshotId: snapId });
    expect(first.ok && first.promoted).toBe(true);
    const rowsAfterFirst = componentRegressions(db, cid, "current_vs_baseline").length;

    // Re-approving the very same `current` render (the id the UI holds) must NOT re-copy or append a row.
    const second = approveSnapshotAsBaseline({ db, projectRoot: tmp, baselineDir: BASELINE, snapshotId: snapId });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.promoted).toBe(false);
    expect(componentRegressions(db, cid, "current_vs_baseline").length).toBe(rowsAfterFirst);
  });

  it("refuses to write through a committed directory symlink under the baseline dir (off-tree redirect)", async () => {
    const { snapId } = await seedCurrent();
    // A malicious committed symlink: .visual-baselines/inst → an out-of-tree dir.
    const outside = mkdtempSync(join(tmpdir(), "vg-outside-"));
    try {
      symlinkSync(outside, join(tmp, BASELINE, "inst"), "dir");
      const r = approveSnapshotAsBaseline({ db, projectRoot: tmp, baselineDir: BASELINE, snapshotId: snapId });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("forbidden");
      // Nothing was written through the symlink to the out-of-tree location.
      expect(existsSync(join(outside, "Button", "Default@1280.png"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a Figma snapshot (a design reference, not a code baseline)", async () => {
    const bytes = await png(4, 4, 0, 0, 0);
    const hash = sha256(bytes);
    const cid = upsertComponent(db, { key: "f", name: "F", figmaFileKey: "F", figmaNodeId: "1:1" });
    const snap = appendSnapshot(db, {
      componentId: cid,
      source: "figma",
      imagePath: ".visual-baselines/.figma/F/1-1/default@0.png",
      imageHash: hash,
    });
    const r = approveSnapshotAsBaseline({ db, projectRoot: tmp, baselineDir: BASELINE, snapshotId: snap.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_approvable");
  });

  it("rejects a snapshot with no variant lane (cannot map a baseline key)", async () => {
    const bytes = await png(4, 4, 1, 2, 3);
    const cid = upsertComponent(db, { key: "k", name: "K", codeInstance: "i", codeTarget: "t" });
    const snap = appendSnapshot(db, {
      componentId: cid,
      source: "current",
      imagePath: blobPath(sha256(bytes)).split("\\").join("/"),
      imageHash: sha256(bytes),
    });
    const r = approveSnapshotAsBaseline({ db, projectRoot: tmp, baselineDir: BASELINE, snapshotId: snap.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_approvable");
  });

  it("rejects a component with no code linkage", async () => {
    const bytes = await png(4, 4, 5, 5, 5);
    const hash = sha256(bytes);
    writeFileSync(join(tmp, blobPath(hash)), bytes);
    const cid = upsertComponent(db, { key: "f", name: "F", figmaFileKey: "F", figmaNodeId: "1:1" });
    const vid = upsertVariant(db, { componentId: cid, source: "code", name: "Default@1280" });
    const snap = appendSnapshot(db, {
      componentId: cid,
      variantId: vid,
      source: "current",
      imagePath: blobPath(hash).split("\\").join("/"),
      imageHash: hash,
    });
    const r = approveSnapshotAsBaseline({ db, projectRoot: tmp, baselineDir: BASELINE, snapshotId: snap.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_approvable");
  });

  it("404s an unknown snapshot id; image_unavailable when the source blob is missing", async () => {
    expect(approveSnapshotAsBaseline({ db, projectRoot: tmp, baselineDir: BASELINE, snapshotId: 9999 })).toMatchObject(
      { ok: false, code: "not_found" },
    );

    // A current snapshot whose blob file does NOT exist on disk → image_unavailable.
    const cid = upsertComponent(db, { key: "inst/B", name: "B", codeInstance: "inst", codeTarget: "B" });
    const vid = upsertVariant(db, { componentId: cid, source: "code", name: "Default@1280" });
    const snap = appendSnapshot(db, {
      componentId: cid,
      variantId: vid,
      source: "current",
      imagePath: ".visual-guard/cache/blobs/deadbeef.png",
      imageHash: "deadbeef",
    });
    const r = approveSnapshotAsBaseline({ db, projectRoot: tmp, baselineDir: BASELINE, snapshotId: snap.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("image_unavailable");
  });
});
