import sharp from "sharp";
import pixelmatch from "pixelmatch";

/** A clustered rectangle of changed pixels, for the reviewer to focus on. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffResult {
  changedPixels: number;
  totalPixels: number;
  /** 0..1 changed-pixel fraction. `threshold` tunes pixelmatch sensitivity; compare.ts gates this against config.maxDiffRatio. */
  ratio: number;
  /** current minus baseline, or null when dimensions match. */
  dimensionDelta: { width: number; height: number } | null;
  /** Clustered changed areas (connected components, 8-connectivity). */
  regions: BoundingBox[];
  /** PNG of the compared region with changed pixels marked red — written to diff/ by compare.ts. */
  diffImage: Buffer;
}

interface GrayImage {
  /** RGBA bytes (R=G=B=luma, A=255), length = width * height * 4. */
  data: Buffer;
  width: number;
  height: number;
}

const RED: [number, number, number] = [255, 0, 0];

/**
 * Decode arbitrary image bytes, grayscale-normalize to dampen anti-aliasing / color
 * fringing (R1), and expand to RGBA so pixelmatch (which wants 4 channels) can consume it.
 * Throws on undecodable input — never returns a guess.
 */
async function toGrayRGBA(input: Buffer): Promise<GrayImage> {
  let raw: { data: Buffer; info: sharp.OutputInfo };
  try {
    raw = await sharp(input).grayscale().raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Visual Guard: could not decode image as a supported format (${detail}).`);
  }

  const { width, height, channels } = raw.info;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    // After grayscale every color channel holds the same luma; channel 0 is enough.
    const luma = raw.data[i * channels] ?? 0;
    rgba[i * 4] = luma;
    rgba[i * 4 + 1] = luma;
    rgba[i * 4 + 2] = luma;
    rgba[i * 4 + 3] = 255;
  }
  return { data: rgba, width, height };
}

/** Copy the top-left width x height window out of a (srcWidth-wide) RGBA buffer. */
function cropRGBA(rgba: Buffer, srcWidth: number, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    rgba.copy(out, y * width * 4, y * srcWidth * 4, y * srcWidth * 4 + width * 4);
  }
  return out;
}

/** Build a 1-byte-per-pixel mask of changed pixels from pixelmatch's red-marked diff. */
function maskFromDiff(diff: Buffer, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (diff[i * 4] === RED[0] && diff[i * 4 + 1] === RED[1] && diff[i * 4 + 2] === RED[2]) {
      mask[i] = 1;
    }
  }
  return mask;
}

/** Cluster changed pixels into bounding boxes via connected components (8-connectivity). */
function clusterRegions(mask: Uint8Array, width: number, height: number): BoundingBox[] {
  const visited = new Uint8Array(mask.length);
  const boxes: BoundingBox[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || visited[start] === 1) continue;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    stack.length = 0;
    stack.push(start);
    visited[start] = 1;

    while (stack.length > 0) {
      const idx = stack.pop();
      if (idx === undefined) break;
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nidx = ny * width + nx;
          if (mask[nidx] === 1 && visited[nidx] !== 1) {
            visited[nidx] = 1;
            stack.push(nidx);
          }
        }
      }
    }

    boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
  }

  return boxes;
}

/**
 * Compare two renders of the same target. Both inputs are raw image bytes; they are
 * grayscale-normalized before a pixelmatch pass with `includeAA: false`. On a dimension
 * mismatch the common (top-left intersection) region is diffed and the size delta is
 * reported separately — never a throw. Throws only on undecodable input.
 */
export async function diffImages(
  baseline: Buffer,
  current: Buffer,
  threshold: number,
): Promise<DiffResult> {
  const base = await toGrayRGBA(baseline);
  const cur = await toGrayRGBA(current);

  const dimensionDelta =
    base.width !== cur.width || base.height !== cur.height
      ? { width: cur.width - base.width, height: cur.height - base.height }
      : null;

  const cmpWidth = Math.min(base.width, cur.width);
  const cmpHeight = Math.min(base.height, cur.height);
  const totalPixels = cmpWidth * cmpHeight;

  if (totalPixels === 0) {
    // Degenerate (a zero-area image): no region to visualize — emit a 1x1 transparent PNG.
    const diffImage = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    return { changedPixels: 0, totalPixels: 0, ratio: 0, dimensionDelta, regions: [], diffImage };
  }

  const baseCrop = cropRGBA(base.data, base.width, cmpWidth, cmpHeight);
  const curCrop = cropRGBA(cur.data, cur.width, cmpWidth, cmpHeight);

  const diff = Buffer.alloc(cmpWidth * cmpHeight * 4);
  const changedPixels = pixelmatch(baseCrop, curCrop, diff, cmpWidth, cmpHeight, {
    threshold,
    includeAA: false,
    diffColor: RED,
  });

  const diffImage = await sharp(diff, { raw: { width: cmpWidth, height: cmpHeight, channels: 4 } })
    .png()
    .toBuffer();

  return {
    changedPixels,
    totalPixels,
    ratio: changedPixels / totalPixels,
    dimensionDelta,
    regions: clusterRegions(maskFromDiff(diff, cmpWidth, cmpHeight), cmpWidth, cmpHeight),
    diffImage,
  };
}
