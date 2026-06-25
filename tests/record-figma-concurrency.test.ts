import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { openDb } from "../scripts/lib/studio/db";
import { studioDbPath } from "../scripts/lib/studio/keys";

/**
 * The race the cross-process lock closes: `/visual-sync` fans out BATCH=6 `record-figma` SUBPROCESSES
 * concurrently, all doing a read-modify-write of the ONE shared `figma_meta.json`. Before the lock, a
 * plain `writeFileSync` was last-writer-wins → a just-committed baseline silently vanished from the meta
 * (and thus from a later reindex). This spawns REAL concurrent recorder processes against one shared meta
 * and asserts EVERY node survives — the only test that actually exercises cross-process contention.
 */

const PLUGIN_ROOT = process.cwd();
const TSX = join(PLUGIN_ROOT, "node_modules", ".bin", "tsx");
const RECORD = join(PLUGIN_ROOT, "scripts", "studio", "record-figma.ts");
const BASE = ".visual-baselines";

function runRecord(cwd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [RECORD, "record", ...args], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

describe("recordFigma concurrency — no dropped baseline under parallel recorders", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-conc-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("N concurrent recorder processes each persist their node into figma_meta.json", async () => {
    const N = 8;
    // Pre-create the studio DB exactly as /visual-sync's Code phase does (it runs sync.ts → creates
    // studio.db BEFORE the figma Capture fan-out). The figma recorders then open an EXISTING DB, whose
    // steady-state write contention is handled by better-sqlite3's 5s busy_timeout — so this test isolates
    // the FIGMA_META.JSON race (the thing the lock fixes), not concurrent DB creation.
    openDb(join(tmp, studioDbPath(".visual-guard"))).close();

    // A distinct PNG per node (distinct content → distinct hashes; content is irrelevant to the race).
    const images: string[] = [];
    for (let i = 0; i < N; i++) {
      const p = join(tmp, `img${i}.png`);
      writeFileSync(
        p,
        await sharp({
          create: { width: 2, height: 2, channels: 4, background: { r: (i * 23) % 256, g: 0, b: 0, alpha: 1 } },
        })
          .png()
          .toBuffer(),
      );
      images.push(p);
    }

    // Fire all N recorders at once — they contend on the same .visual-baselines/figma_meta.json.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runRecord(tmp, [
          "--component-key",
          `figma/FILE/1:${i}`,
          "--file-key",
          "FILE",
          "--node-id",
          `1:${i}`,
          "--name",
          `Node${i}`,
          "--image",
          images[i] ?? "",
          "--baseline",
          BASE,
          "--out",
          ".visual-guard",
        ]),
      ),
    );
    const failed = results.filter((r) => r.code !== 0);
    expect(failed.map((r) => r.stderr).join("\n---\n")).toBe(""); // surface any subprocess error
    expect(results.map((r) => r.code)).toEqual(Array.from({ length: N }, () => 0));

    // The committed meta must contain ALL N nodes — none clobbered by an overlapping writer.
    const meta = JSON.parse(readFileSync(join(tmp, BASE, "figma_meta.json"), "utf8")) as {
      files: { components: { nodeId: string }[] }[];
    };
    const nodeIds = meta.files.flatMap((f) => f.components.map((c) => c.nodeId)).sort();
    expect(nodeIds).toEqual(Array.from({ length: N }, (_, i) => `1:${i}`).sort());
  }, 60_000);
});
