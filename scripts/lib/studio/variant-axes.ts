/**
 * Variant-axis parsing + Figma↔code axis set-diff (Component Studio v5 / F4). Pure — no I/O. Advisory
 * only: it surfaces whether the code side declares the same variant axes the Figma side does, NEVER
 * gating anything.
 *
 * HONEST PARTIALITY: the engine reads Storybook/Ladle `index.json` (id/title/name/type), not story
 * args/argTypes — so the code side has no declared prop axes, only story STATE names. We model that as a
 * single synthetic `Variant` axis. Against Figma's real multi-axis labels (`State=Hover, Size=Large`)
 * that would always read "missing axes" — pure noise. So when the code side is synthetic-only, the diff
 * reports `unknown` ("can't assess"), never `divergent`. A real value-level diff is a future opt-in
 * (a story-name → {axis: value} map); this ships the Figma-axis persistence + a conservative diff.
 */

/** The synthetic axis name used when the code side has only story-state names, not declared prop axes. */
export const SYNTHETIC_CODE_AXIS = "Variant";

/** Serialize an axis map for a variant's `props_json` — null for the empty map (so a no-axis variant stays NULL). */
export function axesToJson(axes: Record<string, string>): string | null {
  return Object.keys(axes).length === 0 ? null : JSON.stringify(axes);
}

/**
 * Parse a Figma variant label into its axis → value map. `"State=Hover, Size=Large"` → `{State: "Hover",
 * Size: "Large"}`; a bare label `"Primary"` → `{Variant: "Primary"}`; `"default"`/empty → `{}`. NOTE: a
 * comma inside a value is a documented limitation (labels are comma-separated `axis=value` pairs).
 */
export function parseVariantAxes(label: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof label !== "string") return out;
  const trimmed = label.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "default") return out;
  for (const part of trimmed.split(",")) {
    const seg = part.trim();
    if (seg === "") continue;
    const eq = seg.indexOf("=");
    if (eq === -1) {
      out[SYNTHETIC_CODE_AXIS] = seg; // a bare label has no axis name → the synthetic one
    } else {
      const axis = seg.slice(0, eq).trim();
      const value = seg.slice(eq + 1).trim();
      if (axis !== "" && value !== "") out[axis] = value;
    }
  }
  return out;
}

/**
 * The code side's axes for one rendered story state. Without an explicit `configMap`
 * (`config.studio.variantAxes`, a future opt-in mapping a story name → {axis: value}) the code side has
 * no declared prop axes, so a non-default state becomes the single synthetic `Variant` axis and the
 * `default` state contributes none.
 */
export function codeAxesFromState(
  state: string,
  configMap?: Record<string, Record<string, string>>,
): Record<string, string> {
  if (configMap && Object.prototype.hasOwnProperty.call(configMap, state)) {
    return { ...configMap[state] };
  }
  const trimmed = (state ?? "").trim();
  if (trimmed === "" || trimmed.toLowerCase() === "default") return {};
  return { [SYNTHETIC_CODE_AXIS]: trimmed };
}

export type AxisDiffLevel = "aligned" | "minor" | "divergent" | "unknown";

export interface VariantAxisDiff {
  level: AxisDiffLevel;
  /** Distinct axis names declared on the Figma side (sorted). */
  figmaAxes: string[];
  /** Distinct axis names declared on the code side (sorted). */
  codeAxes: string[];
  /** Figma axes the code side does not declare. */
  missing: string[];
  /** Code axes not present on the Figma side. */
  extra: string[];
}

/**
 * Set-diff the axis NAMES across a component's Figma variants vs its code variants. Returns an advisory
 * level: `aligned` (same axes), `minor` (one axis off), `divergent` (more), or `unknown` (can't honestly
 * assess — no Figma axes to compare, or the code side is synthetic-only). Pure + deterministic.
 */
export function diffVariantAxes(
  figmaVariants: ReadonlyArray<Record<string, string>>,
  codeVariants: ReadonlyArray<Record<string, string>>,
): VariantAxisDiff {
  const figmaSet = new Set<string>();
  for (const v of figmaVariants) for (const k of Object.keys(v)) figmaSet.add(k);
  const codeSet = new Set<string>();
  for (const v of codeVariants) for (const k of Object.keys(v)) codeSet.add(k);
  const figmaAxes = [...figmaSet].sort();
  const codeAxes = [...codeSet].sort();
  const missing = figmaAxes.filter((a) => !codeSet.has(a));
  const extra = codeAxes.filter((a) => !figmaSet.has(a));

  const codeIsSyntheticOnly =
    codeAxes.length === 0 || (codeAxes.length === 1 && codeAxes[0] === SYNTHETIC_CODE_AXIS);

  let level: AxisDiffLevel;
  if (figmaAxes.length === 0) {
    level = "unknown"; // no Figma axes to compare against (e.g. a standalone component)
  } else if (codeIsSyntheticOnly) {
    level = "unknown"; // honesty guard: synthetic code axes can't be a real "missing" signal
  } else if (missing.length === 0 && extra.length === 0) {
    level = "aligned";
  } else if (missing.length + extra.length <= 1) {
    level = "minor";
  } else {
    level = "divergent";
  }
  return { level, figmaAxes, codeAxes, missing, extra };
}
