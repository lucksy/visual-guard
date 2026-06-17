import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, type DB } from "../scripts/lib/studio/db";
import {
  appendSnapshot,
  recordComparison,
  upsertComponent,
  upsertVariant,
} from "../scripts/lib/studio/store";
import { planPrune, applyPrune, pruneStudio } from "../scripts/lib/studio/prune";

const RET = { retainPerSource: 20, retainCurrent: 3, pruneOrphanBlobs: true };

describe("planPrune — retention window, never touching approved baselines", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("keeps the newest N non-approved per lane and never deletes approved snapshots", () => {
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vc = upsertVariant(db, { componentId: cid, source: "code", name: "default@1280" });
    // One approved baseline (committed) + 6 non-approved current renders.
    appendSnapshot(db, { componentId: cid, variantId: vc, source: "code", imagePath: ".visual-baselines/k.png", imageHash: "base", approved: true });
    for (let i = 0; i < 6; i++) {
      appendSnapshot(db, {
        componentId: cid,
        variantId: vc,
        source: "current",
        imagePath: `.visual-guard/cache/blobs/cur${i}.png`,
        imageHash: `cur${i}`,
      });
    }
    const plan = planPrune(db, { retainPerSource: 20, retainCurrent: 3 });
    // retainCurrent=3 → 6 current minus 3 = 3 deleted; the approved baseline is never in the plan.
    expect(plan.deleteSnapshotIds).toHaveLength(3);
    // The surviving 3 current blobs' hashes are referenced (cur5, cur4, cur3 — newest first).
    expect([...plan.referencedBlobHashes].sort()).toEqual(["cur3", "cur4", "cur5"]);
  });

  it("applies the per-source window for code/figma history (retainPerSource)", () => {
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vf = upsertVariant(db, { componentId: cid, source: "figma", name: "default@0" });
    for (let i = 0; i < 5; i++) {
      appendSnapshot(db, { componentId: cid, variantId: vf, source: "figma", imagePath: `.visual-baselines/.figma/f${i}.png`, imageHash: `f${i}`, approved: false });
    }
    const plan = planPrune(db, { retainPerSource: 2, retainCurrent: 3 });
    expect(plan.deleteSnapshotIds).toHaveLength(3); // 5 - 2 kept = 3 deleted
  });

  it("applyPrune cascades regressions and is idempotent", () => {
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vc = upsertVariant(db, { componentId: cid, source: "code", name: "v" });
    const s1 = appendSnapshot(db, { componentId: cid, variantId: vc, source: "current", imagePath: ".visual-guard/cache/blobs/a.png", imageHash: "a" });
    const s2 = appendSnapshot(db, { componentId: cid, variantId: vc, source: "current", imagePath: ".visual-guard/cache/blobs/b.png", imageHash: "b" });
    recordComparison(db, { componentId: cid, axis: "current_vs_baseline", fromSnapshot: s1.id, toSnapshot: s2.id, status: "regression" });
    // Delete s1 → its regression (from_snapshot=s1) cascades away.
    expect(applyPrune(db, [s1.id])).toBe(1);
    const regs = db.prepare(`SELECT COUNT(*) AS n FROM regressions`).get() as { n: number };
    expect(regs.n).toBe(0);
    expect(applyPrune(db, [])).toBe(0); // idempotent / empty plan
  });
});

