import { describe, it, expect } from "vitest";
import { openDb, type DB } from "../scripts/lib/studio/db";
import {
  appendSnapshot,
  componentRegressions,
  componentTimeline,
  componentUsages,
  componentVariants,
  countComponents,
  countSnapshots,
  getComponentById,
  getComponentByKey,
  getSnapshotById,
  getVariantById,
  latestLaneStatus,
  latestRegression,
  latestSnapshot,
  latestSnapshotForSource,
  listComponents,
  listComponentsWithThumbs,
  markFigmaPending,
  recomputeStatus,
  recordComparison,
  recordUsage,
  setFigmaLink,
  setSyncState,
  summaryCounts,
  upsertComponent,
  upsertVariant,
} from "../scripts/lib/studio/store";

const fresh = (): DB => openDb(":memory:");

function uniqueError(): Error {
  return Object.assign(new Error("UNIQUE constraint failed"), {
    code: "SQLITE_CONSTRAINT_UNIQUE",
  });
}

describe("upsertComponent", () => {
  it("inserts and returns a stable id, and re-upsert by key merges without clobbering linkage", () => {
    const db = fresh();
    const id = upsertComponent(db, {
      key: "k",
      name: "A",
      figmaFileKey: "F",
      figmaNodeId: "1:2",
    });
    // a later upsert for the SAME key adds the code side and updates the name; figma side is kept
    const id2 = upsertComponent(db, { key: "k", name: "B", codeInstance: "i", codeTarget: "t" });
    expect(id2).toBe(id);
    const row = getComponentById(db, id);
    expect(row?.name).toBe("B");
    expect(row?.figma_file_key).toBe("F"); // COALESCE kept the earlier value
    expect(row?.code_instance).toBe("i");
    db.close();
  });
});

describe("upsertVariant", () => {
  it("is unique per component+source+name and returns a stable id", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const v1 = upsertVariant(db, { componentId: cid, source: "code", name: "default@1280" });
    const v1again = upsertVariant(db, { componentId: cid, source: "code", name: "default@1280" });
    const v2 = upsertVariant(db, { componentId: cid, source: "figma", name: "default@1280" });
    expect(v1again).toBe(v1);
    expect(v2).not.toBe(v1); // different source → different variant
    expect(componentVariants(db, cid)).toHaveLength(2);
    db.close();
  });

  it("persists render_url and COALESCE-merges it (never clobbered to null on re-upsert)", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const url = "http://localhost:61000/?story=k--default&mode=preview";
    upsertVariant(db, { componentId: cid, source: "code", name: "default@1280", renderUrl: url });
    expect(componentVariants(db, cid, "code")[0]!.render_url).toBe(url);

    // A later re-upsert without a render_url must keep the stored one (COALESCE merge).
    upsertVariant(db, { componentId: cid, source: "code", name: "default@1280" });
    expect(componentVariants(db, cid, "code")[0]!.render_url).toBe(url);

    // null when never provided.
    upsertVariant(db, { componentId: cid, source: "code", name: "hover@1280" });
    const hover = componentVariants(db, cid, "code").find((v) => v.name === "hover@1280");
    expect(hover!.render_url).toBeNull();
    db.close();
  });
});

