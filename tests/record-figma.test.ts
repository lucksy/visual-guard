import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { openDb, type DB } from "../scripts/lib/studio/db";
import {
  componentTimeline,
  countSnapshots,
  getComponentByKey,
  listRenameEvents,
  upsertComponent,
} from "../scripts/lib/studio/store";
import { figmaImagePath } from "../scripts/lib/studio/keys";
import { enumerateFigma, matchFigma, recordFigma } from "../scripts/studio/record-figma";

const png = (r: number, g: number, b: number): Promise<Buffer> =>
  sharp({ create: { width: 4, height: 4, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png()
    .toBuffer();

const BASE = ".visual-baselines";

describe("recordFigma — commit + dedupe-append a figma snapshot", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-recfig-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const base = async (db: DB, bytes: Buffer) =>
    recordFigma({
      db,
      componentKey: "inst/Button",
      fileKey: "AbC123",
      nodeId: "1:23",
      name: "Button",
      bytes,
      baselineDir: BASE,
      cwd: tmp,
    });

  it("writes the committed PNG + figma_meta.json and appends a source='figma' snapshot", async () => {
    const db = openDb(":memory:");
    const res = await base(db, await png(10, 20, 30));
    expect(res.inserted).toBe(true);
    expect(res.versionSeq).toBe(1);

    // committed baseline PNG at the layout path, and the meta index updated
    expect(existsSync(join(tmp, figmaImagePath(BASE, "AbC123", "1:23")))).toBe(true);
    const meta = JSON.parse(readFileSync(join(tmp, BASE, "figma_meta.json"), "utf8"));
    expect(meta.files[0].fileKey).toBe("AbC123");
    expect(meta.files[0].components[0].nodeId).toBe("1:23");

    // the component carries figma linkage and has one figma snapshot
    const comp = getComponentByKey(db, "inst/Button");
    expect(comp?.figma_file_key).toBe("AbC123");
    expect(comp?.figma_node_id).toBe("1:23");
    expect(componentTimeline(db, comp!.id, "figma")).toHaveLength(1);
    db.close();
  });

  it("is content-hash idempotent — identical bytes add no new history row", async () => {
    const db = openDb(":memory:");
    const bytes = await png(10, 20, 30);
    await base(db, bytes);
    const again = await base(db, bytes);
    expect(again.inserted).toBe(false);
    expect(countSnapshots(db, "figma")).toBe(1);
    db.close();
  });

  it("appends a new version when the design bytes change", async () => {
    const db = openDb(":memory:");
    await base(db, await png(10, 20, 30));
    const changed = await base(db, await png(200, 100, 50));
    expect(changed.inserted).toBe(true);
    expect(changed.versionSeq).toBe(2);
    db.close();
  });

  it("F1: a MATCHED code key persists codeKey into figma_meta.json + the link table", async () => {
    const db = openDb(":memory:");
    await base(db, await png(10, 20, 30)); // componentKey "inst/Button" is a real code key
    const meta = JSON.parse(readFileSync(join(tmp, BASE, "figma_meta.json"), "utf8"));
    expect(meta.files[0].components[0].codeKey).toBe("inst/Button");
    const link = db
      .prepare("SELECT component_key FROM figma_code_links WHERE figma_node_id = '1:23'")
      .get() as { component_key: string } | undefined;
    expect(link?.component_key).toBe("inst/Button");
    db.close();
  });

  it("F1: a FIGMA-ONLY node (figma/<file>/<node> key) writes NO codeKey and no link", async () => {
    const db = openDb(":memory:");
    await recordFigma({
      db,
      componentKey: "figma/AbC123/1:23", // the figma-only fallback key
      fileKey: "AbC123",
      nodeId: "1:23",
      name: "Button",
      bytes: await png(10, 20, 30),
      baselineDir: BASE,
      cwd: tmp,
    });
    const meta = JSON.parse(readFileSync(join(tmp, BASE, "figma_meta.json"), "utf8"));
    expect(meta.files[0].components[0].codeKey).toBeUndefined();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM figma_code_links").get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });

  it("F6: a live figma record rolls up lifecycle (figma-only, not left 'unknown')", async () => {
    const db = openDb(":memory:");
    await recordFigma({
      db,
      componentKey: "figma/AbC123/1:23", // figma-only node
      fileKey: "AbC123",
      nodeId: "1:23",
      name: "Button",
      bytes: await png(1, 2, 3),
      baselineDir: BASE,
      cwd: tmp,
    });
    expect(getComponentByKey(db, "figma/AbC123/1:23")?.lifecycle).toBe("figma-only");
    db.close();
  });

  it("F1: a node that un-matches CLEARS its codeKey in the committed meta (no stale re-link)", async () => {
    const db = openDb(":memory:");
    const common = { db, fileKey: "AbC123", nodeId: "1:23", name: "Button", baselineDir: BASE, cwd: tmp };
    // first sync: matched to a code component → codeKey persisted
    await recordFigma({ ...common, componentKey: "inst/Button", bytes: await png(1, 2, 3) });
    let meta = JSON.parse(readFileSync(join(tmp, BASE, "figma_meta.json"), "utf8"));
    expect(meta.files[0].components[0].codeKey).toBe("inst/Button");
    // next sync: the same node no longer matches → recorded under the figma-only key → codeKey cleared
    await recordFigma({ ...common, componentKey: "figma/AbC123/1:23", bytes: await png(4, 5, 6) });
    meta = JSON.parse(readFileSync(join(tmp, BASE, "figma_meta.json"), "utf8"));
    expect(meta.files[0].components[0].codeKey).toBeUndefined();
    db.close();
  });

  it("F2: a renamed figma node (same node id, new name) records a figma rename event", async () => {
    const db = openDb(":memory:");
    const rec = (name: string, bytes: Buffer) =>
      recordFigma({
        db,
        componentKey: "inst/Button",
        fileKey: "AbC123",
        nodeId: "1:23",
        name,
        bytes,
        baselineDir: BASE,
        cwd: tmp,
      });
    await rec("Button", await png(1, 2, 3));
    expect(listRenameEvents(db)).toHaveLength(0); // first record: no prior name → not a rename
    await rec("Primary Button", await png(9, 9, 9)); // same node id, new display name
    const [ev] = listRenameEvents(db);
    expect(ev?.side).toBe("figma");
    expect(ev?.from_name).toBe("Button");
    expect(ev?.to_name).toBe("Primary Button");
    expect(ev?.anchor).toBe("figma-node-id");
    expect(ev?.figma_node_id).toBe("1:23");
    // the committed meta adopts the new name, so a re-record in a later run won't re-fire
    const meta = JSON.parse(readFileSync(join(tmp, BASE, "figma_meta.json"), "utf8"));
    expect(meta.files[0].components[0].name).toBe("Primary Button");
    db.close();
  });
});

describe("matchFigma — resolve each node to a component key against the DB", () => {
  it("maps a matched figma node to its code component key and a leftover to a figma-only key", () => {
    const db = openDb(":memory:");
    upsertComponent(db, { key: "inst/Button", name: "Button", codeInstance: "inst", codeTarget: "Button" });
    const out = matchFigma({
      db,
      fileKey: "K",
      figmaComponents: [
        { nodeId: "1:1", name: "Button" },
        { nodeId: "2:2", name: "Tooltip" },
      ],
      overrides: {},
    });
    expect(out.resolved).toEqual(
      expect.arrayContaining([
        { nodeId: "1:1", name: "Button", componentKey: "inst/Button" },
        { nodeId: "2:2", name: "Tooltip", componentKey: "figma/K/2:2" },
      ]),
    );
    // matching persists the link on the matched code component (so a skipped capture → figma-pending)
    const row = getComponentByKey(db, "inst/Button");
    expect(row?.figma_file_key).toBe("K");
    expect(row?.figma_node_id).toBe("1:1");
    db.close();
  });
});

describe("enumerateFigma — parse a get_metadata XML file", () => {
  it("returns the components found in the XML", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vg-enum-"));
    try {
      writeFileSync(join(tmp, "meta.xml"), `<canvas id="0:1" name="P"><symbol id="9:9" name="Chip" /></canvas>`);
      expect(enumerateFigma("meta.xml", tmp)).toEqual([
        { nodeId: "9:9", name: "Chip", kind: "component", variants: [] },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
