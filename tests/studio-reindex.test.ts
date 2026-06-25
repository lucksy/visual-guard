import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { openDb, type DB } from "../scripts/lib/studio/db";
import {
  componentTimeline,
  componentUsages,
  componentVariants,
  getComponentByKey,
  linkForFigmaNode,
  listComponents,
} from "../scripts/lib/studio/store";
import { reindexInto, statusReport } from "../scripts/studio";

/** A distinct 2x2 PNG per RGB color, so different renders get different sha256 hashes. */
async function png(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png()
    .toBuffer();
}

const BASE = ".visual-baselines";

describe("studio reindex — rebuild the index from committed baselines", () => {
  let tmp = "";
  const put = async (rel: string, bytes: Buffer): Promise<void> => {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "vg-studio-"));
    // Code baselines: two Button variants + one Card, distinct content per file.
    await put(`${BASE}/localhost-6006/Button/default@1280.png`, await png(10, 0, 0));
    await put(`${BASE}/localhost-6006/Button/hover@1280.png`, await png(0, 20, 0));
    await put(`${BASE}/localhost-6006/Card/default@768.png`, await png(0, 0, 30));
    // Junk that must be skipped (not a 3-segment code render).
    await put(`${BASE}/stray.png`, await png(1, 1, 1));
    // Figma baseline + its committed meta.
    await put(`${BASE}/.figma/AbC123/1-23/default@0.png`, await png(40, 40, 40));
    writeFileSync(
      join(tmp, BASE, "figma_meta.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            fileKey: "AbC123",
            label: "Core",
            components: [
              {
                nodeId: "1:23",
                name: "Button",
                images: [{ path: `${BASE}/.figma/AbC123/1-23/default@0.png` }],
              },
            ],
          },
        ],
      }),
    );
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const reindexFresh = async (): Promise<DB> => {
    const db = openDb(":memory:");
    await reindexInto({ db, baselineDir: BASE, cwd: tmp });
    return db;
  };

  it("reconstructs one component per code group + the figma component, with snapshots", async () => {
    const db = openDb(":memory:");
    const summary = await reindexInto({ db, baselineDir: BASE, cwd: tmp });

    expect(summary.components).toBe(3); // Button (code), Card (code), figma/AbC123/1:23
    expect(summary.codeSnapshots).toBe(3);
    expect(summary.figmaSnapshots).toBe(1);
    expect(summary.skipped).toContain("stray.png");

    expect(listComponents(db).map((c) => c.key)).toEqual([
      "figma/AbC123/1:23",
      "localhost-6006/Button",
      "localhost-6006/Card",
    ]);

    const button = getComponentByKey(db, "localhost-6006/Button");
    expect(button?.code_instance).toBe("localhost-6006");
    expect(button?.code_target).toBe("Button");
    expect(button?.status).toBe("unknown"); // baselines indexed, no comparison computed yet

    const figma = getComponentByKey(db, "figma/AbC123/1:23");
    expect(figma?.figma_file_key).toBe("AbC123");
    expect(figma?.figma_node_id).toBe("1:23");
    expect(figma?.status).toBe("unknown"); // figma-only, no code snapshot

    // Button has two code variant lanes (default@1280, hover@1280), each one snapshot.
    const timeline = componentTimeline(db, button!.id, "code");
    expect(timeline).toHaveLength(2);
    expect(timeline.every((s) => s.approved === 1)).toBe(true);
    expect(timeline[0]?.image_path).toContain(".visual-baselines/localhost-6006/Button/");
    db.close();
  });

  it("rebuilds the 'Used in' usages from the same baseline keys (the DB stays a faithful cache)", async () => {
    const db = await reindexFresh();
    const button = getComponentByKey(db, "localhost-6006/Button")!;
    expect(componentUsages(db, button.id).map((u) => u.used_in)).toEqual(["default", "hover"]);
    const card = getComponentByKey(db, "localhost-6006/Card")!;
    expect(componentUsages(db, card.id).map((u) => u.used_in)).toEqual(["default"]);
    db.close();
  });

  it("is content-hash idempotent — a second reindex over the same DB adds no history", async () => {
    const db = openDb(":memory:");
    await reindexInto({ db, baselineDir: BASE, cwd: tmp });
    const second = await reindexInto({ db, baselineDir: BASE, cwd: tmp });
    expect(second.codeSnapshots).toBe(0); // every byte identical → deduped
    expect(second.figmaSnapshots).toBe(0);
    expect(listComponents(db)).toHaveLength(3);
    db.close();
  });

  it("is deterministic — two fresh rebuilds yield identical logical rows", async () => {
    const project = (db: DB) => ({
      components: listComponents(db).map((c) => ({
        key: c.key,
        name: c.name,
        status: c.status,
        figma_file_key: c.figma_file_key,
        code_instance: c.code_instance,
      })),
      snapshots: (
        db
          .prepare(
            `SELECT component_id, source, image_path, image_hash, version_seq, viewport, approved
             FROM snapshots ORDER BY image_path, source`,
          )
          .all() as unknown[]
      ),
    });
    const a = await reindexFresh();
    const b = await reindexFresh();
    expect(project(a)).toEqual(project(b));
    a.close();
    b.close();
  });

  it("statusReport confirms the DB is in sync with the committed baselines", async () => {
    const db = await reindexFresh();
    const report = statusReport({ db, baselineDir: BASE, cwd: tmp });
    expect(report).toMatchObject({
      components: 3,
      codeBaselineFiles: 3,
      codeSnapshots: 3,
      figmaBaselineFiles: 1,
      figmaSnapshots: 1,
      inSync: true,
    });
    db.close();
  });

  it("refuses a figma_meta image path that escapes the .figma/ subtree (traversal guard)", async () => {
    writeFileSync(
      join(tmp, BASE, "figma_meta.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            fileKey: "AbC123",
            components: [
              {
                nodeId: "1:23",
                name: "Button",
                images: [
                  { path: `${BASE}/localhost-6006/Button/default@1280.png` }, // inside baselineDir but OUTSIDE .figma/
                  { path: "../escape.png" }, // outright traversal
                ],
              },
            ],
          },
        ],
      }),
    );
    const db = openDb(":memory:");
    const summary = await reindexInto({ db, baselineDir: BASE, cwd: tmp });
    expect(summary.figmaSnapshots).toBe(0); // both escaping paths refused
    expect(summary.skipped).toContain("../escape.png");
    db.close();
  });

  it("keeps figma renders of the same node at different viewports in separate lanes", async () => {
    await put(`${BASE}/.figma/AbC123/1-23/default@2.png`, await png(50, 50, 50));
    writeFileSync(
      join(tmp, BASE, "figma_meta.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            fileKey: "AbC123",
            components: [
              {
                nodeId: "1:23",
                name: "Button",
                images: [
                  { path: `${BASE}/.figma/AbC123/1-23/default@0.png`, viewport: 0 },
                  { path: `${BASE}/.figma/AbC123/1-23/default@2.png`, viewport: 2 },
                ],
              },
            ],
          },
        ],
      }),
    );
    const db = openDb(":memory:");
    const summary = await reindexInto({ db, baselineDir: BASE, cwd: tmp });
    expect(summary.figmaSnapshots).toBe(2); // NOT collapsed into one lane
    const figma = getComponentByKey(db, "figma/AbC123/1:23")!;
    expect(componentVariants(db, figma.id, "figma").map((v) => v.name).sort()).toEqual([
      "default@0",
      "default@2",
    ]);
    expect(componentTimeline(db, figma.id, "figma")).toHaveLength(2);
    db.close();
  });

  it("refuses a committed symlink under .figma/ that points outside the tree (no host-file read)", async () => {
    const secret = join(tmp, "secret.txt");
    writeFileSync(secret, "TOP SECRET");
    const linkPath = join(tmp, BASE, ".figma", "AbC123", "1-23", "default@0.png");
    rmSync(linkPath, { force: true });
    try {
      symlinkSync(secret, linkPath); // lexically inside .figma/, but resolves outside
    } catch {
      return; // symlinks unsupported on this platform — skip
    }
    const db = openDb(":memory:");
    const summary = await reindexInto({ db, baselineDir: BASE, cwd: tmp });
    expect(summary.figmaSnapshots).toBe(0); // refused before any read
    expect(summary.skipped).toContain(`${BASE}/.figma/AbC123/1-23/default@0.png`);
    expect(getComponentByKey(db, "figma/AbC123/1:23")).toBeUndefined(); // no phantom component
    db.close();
  });

  it("statusReport flags a meta entry whose PNG is missing (inSync false, no phantom card)", async () => {
    rmSync(join(tmp, BASE, ".figma", "AbC123", "1-23", "default@0.png"), { force: true });
    const db = openDb(":memory:");
    const summary = await reindexInto({ db, baselineDir: BASE, cwd: tmp });
    expect(summary.figmaSnapshots).toBe(0);
    expect(summary.skipped).toContain(`${BASE}/.figma/AbC123/1-23/default@0.png`);
    expect(getComponentByKey(db, "figma/AbC123/1:23")).toBeUndefined();

    const report = statusReport({ db, baselineDir: BASE, cwd: tmp });
    expect(report.figmaBaselineFiles).toBe(1); // the meta declares one image…
    expect(report.figmaSnapshots).toBe(0); // …but none was indexed (PNG missing)
    expect(report.inSync).toBe(false); // surfaced, not a false all-clear
    db.close();
  });

  it("indexes an undecodable committed baseline by hash with null dimensions (graceful degradation)", async () => {
    await put(`${BASE}/localhost-6006/Bad/default@1280.png`, Buffer.from("NOT A PNG"));
    const db = openDb(":memory:");
    await reindexInto({ db, baselineDir: BASE, cwd: tmp });
    const bad = getComponentByKey(db, "localhost-6006/Bad")!;
    const snaps = componentTimeline(db, bad.id, "code");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.width).toBeNull();
    expect(snaps[0]?.height).toBeNull();
    db.close();
  });

  // --- F1: codeKey survives the destroy-and-rebuild and re-links the mapping ---

  it("without codeKey, the figma node stays a SEPARATE figma-only row (the historical behavior)", async () => {
    // Default fixture meta carries no codeKey, so figma Button is its own row → 3 components.
    const db = await reindexFresh();
    expect(listComponents(db).map((c) => c.key)).toEqual([
      "figma/AbC123/1:23",
      "localhost-6006/Button",
      "localhost-6006/Card",
    ]);
    const button = getComponentByKey(db, "localhost-6006/Button");
    expect(button?.figma_node_id).toBeNull(); // code row, no figma linkage
    expect(button?.lifecycle).toBe("code-only");
    expect(getComponentByKey(db, "figma/AbC123/1:23")?.lifecycle).toBe("figma-only");
    db.close();
  });

  it("with codeKey in the committed meta, reindex re-links figma onto the code row → ONE matched row", async () => {
    // Re-point the committed meta's figma node at the code Button via codeKey (what F1 persists).
    writeFileSync(
      join(tmp, BASE, "figma_meta.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            fileKey: "AbC123",
            label: "Core",
            components: [
              {
                nodeId: "1:23",
                name: "Button",
                codeKey: "localhost-6006/Button",
                images: [{ path: `${BASE}/.figma/AbC123/1-23/default@0.png` }],
              },
            ],
          },
        ],
      }),
    );
    const db = openDb(":memory:");
    await reindexInto({ db, baselineDir: BASE, cwd: tmp });

    // The figma snapshot merged onto the code row — no separate figma-only key, 2 components not 3.
    expect(getComponentByKey(db, "figma/AbC123/1:23")).toBeUndefined();
    expect(listComponents(db).map((c) => c.key)).toEqual([
      "localhost-6006/Button",
      "localhost-6006/Card",
    ]);
    const button = getComponentByKey(db, "localhost-6006/Button");
    expect(button?.code_target).toBe("Button"); // code linkage…
    expect(button?.figma_node_id).toBe("1:23"); // …AND figma linkage on ONE row
    expect(button?.lifecycle).toBe("matched");
    // both a code (default@1280, hover@1280) and a figma timeline on the same component
    expect(componentTimeline(db, button!.id, "figma")).toHaveLength(1);
    expect(componentTimeline(db, button!.id, "code")).toHaveLength(2);
    // durable link mirror recorded
    expect(linkForFigmaNode(db, "AbC123", "1:23")?.component_key).toBe("localhost-6006/Button");
    db.close();
  });
});