describe("appendSnapshot — version_seq monotonicity + content-hash dedupe", () => {
  it("assigns version_seq 1, dedupes identical bytes, and bumps on a changed hash", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vid = upsertVariant(db, { componentId: cid, source: "code", name: "default@1280" });
    const lane = { componentId: cid, variantId: vid, source: "code" as const, imagePath: "p" };

    const first = appendSnapshot(db, { ...lane, imageHash: "h1" });
    expect(first).toMatchObject({ versionSeq: 1, inserted: true });

    const dup = appendSnapshot(db, { ...lane, imageHash: "h1" });
    expect(dup).toMatchObject({ id: first.id, versionSeq: 1, inserted: false });

    const changed = appendSnapshot(db, { ...lane, imageHash: "h2" });
    expect(changed).toMatchObject({ versionSeq: 2, inserted: true });

    expect(countSnapshots(db, "code")).toBe(2); // dedupe added no row
    db.close();
  });

  it("keeps independent lanes per (variant, source), including the default (NULL) lane", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vA = upsertVariant(db, { componentId: cid, source: "code", name: "a" });
    const vB = upsertVariant(db, { componentId: cid, source: "code", name: "b" });

    expect(appendSnapshot(db, { componentId: cid, variantId: vA, source: "code", imagePath: "x", imageHash: "h" }).versionSeq).toBe(1);
    expect(appendSnapshot(db, { componentId: cid, variantId: vB, source: "code", imagePath: "x", imageHash: "h" }).versionSeq).toBe(1);
    // default (variant_id NULL) lane is independent too, and monotonic within itself
    expect(appendSnapshot(db, { componentId: cid, source: "figma", imagePath: "x", imageHash: "h1" }).versionSeq).toBe(1);
    expect(appendSnapshot(db, { componentId: cid, source: "figma", imagePath: "x", imageHash: "h2" }).versionSeq).toBe(2);
    // dedupe holds on the NULL lane
    expect(appendSnapshot(db, { componentId: cid, source: "figma", imagePath: "x", imageHash: "h2" }).inserted).toBe(false);
    db.close();
  });

  it("recovers from a REAL UNIQUE collision (a stolen version_seq) by re-reading and retrying", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vid = upsertVariant(db, { componentId: cid, source: "code", name: "v" });
    appendSnapshot(db, { componentId: cid, variantId: vid, source: "code", imagePath: "p", imageHash: "h1" });

    // A racing writer that grabs exactly the version_seq the writer is about to use, so the writer's
    // own INSERT hits a GENUINE SQLITE_CONSTRAINT_UNIQUE (not a fabricated throw).
    const steal = db.prepare(
      `INSERT INTO snapshots (component_id, variant_id, source, image_path, image_hash, version_seq)
       VALUES (@cid, @vid, 'code', 'stolen', 'hx',
         (SELECT COALESCE(MAX(version_seq),0)+1 FROM snapshots
          WHERE component_id=@cid AND variant_id IS @vid AND source='code'))`,
    );
    let injected = false;
    const res = appendSnapshot(
      db,
      { componentId: cid, variantId: vid, source: "code", imagePath: "p2", imageHash: "h2" },
      {
        onBeforeInsert: (attempt) => {
          if (attempt === 1) {
            injected = true;
            steal.run({ cid, vid });
          }
        },
      },
    );
    expect(injected).toBe(true);
    expect(res).toMatchObject({ versionSeq: 2, inserted: true });
    // The stolen row was rolled back with the failed attempt; only h1@1 and h2@2 survive.
    expect(countSnapshots(db, "code")).toBe(2);
    db.close();
  });

  it("throws after exhausting retries on persistent collisions", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    expect(() =>
      appendSnapshot(
        db,
        { componentId: cid, source: "code", imagePath: "p", imageHash: "h" },
        { maxRetries: 2, onBeforeInsert: () => { throw uniqueError(); } },
      ),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it("rethrows a non-UNIQUE error immediately (no retry masking)", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    let calls = 0;
    expect(() =>
      appendSnapshot(
        db,
        { componentId: cid, source: "code", imagePath: "p", imageHash: "h" },
        { onBeforeInsert: () => { calls += 1; throw new Error("disk full"); } },
      ),
    ).toThrow(/disk full/);
    expect(calls).toBe(1); // not retried
    db.close();
  });

  it("enforces version_seq uniqueness even on the default (NULL-variant) lane", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    appendSnapshot(db, { componentId: cid, source: "figma", imagePath: "p", imageHash: "h1" }); // NULL lane, seq 1
    // A raw duplicate version_seq on the same NULL lane must fail (closed by the COALESCE expression index).
    expect(() =>
      db
        .prepare(
          `INSERT INTO snapshots (component_id, source, image_path, image_hash, version_seq)
           VALUES (?, 'figma', 'q', 'h2', 1)`,
        )
        .run(cid),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});

describe("read queries", () => {
  it("returns the timeline newest-first and the latest per lane", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vid = upsertVariant(db, { componentId: cid, source: "code", name: "v" });
    appendSnapshot(db, { componentId: cid, variantId: vid, source: "code", imagePath: "p", imageHash: "h1" });
    appendSnapshot(db, { componentId: cid, variantId: vid, source: "code", imagePath: "p", imageHash: "h2" });

    const timeline = componentTimeline(db, cid, "code");
    expect(timeline.map((s) => s.version_seq)).toEqual([2, 1]); // newest-first
    expect(latestSnapshot(db, cid, "code", vid)?.image_hash).toBe("h2");

    // also a figma snapshot, then the no-source variants return everything
    appendSnapshot(db, { componentId: cid, source: "figma", imagePath: "f", imageHash: "hf" });
    expect(componentTimeline(db, cid)).toHaveLength(3); // 2 code + 1 figma
    expect(countSnapshots(db)).toBe(3); // no-source total
    db.close();
  });

  it("latestSnapshotForSource returns the newest of a source across variant lanes", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vA = upsertVariant(db, { componentId: cid, source: "code", name: "a" });
    const vB = upsertVariant(db, { componentId: cid, source: "code", name: "b" });
    // Two code variants in different lanes; the most recently appended (vB) is the representative.
    appendSnapshot(db, { componentId: cid, variantId: vA, source: "code", imagePath: "a", imageHash: "ha" });
    appendSnapshot(db, { componentId: cid, variantId: vB, source: "code", imagePath: "b", imageHash: "hb" });
    expect(latestSnapshotForSource(db, cid, "code")?.image_hash).toBe("hb");
    // A source with no snapshot → undefined (used by the detail endpoint to emit null).
    expect(latestSnapshotForSource(db, cid, "figma")).toBeUndefined();
    db.close();
  });

  it("getSnapshotById returns the row or undefined for a missing id", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const snap = appendSnapshot(db, {
      componentId: cid,
      source: "figma",
      imagePath: ".visual-baselines/.figma/F/1-2/default@0.png",
      imageHash: "deadbeef",
      width: 10,
      height: 20,
    });
    const row = getSnapshotById(db, snap.id);
    expect(row?.image_path).toBe(".visual-baselines/.figma/F/1-2/default@0.png");
    expect(row?.image_hash).toBe("deadbeef");
    expect(getSnapshotById(db, 999999)).toBeUndefined();
    db.close();
  });

  it("filters listComponents by status and substring", () => {
    const db = fresh();
    const a = upsertComponent(db, { key: "buttons/primary", name: "Primary" });
    upsertComponent(db, { key: "cards/info", name: "Info" });
    // Give one component a real regression status so the status filter is discriminating.
    const s1 = appendSnapshot(db, { componentId: a, source: "code", imagePath: "x", imageHash: "h1" });
    const s2 = appendSnapshot(db, { componentId: a, source: "code", imagePath: "y", imageHash: "h2" });
    recordComparison(db, {
      componentId: a,
      axis: "current_vs_baseline",
      fromSnapshot: s1.id,
      toSnapshot: s2.id,
      status: "regression",
    });
    recomputeStatus(db, a);

    expect(listComponents(db).map((c) => c.key)).toEqual(["buttons/primary", "cards/info"]); // ordered by key
    expect(listComponents(db, { status: "regression" }).map((c) => c.key)).toEqual(["buttons/primary"]);
    expect(listComponents(db, { q: "card" }).map((c) => c.key)).toEqual(["cards/info"]);
    db.close();
  });

  it("treats q as a literal substring (LIKE wildcards are escaped, not interpreted)", () => {
    const db = fresh();
    upsertComponent(db, { key: "a_b/lit", name: "Literal" });
    upsertComponent(db, { key: "axb/wild", name: "Wild" });
    // '_' is a LIKE any-char wildcard; escaped, q='a_b' matches only the literal underscore.
    expect(listComponents(db, { q: "a_b" }).map((c) => c.key)).toEqual(["a_b/lit"]);
    expect(listComponents(db, { q: "%" })).toEqual([]); // '%' escaped → matches nothing literally
    db.close();
  });
});

