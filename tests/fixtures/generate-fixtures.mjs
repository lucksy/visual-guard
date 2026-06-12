#!/usr/bin/env node
/**
 * Deterministic PNG fixtures for tests/diff.test.ts.
 *
 * Regenerate with:  node tests/fixtures/generate-fixtures.mjs
 *
 * Kept tiny and pure black/white so the post-grayscale luma delta is maximal — the
 * expected changed-pixel counts then hold regardless of the pixelmatch threshold.
 */
import pngjs from "pngjs";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { PNG } = pngjs;
const here = dirname(fileURLToPath(import.meta.url));

const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

function solid(width, height, rgba = BLACK) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgba[0];
    png.data[i * 4 + 1] = rgba[1];
    png.data[i * 4 + 2] = rgba[2];
    png.data[i * 4 + 3] = rgba[3];
  }
  return png;
}

function setPixel(png, x, y, rgba) {
  const idx = (png.width * y + x) * 4;
  png.data[idx] = rgba[0];
  png.data[idx + 1] = rgba[1];
  png.data[idx + 2] = rgba[2];
  png.data[idx + 3] = rgba[3];
}

function save(name, png) {
  writeFileSync(join(here, name), PNG.sync.write(png));
}

// 10x10 solid black — the baseline (also reused as the "identical" current).
save("solid-10x10.png", solid(10, 10));

// 10x10 black with a 2x2 white patch at the top-left — exactly 4 changed pixels,
// one contiguous region {x:0,y:0,w:2,h:2}.
const patch = solid(10, 10);
for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) setPixel(patch, x, y, WHITE);
save("patch-2x2.png", patch);

// 8x10 solid black — same content, narrower: a dimension mismatch (delta width -2).
save("solid-8x10.png", solid(8, 10));

// 10x10 black with two 1x1 white patches at opposite corners — two disjoint regions.
const two = solid(10, 10);
setPixel(two, 0, 0, WHITE);
setPixel(two, 9, 9, WHITE);
save("two-patches.png", two);

console.log("fixtures written to", here);
