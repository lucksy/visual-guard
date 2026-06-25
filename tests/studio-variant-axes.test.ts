import { describe, it, expect } from "vitest";
import {
  axesToJson,
  codeAxesFromState,
  diffVariantAxes,
  parseVariantAxes,
} from "../scripts/lib/studio/variant-axes";

describe("parseVariantAxes", () => {
  it("parses comma-separated axis=value pairs, trimming whitespace", () => {
    expect(parseVariantAxes("State=Hover, Size=Large")).toEqual({ State: "Hover", Size: "Large" });
    expect(parseVariantAxes("  State = Hover ")).toEqual({ State: "Hover" });
  });
  it("maps a bare label (no '=') to the synthetic Variant axis", () => {
    expect(parseVariantAxes("Primary")).toEqual({ Variant: "Primary" });
  });
  it("treats default / empty as no axes", () => {
    expect(parseVariantAxes("default")).toEqual({});
    expect(parseVariantAxes("")).toEqual({});
    expect(parseVariantAxes("   ")).toEqual({});
  });
  it("splits on the first '=' so a value may contain '=' ", () => {
    expect(parseVariantAxes("Token=color=blue")).toEqual({ Token: "color=blue" });
  });
});

describe("codeAxesFromState", () => {
  it("defaults a non-default state to the synthetic Variant axis", () => {
    expect(codeAxesFromState("hover")).toEqual({ Variant: "hover" });
  });
  it("contributes nothing for the default state", () => {
    expect(codeAxesFromState("default")).toEqual({});
    expect(codeAxesFromState("")).toEqual({});
  });
  it("uses an explicit config map when provided (future opt-in)", () => {
    expect(codeAxesFromState("hover", { hover: { State: "Hover" } })).toEqual({ State: "Hover" });
  });
});

describe("axesToJson", () => {
  it("returns null for the empty map, JSON otherwise", () => {
    expect(axesToJson({})).toBeNull();
    expect(axesToJson({ State: "Hover" })).toBe('{"State":"Hover"}');
  });
});

describe("diffVariantAxes", () => {
  it("is unknown when the code side is synthetic-only (the honesty guard, never a false 'missing')", () => {
    const figma = [{ State: "Hover" }, { State: "Default" }];
    const code = [{ Variant: "hover" }, { Variant: "default" }];
    const diff = diffVariantAxes(figma, code);
    expect(diff.level).toBe("unknown");
    expect(diff.figmaAxes).toEqual(["State"]);
    expect(diff.codeAxes).toEqual(["Variant"]);
  });

  it("is unknown when there are no Figma axes to compare against", () => {
    expect(diffVariantAxes([], [{ Variant: "x" }]).level).toBe("unknown");
    expect(diffVariantAxes([{}], [{ State: "x" }]).level).toBe("unknown");
  });

  it("is aligned when both sides declare the same real axes", () => {
    const both = [{ State: "Hover", Size: "Lg" }];
    expect(diffVariantAxes(both, both)).toMatchObject({ level: "aligned", missing: [], extra: [] });
  });

  it("is minor for a single axis off, divergent for more", () => {
    const figma = [{ State: "Hover", Size: "Lg" }];
    expect(diffVariantAxes(figma, [{ State: "Hover" }]).level).toBe("minor"); // Size missing
    expect(diffVariantAxes(figma, [{ Tone: "Dark" }]).level).toBe("divergent"); // 2 missing + 1 extra
  });

  it("reports the missing/extra axis names (sorted)", () => {
    const diff = diffVariantAxes([{ State: "x", Size: "y" }], [{ Size: "y", Tone: "z" }]);
    expect(diff.missing).toEqual(["State"]);
    expect(diff.extra).toEqual(["Tone"]);
  });
});