describe("countComponents", () => {
  it("is a cheap COUNT(*) that tracks inserts", () => {
    const db = fresh();
    expect(countComponents(db)).toBe(0);
    upsertComponent(db, { key: "a", name: "A" });
    upsertComponent(db, { key: "b", name: "B" });
    upsertComponent(db, { key: "a", name: "A2" }); // re-upsert by key is not a new row
    expect(countComponents(db)).toBe(2);
    db.close();
  });
});

describe("listComponentsWithThumbs", () => {
  it("enriches each row with figma/code thumbnail ids + variant count in one query", () => {
    const db = fresh();
    const a = upsertComponent(db, { key: "buttons/primary", name: "Primary" });
    // 'current' is captured BEFORE 'code' here, yet the code thumbnail must still prefer the live
    // 'current' render over the committed 'code' baseline (the detail view's choice).
    const current = appendSnapshot(db, { componentId: a, source: "current", imagePath: "c", imageHash: "hc" });
    appendSnapshot(db, { componentId: a, source: "code", imagePath: "k", imageHash: "hk" });
    const figma = appendSnapshot(db, { componentId: a, source: "figma", imagePath: "f", imageHash: "hf" });
    upsertVariant(db, { componentId: a, source: "code", name: "default@1280" });
    upsertVariant(db, { componentId: a, source: "code", name: "hover@1280" });
    upsertVariant(db, { componentId: a, source: "figma", name: "default" });

    // A second component with only a committed code baseline (no current, no figma) and one variant.
    const b = upsertComponent(db, { key: "cards/info", name: "Info" });
    const bCode = appendSnapshot(db, { componentId: b, source: "code", imagePath: "bk", imageHash: "bh" });
    upsertVariant(db, { componentId: b, source: "code", name: "default@1280" });

    // A third, totally empty component.
    upsertComponent(db, { key: "empty/x", name: "Empty" });

    const rows = listComponentsWithThumbs(db);
    expect(rows.map((r) => r.key)).toEqual(["buttons/primary", "cards/info", "empty/x"]); // ordered by key
    const [ra, rb, rc] = rows;

    expect(ra!.figma_snapshot_id).toBe(figma.id);
    expect(ra!.code_snapshot_id).toBe(current.id); // prefers the live current render over the baseline
    expect(ra!.variant_count).toBe(2); // max(2 code, 1 figma)

    expect(rb!.figma_snapshot_id).toBeNull();
    expect(rb!.code_snapshot_id).toBe(bCode.id); // falls back to the code baseline when no current exists
    expect(rb!.variant_count).toBe(1);

    expect(rc!.figma_snapshot_id).toBeNull();
    expect(rc!.code_snapshot_id).toBeNull();
    expect(rc!.variant_count).toBe(0);
    db.close();
  });

  it("applies the same status/substring filter as listComponents", () => {
    const db = fresh();
    const a = upsertComponent(db, { key: "buttons/primary", name: "Primary" });
    upsertComponent(db, { key: "cards/info", name: "Info" });
    const s1 = appendSnapshot(db, { componentId: a, source: "code", imagePath: "x", imageHash: "h1" });
    const s2 = appendSnapshot(db, { componentId: a, source: "code", imagePath: "y", imageHash: "h2" });
    recordComparison(db, { componentId: a, axis: "current_vs_baseline", fromSnapshot: s1.id, toSnapshot: s2.id, status: "regression" });
    recomputeStatus(db, a);

    expect(listComponentsWithThumbs(db, { status: "regression" }).map((r) => r.key)).toEqual(["buttons/primary"]);
    expect(listComponentsWithThumbs(db, { q: "card" }).map((r) => r.key)).toEqual(["cards/info"]);
    expect(listComponentsWithThumbs(db, { q: "%" })).toEqual([]); // '%' escaped → literal, matches nothing
    db.close();
  });
});

