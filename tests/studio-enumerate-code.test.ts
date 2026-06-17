import { describe, it, expect } from "vitest";
import { groupCodeComponents } from "../scripts/lib/studio/enumerate-code";
import type { RenderTarget } from "../scripts/lib/targets";

const render = (
  instance: string,
  name: string,
  state: string,
  viewport: number,
): RenderTarget => ({ instance, name, state, viewport, url: "http://x", kind: "storybook" });

describe("groupCodeComponents", () => {
  it("groups renders into (instance,name) components with distinct (state,viewport) variants", () => {
    const components = groupCodeComponents([
      render("localhost-6006", "Button", "default", 1280),
      render("localhost-6006", "Button", "hover", 1280),
      render("localhost-6006", "Button", "default", 375),
      render("localhost-6006", "Card", "default", 768),
    ]);
    expect(components).toEqual([
      {
        key: "localhost-6006/Button",
        instance: "localhost-6006",
        name: "Button",
        variants: [
          { state: "default", viewport: 375 },
          { state: "default", viewport: 1280 },
          { state: "hover", viewport: 1280 },
        ],
      },
      {
        key: "localhost-6006/Card",
        instance: "localhost-6006",
        name: "Card",
        variants: [{ state: "default", viewport: 768 }],
      },
    ]);
  });

  it("dedupes identical (state,viewport) variants", () => {
    const components = groupCodeComponents([
      render("i", "B", "default", 1280),
      render("i", "B", "default", 1280),
    ]);
    expect(components[0]?.variants).toEqual([{ state: "default", viewport: 1280 }]);
  });

  it("is order-independent (same renders in any order → identical grouping)", () => {
    const a = groupCodeComponents([render("i", "B", "hover", 768), render("i", "A", "default", 375)]);
    const b = groupCodeComponents([render("i", "A", "default", 375), render("i", "B", "hover", 768)]);
    expect(a).toEqual(b);
    expect(a.map((c) => c.key)).toEqual(["i/A", "i/B"]); // sorted by key
  });

  it("returns [] for no renders", () => {
    expect(groupCodeComponents([])).toEqual([]);
  });
});
