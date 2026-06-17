import sharp from "sharp";
import { differenceCiede2000 } from "culori";

/**
 * Component Studio conformance scorer (P5, SPEC §14). A **tolerant, advisory** Figma↔code comparison —
 * deliberately NOT the pixel-exact regression gate. It answers "does the built component roughly match
 * the design?" with a coarse dimension delta + a downscaled-grid perceptual color distance (CIEDE2000),
 * collapsed to `aligned | minor | divergent`. This level only ever fills the informational
 * `regressions.axis = 'figma_vs_code'` row and the parity badge; it can never gate CI (see ci.ts).
 *
 * Pure-ish: decodes two image buffers via `sharp` (like `diff.ts`) and is unit-tested on fixtures.
 */

export type ConformanceLevel = "aligned" | "minor" | "divergent";

export interface ConformanceResult {
  /** Relative dimension difference, 0..1 (max of the width/height relative deltas). */
  dimensionDelta: number;
  /** Coarse perceptual color distance, 0..1 (mean per-cell CIEDE2000 over a downscaled grid, /100). */
  paletteDelta: number;
  level: ConformanceLevel;
}

// Advisory thresholds (tunable). Kept lenient: cross-source rendering differs in AA, fonts, and
// sub-pixel layout, so only a clear difference should read "divergent".
const DIM_MINOR = 0.06;
const DIM_DIVERGENT = 0.2;
const PALETTE_MINOR = 0.06; // CIEDE2000 ~6 — past "just noticeable"
const PALETTE_DIVERGENT = 0.25; // CIEDE2000 ~25 — a clearly different palette
const GRID = 8; // downscale both images to GRID×GRID and compare corresponding cells

const deltaE = differenceCiede2000();

function relDimensionDelta(
  a: { width: number; height: number },
  b: { width: number; height: number },
): number {
  const dw = Math.abs(a.width - b.width) / Math.max(a.width, b.width, 1);
  const dh = Math.abs(a.height - b.height) / Math.max(a.height, b.height, 1);
  return Math.max(dw, dh);
}

/** Downscale to GRID×GRID over a white backdrop (so transparency reads consistently) → RGB cells 0..1. */
async function colorGrid(buf: Buffer): Promise<{ r: number; g: number; b: number }[]> {
  const { data } = await sharp(buf)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(GRID, GRID, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cells: { r: number; g: number; b: number }[] = [];
  for (let i = 0; i < GRID * GRID; i++) {
    cells.push({
      r: (data[i * 3] ?? 0) / 255,
      g: (data[i * 3 + 1] ?? 0) / 255,
      b: (data[i * 3 + 2] ?? 0) / 255,
    });
  }
  return cells;
}

function classify(dimensionDelta: number, paletteDelta: number): ConformanceLevel {
  if (dimensionDelta > DIM_DIVERGENT || paletteDelta > PALETTE_DIVERGENT) {
    return "divergent";
  }
  if (dimensionDelta > DIM_MINOR || paletteDelta > PALETTE_MINOR) {
    return "minor";
  }
  return "aligned";
}

/**
 * Score how well a code render conforms to its Figma design. Returns the dimension + palette deltas and
 * the collapsed {@link ConformanceLevel}. Never throws on size mismatch (the grid normalizes both sides);
 * an undecodable buffer rejects (the caller records `error`, never aborting the whole sync).
 */
export async function conformance(figma: Buffer, code: Buffer): Promise<ConformanceResult> {
  const [fm, cm, fg, cg] = await Promise.all([
    sharp(figma).metadata(),
    sharp(code).metadata(),
    colorGrid(figma),
    colorGrid(code),
  ]);
  const dimensionDelta = relDimensionDelta(
    { width: fm.width ?? 0, height: fm.height ?? 0 },
    { width: cm.width ?? 0, height: cm.height ?? 0 },
  );
  let sum = 0;
  for (let i = 0; i < fg.length; i++) {
    const a = fg[i] ?? { r: 0, g: 0, b: 0 };
    const b = cg[i] ?? { r: 0, g: 0, b: 0 };
    sum += deltaE({ mode: "rgb", ...a }, { mode: "rgb", ...b });
  }
  const paletteDelta = Math.min(1, sum / fg.length / 100);
  return { dimensionDelta, paletteDelta, level: classify(dimensionDelta, paletteDelta) };
}

/** Map a conformance level to the advisory `figma_vs_code` regression status persisted in the DB. */
export function levelToStatus(level: ConformanceLevel): "same" | "changed" | "regression" {
  // `divergent` is recorded as `changed` (advisory) — NEVER `regression`, which is the code-gate axis.
  if (level === "aligned") {
    return "same";
  }
  return "changed";
}