describe("recordUsage / componentUsages", () => {
  it("records usages idempotently on (component, kind, used_in), ordered, and bounded by limit", () => {
    const db = fresh();
    const c = upsertComponent(db, { key: "buttons/primary", name: "Primary" });

    expect(recordUsage(db, { componentId: c, kind: "story", usedIn: "hover", detail: "inst" })).toBe(true);
    expect(recordUsage(db, { componentId: c, kind: "story", usedIn: "default", detail: "inst" })).toBe(true);
    // Re-recording the SAME (kind, used_in) is a no-op (INSERT OR IGNORE) → false, no duplicate row.
    expect(recordUsage(db, { componentId: c, kind: "story", usedIn: "hover", detail: "inst" })).toBe(false);

    const usages = componentUsages(db, c);
    expect(usages).toEqual([
      { kind: "story", used_in: "default", detail: "inst" },
      { kind: "story", used_in: "hover", detail: "inst" },
    ]); // ordered by kind then used_in

    expect(componentUsages(db, c, 1)).toHaveLength(1); // bounded by limit
    expect(componentUsages(db, c, 0)).toHaveLength(2); // a non-positive limit falls back to the default
    expect(componentUsages(db, c, 9999)).toHaveLength(2); // a huge limit is clamped (to 500), not an error
    db.close();
  });

  it("returns no usages for an unknown component", () => {
    const db = fresh();
    expect(componentUsages(db, 999)).toEqual([]);
    db.close();
  });
});

