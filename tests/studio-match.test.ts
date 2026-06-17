import { describe, it, expect } from "vitest";
import { matchComponents, type CodeRef, type FigmaRef } from "../scripts/lib/studio/match";

const code = (key: string, name: string): CodeRef => ({ key, name });
const fig = (nodeId: string, name: string): FigmaRef => ({ nodeId, name, fileKey: "F" });

describe("matchComponents", () => {
  it("matches on normalized name (case/punctuation-insensitive)", () => {
    const result = matchComponents([code("i/Button", "Button")], [fig("1:1", "button")]);
    expect(result.matched).toEqual([{ code: code("i/Button", "Button"), figma: fig("1:1", "button") }]);
    expect(result.codeOnly).toEqual([]);
    expect(result.figmaOnly).toEqual([]);
  });

  it("lets the override map win over (and resolve) a name mismatch", () => {
    const result = matchComponents(
      [code("i/Button", "Button")],
      [fig("1:1", "BtnPrimary")],
      { BtnPrimary: "Button" },
    );
    expect(result.matched.map((m) => m.code.key)).toEqual(["i/Button"]);
    expect(result.figmaOnly).toEqual([]);
  });

  it("surfaces leftovers as code-only / figma-only, never dropped", () => {
    const result = matchComponents(
      [code("i/Button", "Button"), code("i/Card", "Card")],
      [fig("1:1", "Button"), fig("2:2", "Tooltip")],
    );
    expect(result.matched.map((m) => m.code.key)).toEqual(["i/Button"]);
    expect(result.figmaOnly.map((f) => f.name)).toEqual(["Tooltip"]);
    expect(result.codeOnly.map((c) => c.key)).toEqual(["i/Card"]);
  });

  it("guards against a false positive when a normalized name is ambiguous", () => {
    // two code components fold to the same normalized name → not auto-matched (surfaced instead)
    const result = matchComponents(
      [code("a/Button", "Button"), code("b/Button", "Button")],
      [fig("1:1", "button")],
    );
    expect(result.matched).toEqual([]);
    expect(result.figmaOnly.map((f) => f.nodeId)).toEqual(["1:1"]);
    expect(result.codeOnly.map((c) => c.key).sort()).toEqual(["a/Button", "b/Button"]);
  });

  it("resolves an ambiguous normalized name when an override pins the exact code name", () => {
    const result = matchComponents(
      [code("a/Button", "Button"), code("b/Button", "Button")],
      [fig("1:1", "button")],
      { button: "Button" }, // exact-name override → first exact wins deterministically
    );
    expect(result.matched).toHaveLength(1);
  });

  it("matches each code component at most once", () => {
    const result = matchComponents(
      [code("i/Button", "Button")],
      [fig("1:1", "Button"), fig("2:2", "Button")],
    );
    expect(result.matched).toHaveLength(1);
    expect(result.figmaOnly).toHaveLength(1); // the second Figma 'Button' has no code left to take
  });

  it("treats an override that points at nothing as honest-unmatched (not fuzzy)", () => {
    const result = matchComponents([code("i/Card", "Card")], [fig("1:1", "X")], { X: "DoesNotExist" });
    expect(result.matched).toEqual([]);
    expect(result.figmaOnly.map((f) => f.name)).toEqual(["X"]);
  });

  it("an override beats a normalized-name match regardless of figma node-id order (two-pass)", () => {
    const codeRefs = [code("i/Button", "Button")];
    const overrides = { Zeta: "Button" }; // Zeta must claim i/Button, not the literal 'Button' node
    const orderA = matchComponents(codeRefs, [fig("1:1", "Button"), fig("2:2", "Zeta")], overrides);
    const orderB = matchComponents(codeRefs, [fig("2:2", "Button"), fig("1:1", "Zeta")], overrides);
    for (const result of [orderA, orderB]) {
      expect(result.matched).toHaveLength(1);
      expect(result.matched[0]?.figma.name).toBe("Zeta"); // the override always wins
      expect(result.matched[0]?.code.key).toBe("i/Button");
      expect(result.figmaOnly.map((f) => f.name)).toEqual(["Button"]); // the normalized node is surfaced
    }
  });
});
