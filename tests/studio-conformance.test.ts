import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { conformance, levelToStatus } from "../scripts/lib/studio/conformance";

/**
 * P5 conformance scorer: advisory Figma↔code tolerance, NOT the pixel gate. Fixtures are solid color
 * boxes, so the downscaled-grid palette distance equals the single-color CIEDE2000 (verified ~3 for a
 * slight shift, ~87 for red↔green), and the dimension delta is exact.
 */

const box = (w: number, h: number, r: number, g: number, b: number): Promise<Buffer> =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png()
    .toBuffer();

describe("conformance(figma, code)", () => {
  it("identical image → aligned, zero deltas", async () => {
    const img = await box(180, 80, 79, 70, 229);
    const res = await conformance(img, img);
    expect(res.dimensionDelta).toBe(0);
    expect(res.paletteDelta).toBeCloseTo(0, 5);
    expect(res.level).toBe("aligned");
  });

  it("same size, a clearly different palette → divergent", async () => {
    const figma = await box(120, 120, 255, 0, 0); // red
    const code = await box(120, 120, 0, 255, 0); // green
    const res = await conformance(figma, code);
    expect(res.dimensionDelta).toBe(0);
    expect(res.paletteDelta).toBeGreaterThan(0.25);
    expect(res.level).toBe("divergent");
  });

  it("a moderate color shift at the same size → minor", async () => {
    const figma = await box(120, 120, 60, 120, 200);
    const code = await box(120, 120, 110, 140, 150); // CIEDE2000 in the minor band
    const res = await conformance(figma, code);
    expect(res.dimensionDelta).toBe(0);
    expect(res.paletteDelta).toBeGreaterThan(0.06);
    expect(res.paletteDelta).toBeLessThan(0.25);
    expect(res.level).toBe("minor");
  });

  it("a large dimension difference alone → divergent (even with the same color)", async () => {
    const figma = await box(100, 100, 80, 80, 80);
    const code = await box(160, 100, 80, 80, 80); // 60/160 = 0.375 > 0.2
    const res = await conformance(figma, code);
    expect(res.dimensionDelta).toBeGreaterThan(0.2);
    expect(res.paletteDelta).toBeCloseTo(0, 3);
    expect(res.level).toBe("divergent");
  });

  it("a small dimension difference → minor (not divergent)", async () => {
    const figma = await box(180, 80, 80, 80, 80);
    const code = await box(180, 72, 80, 80, 80); // 8/80 = 0.1 → between 0.06 and 0.2
    const res = await conformance(figma, code);
    expect(res.dimensionDelta).toBeCloseTo(0.1, 5);
    expect(res.level).toBe("minor");
  });

  it("rejects an undecodable buffer (the caller records 'error', never aborts the whole pass)", async () => {
    const valid = await box(120, 120, 79, 70, 229);
    const garbage = Buffer.from("not a png");
    await expect(conformance(garbage, valid)).rejects.toThrow();
    await expect(conformance(valid, garbage)).rejects.toThrow();
  });
});

describe("levelToStatus — divergent is advisory 'changed', never 'regression'", () => {
  it("maps levels to the figma_vs_code status", () => {
    expect(levelToStatus("aligned")).toBe("same");
    expect(levelToStatus("minor")).toBe("changed");
    expect(levelToStatus("divergent")).toBe("changed"); // NOT 'regression' — that's the code gate only
  });
});