describe("recomputeStatus — rollup over the engine status map", () => {
  it("stays 'unknown' until a current_vs_baseline comparison exists (a baseline alone is not 'new')", () => {
    const db = fresh();
    const empty = upsertComponent(db, { key: "empty", name: "E" });
    expect(recomputeStatus(db, empty)).toBe("unknown");

    // A reindexed component HAS a baseline but no diff yet — it must NOT be labeled 'new' (= no baseline).
    const withCode = upsertComponent(db, { key: "c", name: "C" });
    appendSnapshot(db, { componentId: withCode, source: "code", imagePath: "p", imageHash: "h" });
    expect(recomputeStatus(db, withCode)).toBe("unknown");
    db.close();
  });

  it("adopts the latest current_vs_baseline status and records parity from figma_vs_code", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "c", name: "C" });
    const s1 = appendSnapshot(db, { componentId: cid, source: "code", imagePath: "a", imageHash: "h1" });
    const s2 = appendSnapshot(db, { componentId: cid, source: "code", imagePath: "b", imageHash: "h2" });
    recordComparison(db, {
      componentId: cid,
      axis: "current_vs_baseline",
      fromSnapshot: s1.id,
      toSnapshot: s2.id,
      diffRatio: 0.2,
      status: "regression",
    });
    const fig = appendSnapshot(db, { componentId: cid, source: "figma", imagePath: "f", imageHash: "hf" });
    recordComparison(db, {
      componentId: cid,
      axis: "figma_vs_code",
      fromSnapshot: fig.id,
      toSnapshot: s2.id,
      diffRatio: 0.5,
      status: "changed",
    });

    expect(recomputeStatus(db, cid)).toBe("regression");
    const row = getComponentById(db, cid);
    expect(row?.status).toBe("regression");
    expect(row?.parity_status).toBe("changed"); // advisory, separate axis
    db.close();
  });

  it("rolls status up to the WORST of the latest comparison per variant lane", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const v1 = upsertVariant(db, { componentId: cid, source: "code", name: "default@1280" });
    const v2 = upsertVariant(db, { componentId: cid, source: "code", name: "hover@1280" });
    const c1 = appendSnapshot(db, { componentId: cid, variantId: v1, source: "current", imagePath: "a", imageHash: "a" });
    const c2 = appendSnapshot(db, { componentId: cid, variantId: v2, source: "current", imagePath: "b", imageHash: "b" });
    recordComparison(db, { componentId: cid, axis: "current_vs_baseline", fromSnapshot: c1.id, toSnapshot: c1.id, status: "same" });
    recordComparison(db, { componentId: cid, axis: "current_vs_baseline", fromSnapshot: c2.id, toSnapshot: c2.id, status: "regression" });
    // one lane same, one lane regression → the component reads regression (the worst), not "last"
    expect(recomputeStatus(db, cid)).toBe("regression");
    db.close();
  });

  it("scopes the rollup to rendered lanes — a removed lane no longer pins the status", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vDef = upsertVariant(db, { componentId: cid, source: "code", name: "default@1280" });
    const vHover = upsertVariant(db, { componentId: cid, source: "code", name: "hover@1280" });
    const cDef = appendSnapshot(db, { componentId: cid, variantId: vDef, source: "current", imagePath: "a", imageHash: "a" });
    const cHover = appendSnapshot(db, { componentId: cid, variantId: vHover, source: "current", imagePath: "b", imageHash: "b" });
    recordComparison(db, { componentId: cid, axis: "current_vs_baseline", fromSnapshot: cDef.id, toSnapshot: cDef.id, status: "same" });
    recordComparison(db, { componentId: cid, axis: "current_vs_baseline", fromSnapshot: cHover.id, toSnapshot: cHover.id, status: "regression" });
    expect(recomputeStatus(db, cid)).toBe("regression"); // all lanes
    // only the default lane rendered this cycle → the stale hover regression is excluded
    expect(recomputeStatus(db, cid, new Set([vDef]))).toBe("same");
    db.close();
  });

  it("latestLaneStatus returns the most recent comparison status per lane", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const v = upsertVariant(db, { componentId: cid, source: "code", name: "v" });
    const c1 = appendSnapshot(db, { componentId: cid, variantId: v, source: "current", imagePath: "a", imageHash: "a" });
    recordComparison(db, { componentId: cid, axis: "current_vs_baseline", fromSnapshot: c1.id, toSnapshot: c1.id, status: "same" });
    expect(latestLaneStatus(db, cid, v)).toBe("same");
    expect(latestLaneStatus(db, cid, null)).toBeUndefined(); // a different lane has no comparison
    db.close();
  });
});

