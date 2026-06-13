import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { diffImages } from "../scripts/lib/diff";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string): Buffer => readFileSync(join(fixtures, name));

describe("diffImages", () => {
  it("returns ratio 0 for identical images", async () => {
    const img = read("solid-10x10.png");
    const result = await diffImages(img, img, 0.1);
    expect(result.changedPixels).toBe(0);
    expect(result.ratio).toBe(0);
    expect(result.totalPixels).toBe(100);
    expect(result.dimensionDelta).toBeNull();
    expect(result.regions).toEqual([]);
  });

  it("reports the exact changed-pixel count and ratio for a known delta", async () => {
    const result = await diffImages(read("solid-10x10.png"), read("patch-2x2.png"), 0.1);
    expect(result.changedPixels).toBe(4);
    expect(result.totalPixels).toBe(100);
    expect(result.ratio).toBeCloseTo(0.04, 5);
    expect(result.dimensionDelta).toBeNull();
  });

  it("clusters a contiguous change into a single bounding box", async () => {
    const result = await diffImages(read("solid-10x10.png"), read("patch-2x2.png"), 0.1);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });

  it("separates disjoint changes into multiple bounding boxes", async () => {
    const result = await diffImages(read("solid-10x10.png"), read("two-patches.png"), 0.1);
    expect(result.changedPixels).toBe(2);
    expect(result.regions).toHaveLength(2);
    expect(result.regions).toContainEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(result.regions).toContainEqual({ x: 9, y: 9, width: 1, height: 1 });
  });

  it("handles mismatched dimensions without throwing and reports the delta", async () => {
    // baseline 10x10, current 8x10 -> delta = current - baseline = { width: -2, height: 0 }
    const result = await diffImages(read("solid-10x10.png"), read("solid-8x10.png"), 0.1);
    expect(result.dimensionDelta).toEqual({ width: -2, height: 0 });
    expect(result.changedPixels).toBe(0); // identical content over the 8x10 intersection
    expect(result.totalPixels).toBe(80);
    expect(result.ratio).toBe(0);
  });

  it("throws on undecodable input", async () => {
    await expect(
      diffImages(Buffer.from("definitely not a png"), read("solid-10x10.png"), 0.1),
    ).rejects.toThrow();
  });

  it("returns a decodable PNG diff image sized to the compared region", async () => {
    const result = await diffImages(read("solid-10x10.png"), read("patch-2x2.png"), 0.1);
    const meta = await sharp(result.diffImage).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(10);
    expect(meta.height).toBe(10);
  });
});
