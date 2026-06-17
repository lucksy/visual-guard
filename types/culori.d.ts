/**
 * Minimal ambient types for the subset of `culori` the token-equality core uses. culori ships its
 * own types, but they don't resolve cleanly under this project's module resolution, so we declare
 * just `parse` / `formatHex` / `formatHex8` (see scripts/lib/token-equality.ts).
 */
declare module "culori" {
  export interface Color {
    mode: string;
    alpha?: number;
    [channel: string]: number | string | undefined;
  }
  /** Parse any CSS color string (hex, rgb/hsl/hwb, named, oklch/lab, …) → a color, or undefined. */
  export function parse(value: string): Color | undefined;
  /** Format a color (or color string) as a 6-digit `#rrggbb`; undefined if it can't be converted. */
  export function formatHex(color: Color | string | undefined): string | undefined;
  /** Format a color (or color string) as an 8-digit `#rrggbbaa` (alpha-aware). */
  export function formatHex8(color: Color | string | undefined): string | undefined;
  /**
   * CIEDE2000 perceptual color-difference metric factory (used by the studio conformance scorer):
   * returns `(a, b) => deltaE`, where 0 = identical and larger = more perceptually different.
   */
  export function differenceCiede2000(): (a: Color, b: Color) => number;
}