describe("figma linkage + pending (resumable sync, SPEC §9.5)", () => {
  it("setFigmaLink links a component by key without touching name/code fields", () => {
    const db = fresh();
    upsertComponent(db, { key: "inst/Button", name: "Button", codeInstance: "inst", codeTarget: "Button" });
    setFigmaLink(db, "inst/Button", "K", "1:2");
    const row = getComponentByKey(db, "inst/Button");
    expect(row?.figma_file_key).toBe("K");
    expect(row?.figma_node_id).toBe("1:2");
    expect(row?.name).toBe("Button");
    expect(row?.code_target).toBe("Button");
    db.close();
  });

  it("markFigmaPending flips linked-but-uncaptured components, leaving captured + code-only synced", () => {
    const db = fresh();
    upsertComponent(db, { key: "a", name: "A", figmaFileKey: "K", figmaNodeId: "1:1" }); // linked, no design
    const captured = upsertComponent(db, { key: "b", name: "B", figmaFileKey: "K", figmaNodeId: "2:2" });
    appendSnapshot(db, { componentId: captured, source: "figma", imagePath: "p", imageHash: "h" });
    upsertComponent(db, { key: "c", name: "C", codeInstance: "i", codeTarget: "C" }); // not figma-linked

    expect(markFigmaPending(db)).toBe(1);
    expect(getComponentByKey(db, "a")?.sync_state).toBe("figma-pending");
    expect(getComponentByKey(db, "b")?.sync_state).toBe("synced"); // has a captured design
    expect(getComponentByKey(db, "c")?.sync_state).toBe("synced"); // not figma-linked
    expect(markFigmaPending(db)).toBe(0); // idempotent
    db.close();
  });
});