describe("pruneStudio — full orchestration over a temp dir (rows + blob sweep)", () => {
  let tmp = "";
  let db: DB;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-prune-"));
    mkdirSync(join(tmp, ".visual-guard", "cache", "blobs"), { recursive: true });
    db = openDb(join(tmp, ".visual-guard", "studio.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("deletes out-of-window history, sweeps orphan blobs, keeps referenced + committed baselines", () => {
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vc = upsertVariant(db, { componentId: cid, source: "code", name: "v" });
    // A committed baseline (approved) — its file lives under .visual-baselines, never swept.
    appendSnapshot(db, { componentId: cid, variantId: vc, source: "code", imagePath: ".visual-baselines/k.png", imageHash: "base", approved: true });
    // 5 current renders, each with a real blob file on disk. Blob names are sha256-HEX (what the sweep
    // regex matches), so the test mirrors real `cache/blobs/<sha>.png` layout: "00".."44", oldest first.
    const blobDir = join(tmp, ".visual-guard", "cache", "blobs");
    const hex = (i: number): string => `${i}${i}`; // 00, 11, 22, 33, 44 — all valid hex
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(blobDir, `${hex(i)}.png`), `png${i}`);
      appendSnapshot(db, { componentId: cid, variantId: vc, source: "current", imagePath: `.visual-guard/cache/blobs/${hex(i)}.png`, imageHash: hex(i) });
    }
    // An orphan blob with no snapshot row at all (hex-named, so the sweep considers it).
    writeFileSync(join(blobDir, "ff.png"), "orphan");

    const summary = pruneStudio(db, RET, { outRoot: ".visual-guard", cwd: tmp });

    // retainCurrent=3 → 2 of the 5 current rows deleted (oldest: 00, 11).
    expect(summary.deletedSnapshots).toBe(2);
    // Swept: the 2 now-orphaned current blobs (00, 11) + the never-referenced orphan (ff) = 3.
    expect(summary.removedBlobs).toBe(3);
    // The newest 3 current blobs survive; the committed baseline file would too (it's not in cache).
    expect(existsSync(join(blobDir, "44.png"))).toBe(true);
    expect(existsSync(join(blobDir, "00.png"))).toBe(false);
    expect(existsSync(join(blobDir, "ff.png"))).toBe(false);
    // The approved baseline row is untouched.
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM snapshots WHERE approved = 1`).get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("VACUUMs OUTSIDE any transaction when freed pages exceed the threshold", () => {
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vc = upsertVariant(db, { componentId: cid, source: "code", name: "v" });
    for (let i = 0; i < 6; i++) {
      const hx = i.toString(16).padStart(2, "0");
      writeFileSync(join(tmp, ".visual-guard", "cache", "blobs", `${hx}.png`), "x");
      appendSnapshot(db, { componentId: cid, variantId: vc, source: "current", imagePath: `.visual-guard/cache/blobs/${hx}.png`, imageHash: hx });
    }
    // threshold -1 → always VACUUM, deterministically exercising the branch + the "VACUUM must not run
    // inside a transaction" invariant (applyPrune's transaction has already committed; if they were
    // nested, db.exec("VACUUM") would throw "cannot VACUUM from within a transaction").
    const summary = pruneStudio(db, { ...RET, vacuumThreshold: -1 }, { outRoot: ".visual-guard", cwd: tmp });
    expect(summary.vacuumed).toBe(true);
    expect(summary.deletedSnapshots).toBe(3); // 6 current − retainCurrent 3
    // The DB is still usable after VACUUM (it didn't throw / corrupt).
    expect((db.prepare(`SELECT COUNT(*) AS n FROM snapshots`).get() as { n: number }).n).toBe(3);
  });

  it("cascades regressions through the full pruneStudio orchestration when their snapshots are pruned", () => {
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vc = upsertVariant(db, { componentId: cid, source: "code", name: "v" });
    const base = appendSnapshot(db, { componentId: cid, variantId: vc, source: "code", imagePath: ".visual-baselines/b.png", imageHash: "base", approved: true });
    for (let i = 0; i < 5; i++) {
      const hx = `c${i}`; // not a valid blob hex, so the file isn't swept — we're testing row cascade
      const snap = appendSnapshot(db, { componentId: cid, variantId: vc, source: "current", imagePath: `.visual-guard/cache/blobs/${hx}.png`, imageHash: hx });
      recordComparison(db, { componentId: cid, axis: "current_vs_baseline", fromSnapshot: base.id, toSnapshot: snap.id, status: "regression" });
    }
    expect((db.prepare(`SELECT COUNT(*) AS n FROM regressions`).get() as { n: number }).n).toBe(5);
    pruneStudio(db, RET, { outRoot: ".visual-guard", cwd: tmp }); // retainCurrent 3 → deletes 2 oldest
    // The 2 pruned current snapshots' regressions (to_snapshot cascade) are gone with them.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM regressions`).get() as { n: number }).n).toBe(3);
  });

  it("a second prune on an unchanged DB deletes nothing (idempotent)", () => {
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vc = upsertVariant(db, { componentId: cid, source: "code", name: "v" });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(tmp, ".visual-guard", "cache", "blobs", `0${i}.png`), "x");
      appendSnapshot(db, { componentId: cid, variantId: vc, source: "current", imagePath: `.visual-guard/cache/blobs/0${i}.png`, imageHash: `0${i}` });
    }
    pruneStudio(db, RET, { outRoot: ".visual-guard", cwd: tmp });
    const second = pruneStudio(db, RET, { outRoot: ".visual-guard", cwd: tmp });
    expect(second.deletedSnapshots).toBe(0);
    expect(second.removedBlobs).toBe(0);
  });
});
