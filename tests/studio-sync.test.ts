import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { parseConfig, type Config } from "../scripts/lib/config";
import { openDb, type DB } from "../scripts/lib/studio/db";
import {
  componentTimeline,
  componentUsages,
  componentVariants,
  getComponentByKey,
  setFigmaLink,
} from "../scripts/lib/studio/store";
import { syncCodeFromRun, parseArgs, clampWatchIntervalMs } from "../scripts/studio/sync";

const config: Config = parseConfig({ targets: [{ type: "storybook", url: "http://x" }] });
const lenient: Config = parseConfig({ targets: [{ type: "storybook", url: "http://x" }], maxDiffRatio: 0.5 });
const strict: Config = parseConfig({ targets: [{ type: "storybook", url: "http://x" }], maxDiffRatio: 0.001 });
const BASE = ".visual-baselines";
const RUN = ".visual-guard/runs/r1/current";

async function png(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png()
    .toBuffer();
}

const black8 = (): Promise<Buffer> =>
  sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .png()
    .toBuffer();

// 8x8 black with a single white pixel → a tiny (1/64 ≈ 1.6%) same-dimension diff.
async function oneDot(): Promise<Buffer> {
  const dot = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .png()
    .toBuffer();
  return sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .composite([{ input: dot, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

describe("syncCodeFromRun — code capture → compare → persist", () => {
  let tmp = "";
  const put = (rel: string, bytes: Buffer): void => {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "vg-sync-"));
    const black = await png(0, 0, 0);
    const white = await png(255, 255, 255);
    // Button/default: baseline == current → same.  Button/hover: baseline != current → regression.
    put(`${BASE}/inst/Button/default@1280.png`, black);
    put(`${RUN}/inst/Button/default@1280.png`, black);
    put(`${BASE}/inst/Button/hover@1280.png`, black);
    put(`${RUN}/inst/Button/hover@1280.png`, white);
    // Card/default: current only, no baseline → new.
    put(`${RUN}/inst/Card/default@768.png`, await png(0, 0, 255));
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const sync = (db: DB) =>
    syncCodeFromRun({ db, config, currentDir: RUN, baselineDir: BASE, outRoot: ".visual-guard", cwd: tmp });

  it("persists current + baseline snapshots, comparisons, and rolled-up statuses", async () => {
    const db = openDb(":memory:");
    const summary = await sync(db);

    expect(summary.components).toBe(2); // Button, Card
    expect(summary.currentSnapshots).toBe(3);
    expect(summary.baselineSnapshots).toBe(2); // Button default + hover (Card has none)
    expect(summary.byStatus).toEqual({ same: 1, changed: 0, regression: 1, new: 1, error: 0 });

    // Button rolls up to the worst of its variants (default same, hover regression).
    expect(getComponentByKey(db, "inst/Button")?.status).toBe("regression");
    expect(getComponentByKey(db, "inst/Card")?.status).toBe("new");
    // sync marks touched components synced.
    expect(getComponentByKey(db, "inst/Button")?.sync_state).toBe("synced");
    // a 'current' snapshot exists for each render.
    expect(componentTimeline(db, getComponentByKey(db, "inst/Card")!.id, "current")).toHaveLength(1);
    db.close();
  });

  it("content-addresses each live render into the blob cache", async () => {
    const db = openDb(":memory:");
    await sync(db);
    const blobs = readdirSync(join(tmp, ".visual-guard", "cache", "blobs"));
    expect(blobs.filter((f) => f.endsWith(".png")).length).toBe(3); // one per distinct current render
    db.close();
  });

  it("persists each code variant's render_url from the run's renders.json sidecar", async () => {
    const db = openDb(":memory:");
    const previewUrl = "http://localhost:61000/?story=button--default&mode=preview";
    // The sidecar sits one dir up from current/ (the run dir), keyed by the same relative render path.
    put(
      ".visual-guard/runs/r1/renders.json",
      Buffer.from(
        JSON.stringify({
          version: 1,
          renders: {
            "inst/Button/default@1280.png": {
              url: previewUrl,
              kind: "ladle",
              viewport: 1280,
              currentDimensions: null,
            },
          },
        }),
      ),
    );
    await sync(db);
    const button = getComponentByKey(db, "inst/Button")!;
    const def = componentVariants(db, button.id, "code").find((v) => v.name === "default@1280");
    expect(def!.render_url).toBe(previewUrl);
    // A render with no sidecar entry stays null.
    const hover = componentVariants(db, button.id, "code").find((v) => v.name === "hover@1280");
    expect(hover!.render_url).toBeNull();
    db.close();
  });

  it("is idempotent — an unchanged re-run adds zero snapshots and zero comparisons", async () => {
    const db = openDb(":memory:");
    await sync(db);
    const second = await sync(db);
    expect(second.currentSnapshots).toBe(0);
    expect(second.baselineSnapshots).toBe(0);
    expect(second.comparisons).toBe(0); // nothing changed → no new comparison rows either
    db.close();
  });

  it("records each rendered state as a story usage (idempotent across re-syncs)", async () => {
    const db = openDb(":memory:");
    await sync(db);
    const button = getComponentByKey(db, "inst/Button")!;
    expect(componentUsages(db, button.id)).toEqual([
      { kind: "story", used_in: "default", detail: "inst" },
      { kind: "story", used_in: "hover", detail: "inst" },
    ]);
    const card = getComponentByKey(db, "inst/Card")!;
    expect(componentUsages(db, card.id)).toEqual([{ kind: "story", used_in: "default", detail: "inst" }]);
    // a re-sync re-observes the same states but must not duplicate usage rows
    await sync(db);
    expect(componentUsages(db, button.id)).toHaveLength(2);
    db.close();
  });

  it("reconciles a removed story out of the 'Used in' usages on re-sync", async () => {
    const db = openDb(":memory:");
    await sync(db);
    const button = getComponentByKey(db, "inst/Button")!;
    expect(componentUsages(db, button.id).map((u) => u.used_in)).toEqual(["default", "hover"]);

    // The 'hover' story is removed (its render no longer exists) — a re-sync must drop the stale usage,
    // matching how the status rollup drops non-rendered lanes.
    rmSync(join(tmp, `${RUN}/inst/Button/hover@1280.png`), { force: true });
    await sync(db);
    expect(componentUsages(db, button.id).map((u) => u.used_in)).toEqual(["default"]);
    db.close();
  });

  it("reports an undecodable render as 'error' without aborting the sync", async () => {
    put(`${BASE}/inst/Bad/default@1280.png`, await png(0, 0, 0)); // a valid baseline …
    put(`${RUN}/inst/Bad/default@1280.png`, Buffer.from("not a png")); // … but a corrupt current render
    const db = openDb(":memory:");
    const summary = await sync(db);
    expect(summary.byStatus.error).toBe(1);
    expect(getComponentByKey(db, "inst/Bad")?.status).toBe("error");
    // sibling components still sync — one undecodable render never aborts the whole pass
    expect(getComponentByKey(db, "inst/Card")?.status).toBe("new");
    db.close();
  });

  it("a code-only project (no figma, no baseline) still populates fully as 'new'", async () => {
    rmSync(join(tmp, BASE), { recursive: true, force: true }); // delete all baselines
    const db = openDb(":memory:");
    const summary = await sync(db);
    expect(summary.byStatus.new).toBe(3);
    expect(summary.baselineSnapshots).toBe(0);
    expect(getComponentByKey(db, "inst/Button")?.status).toBe("new");
    db.close();
  });

  it("classifies a below-gate diff as 'changed' (not same, not regression)", async () => {
    put(`${BASE}/inst/Dot/default@1280.png`, await black8());
    put(`${RUN}/inst/Dot/default@1280.png`, await oneDot());
    const db = openDb(":memory:");
    await syncCodeFromRun({ db, config: lenient, currentDir: RUN, baselineDir: BASE, outRoot: ".visual-guard", cwd: tmp });
    expect(getComponentByKey(db, "inst/Dot")?.status).toBe("changed");
    db.close();
  });

  it("re-records a comparison when the verdict changes even with identical bytes (gate tightened)", async () => {
    put(`${BASE}/inst/Dot/default@1280.png`, await black8());
    put(`${RUN}/inst/Dot/default@1280.png`, await oneDot());
    const db = openDb(":memory:");
    await syncCodeFromRun({ db, config: lenient, currentDir: RUN, baselineDir: BASE, outRoot: ".visual-guard", cwd: tmp });
    expect(getComponentByKey(db, "inst/Dot")?.status).toBe("changed");
    // same bytes, tighter maxDiffRatio → the verdict must flip and be re-recorded (not skipped as idempotent)
    const second = await syncCodeFromRun({ db, config: strict, currentDir: RUN, baselineDir: BASE, outRoot: ".visual-guard", cwd: tmp });
    expect(second.comparisons).toBeGreaterThan(0);
    expect(getComponentByKey(db, "inst/Dot")?.status).toBe("regression");
    db.close();
  });

  it("marks a figma-linked component with no captured design as figma-pending (resumable)", async () => {
    const db = openDb(":memory:");
    await sync(db);
    setFigmaLink(db, "inst/Button", "K", "1:1"); // simulate a prior match linking Button to a design
    await sync(db); // code sync's markFigmaPending flips the linked-but-uncaptured component
    expect(getComponentByKey(db, "inst/Button")?.sync_state).toBe("figma-pending");
    expect(getComponentByKey(db, "inst/Card")?.sync_state).toBe("synced"); // not figma-linked
    db.close();
  });

  it("drops a removed variant lane from the status rollup on re-sync", async () => {
    const db = openDb(":memory:");
    await sync(db); // Button: default same + hover regression → regression
    expect(getComponentByKey(db, "inst/Button")?.status).toBe("regression");
    rmSync(join(tmp, RUN, "inst", "Button", "hover@1280.png"), { force: true }); // hover story removed
    await sync(db); // only default renders now → the stale hover lane no longer pins status
    expect(getComponentByKey(db, "inst/Button")?.status).toBe("same");
    db.close();
  });
});

// --- P6: watch-mode CLI parsing -------------------------------------------

describe("clampWatchIntervalMs", () => {
  it("defaults to 2s, clamps to [1s, 3600s], floors fractional seconds", () => {
    expect(clampWatchIntervalMs(NaN)).toBe(2000);
    expect(clampWatchIntervalMs(0)).toBe(2000);
    expect(clampWatchIntervalMs(-5)).toBe(2000);
    expect(clampWatchIntervalMs(0.5)).toBe(1000); // floors to 0 → min 1s
    expect(clampWatchIntervalMs(5)).toBe(5000);
    expect(clampWatchIntervalMs(99999)).toBe(3600 * 1000);
  });
});

describe("parseArgs — --watch / --interval", () => {
  it("defaults watch off with a 2s interval", () => {
    const a = parseArgs([]);
    expect(a.watch).toBe(false);
    expect(a.intervalMs).toBe(2000);
  });
  it("parses --watch and a custom --interval (seconds → ms)", () => {
    const a = parseArgs(["--watch", "--interval", "5"]);
    expect(a.watch).toBe(true);
    expect(a.intervalMs).toBe(5000);
  });
  it("rejects a non-positive --interval", () => {
    expect(() => parseArgs(["--interval", "0"])).toThrow(/positive number of seconds/);
    expect(() => parseArgs(["--interval", "abc"])).toThrow(/positive number of seconds/);
  });
});