describe("setSyncState", () => {
  it("updates sync_state and stamps last_attempt_at (figma-pending resumable state)", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    expect(getComponentById(db, cid)?.sync_state).toBe("synced"); // schema default
    setSyncState(db, cid, "figma-pending");
    const row = getComponentById(db, cid);
    expect(row?.sync_state).toBe("figma-pending");
    expect(row?.last_attempt_at).not.toBeNull();
    db.close();
  });
});

// --- P6: comparison reads, conformance breakdown, facets, summary -----------

/** Seed a component with a code variant + a `current` snapshot, returning ids for comparison tests. */
function seedForComparison(db: DB): { cid: number; vid: number; snapId: number } {
  const cid = upsertComponent(db, { key: "k", name: "K", codeInstance: "i", codeTarget: "t" });
  const vid = upsertVariant(db, { componentId: cid, source: "code", name: "Default@1280" });
  const snap = appendSnapshot(db, {
    componentId: cid,
    variantId: vid,
    source: "current",
    imagePath: "p",
    imageHash: "h1",
  });
  return { cid, vid, snapId: snap.id };
}

describe("recordComparison — conformance breakdown (v4) + latestRegression", () => {
  it("persists dimension/palette deltas and reads back the newest row per axis with the to-snapshot lane", () => {
    const db = fresh();
    const { cid, vid, snapId } = seedForComparison(db);
    recordComparison(db, {
      componentId: cid,
      axis: "current_vs_baseline",
      fromSnapshot: snapId,
      toSnapshot: snapId,
      diffRatio: 0.0123,
      status: "regression",
    });
    recordComparison(db, {
      componentId: cid,
      axis: "figma_vs_code",
      fromSnapshot: snapId,
      toSnapshot: snapId,
      diffRatio: 0.2,
      dimensionDelta: 0.2,
      paletteDelta: 0.01,
      status: "changed",
    });

    const code = latestRegression(db, cid, "current_vs_baseline");
    expect(code?.diff_ratio).toBeCloseTo(0.0123);
    expect(code?.status).toBe("regression");
    expect(code?.variant_id).toBe(vid); // joined from the `to` snapshot's lane
    expect(code?.dimension_delta).toBeNull(); // the code axis records no breakdown

    const parity = latestRegression(db, cid, "figma_vs_code");
    expect(parity?.dimension_delta).toBeCloseTo(0.2);
    expect(parity?.palette_delta).toBeCloseTo(0.01);
    db.close();
  });

  it("latestRegression returns undefined when there is no comparison on that axis", () => {
    const db = fresh();
    const { cid } = seedForComparison(db);
    expect(latestRegression(db, cid, "current_vs_baseline")).toBeUndefined();
    db.close();
  });
});

describe("componentRegressions — drift history (bounded, newest-first)", () => {
  it("returns the axis history newest-first and caps the row count", () => {
    const db = fresh();
    const { cid, snapId } = seedForComparison(db);
    for (let i = 0; i < 5; i++) {
      recordComparison(db, {
        componentId: cid,
        axis: "current_vs_baseline",
        fromSnapshot: snapId,
        toSnapshot: snapId,
        diffRatio: i / 100,
        status: "changed",
      });
    }
    const rows = componentRegressions(db, cid, "current_vs_baseline");
    expect(rows).toHaveLength(5);
    expect(rows[0]!.id).toBeGreaterThan(rows[rows.length - 1]!.id); // newest-first
    expect(componentRegressions(db, cid, "current_vs_baseline", 2)).toHaveLength(2);
    expect(componentRegressions(db, cid, "figma_vs_code")).toHaveLength(0); // only this axis
    db.close();
  });
});

describe("getVariantById", () => {
  it("returns the variant row, or undefined when absent", () => {
    const db = fresh();
    const cid = upsertComponent(db, { key: "k", name: "K" });
    const vid = upsertVariant(db, { componentId: cid, source: "code", name: "Default@1280" });
    expect(getVariantById(db, vid)?.name).toBe("Default@1280");
    expect(getVariantById(db, 9999)).toBeUndefined();
    db.close();
  });
});

describe("ListFilter facets (P6) — sync state, parity, presence, broadened search", () => {
  function seedFacets(db: DB): void {
    const both = upsertComponent(db, {
      key: "btn/primary",
      name: "Primary Button",
      description: "the main call to action",
      figmaFileKey: "F",
      figmaNodeId: "1:1",
      codeInstance: "i",
      codeTarget: "primary",
    });
    db.prepare(`UPDATE components SET parity_status='same' WHERE id=?`).run(both);
    upsertComponent(db, { key: "figma/F/2:2", name: "Ghost", figmaFileKey: "F", figmaNodeId: "2:2" });
    setSyncState(db, getComponentByKey(db, "figma/F/2:2")!.id, "figma-pending");
    upsertComponent(db, {
      key: "btn/link",
      name: "Link",
      description: "deprecated",
      codeInstance: "i",
      codeTarget: "link",
    });
  }

  it("filters by hasFigma / hasCode presence", () => {
    const db = fresh();
    seedFacets(db);
    expect(listComponents(db, { hasFigma: true }).map((c) => c.key).sort()).toEqual([
      "btn/primary",
      "figma/F/2:2",
    ]);
    expect(listComponents(db, { hasCode: false }).map((c) => c.key)).toEqual(["figma/F/2:2"]);
    expect(listComponents(db, { hasFigma: true, hasCode: true }).map((c) => c.key)).toEqual([
      "btn/primary",
    ]);
    db.close();
  });

  it("filters by sync state and parity (incl. NULL parity)", () => {
    const db = fresh();
    seedFacets(db);
    expect(listComponents(db, { syncState: "figma-pending" }).map((c) => c.key)).toEqual([
      "figma/F/2:2",
    ]);
    expect(listComponents(db, { parity: "same" }).map((c) => c.key)).toEqual(["btn/primary"]);
    expect(listComponents(db, { parity: null }).map((c) => c.key).sort()).toEqual([
      "btn/link",
      "figma/F/2:2",
    ]);
    db.close();
  });

  it("broadens the q search to the description (not just name/key) and applies on the thumbs query", () => {
    const db = fresh();
    seedFacets(db);
    expect(listComponents(db, { q: "call to action" }).map((c) => c.key)).toEqual(["btn/primary"]);
    expect(listComponents(db, { q: "deprecated" }).map((c) => c.key)).toEqual(["btn/link"]);
    expect(listComponentsWithThumbs(db, { hasCode: true }).map((c) => c.key).sort()).toEqual([
      "btn/link",
      "btn/primary",
    ]);
    db.close();
  });
});

describe("summaryCounts — health rollup", () => {
  it("buckets by status, sync state, and figma/code presence", () => {
    const db = fresh();
    const a = upsertComponent(db, {
      key: "a",
      name: "A",
      figmaFileKey: "F",
      figmaNodeId: "1:1",
      codeInstance: "i",
      codeTarget: "a",
    });
    db.prepare(`UPDATE components SET status='regression' WHERE id=?`).run(a);
    const b = upsertComponent(db, { key: "b", name: "B", figmaFileKey: "F", figmaNodeId: "2:2" });
    setSyncState(db, b, "figma-pending");
    upsertComponent(db, { key: "c", name: "C", codeInstance: "i", codeTarget: "c" });

    const s = summaryCounts(db);
    expect(s.total).toBe(3);
    expect(s.byStatus.regression).toBe(1);
    expect(s.byStatus.unknown).toBe(2); // schema default for the other two
    expect(s.bySyncState["figma-pending"]).toBe(1);
    expect(s.bySyncState.synced).toBe(2);
    expect(s.presence).toEqual({ both: 1, figmaOnly: 1, codeOnly: 1, neither: 0 });
    db.close();
  });

  it("reports all-zero buckets on an empty DB", () => {
    const db = fresh();
    const s = summaryCounts(db);
    expect(s.total).toBe(0);
    expect(s.presence).toEqual({ both: 0, figmaOnly: 0, codeOnly: 0, neither: 0 });
    db.close();
  });
});

