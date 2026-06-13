import { describe, it, expect } from "vitest";
import {
  contextOptions,
  DEFAULT_VIEWPORT_HEIGHT,
  FREEZE_INIT_SCRIPT,
  FREEZE_STYLE,
  SETTLE_SCRIPT,
} from "../scripts/lib/browser";

describe("contextOptions — R1 determinism", () => {
  it("pins deviceScaleFactor 1, reducedMotion reduce, and a light color scheme", () => {
    expect(contextOptions(375)).toEqual({
      viewport: { width: 375, height: DEFAULT_VIEWPORT_HEIGHT },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      colorScheme: "light",
    });
  });

  it("accepts a custom height", () => {
    expect(contextOptions(1280, 600).viewport).toEqual({ width: 1280, height: 600 });
  });

  it("throws on a non-positive or non-finite width", () => {
    expect(() => contextOptions(0)).toThrow(/width/);
    expect(() => contextOptions(-10)).toThrow(/width/);
    expect(() => contextOptions(Number.NaN)).toThrow(/width/);
  });
});

describe("FREEZE_STYLE", () => {
  it("collapses animation and transition timing and hides the caret", () => {
    expect(FREEZE_STYLE).toMatch(/animation-duration:\s*0s/);
    expect(FREEZE_STYLE).toMatch(/transition-duration:\s*0s/);
    expect(FREEZE_STYLE).toMatch(/caret-color:\s*transparent/);
  });

  it("neutralizes selection highlights and the OS scrollbar (portability)", () => {
    expect(FREEZE_STYLE).toMatch(/::selection/);
    expect(FREEZE_STYLE).toMatch(/scrollbar-width:\s*none/);
  });
});

describe("FREEZE_INIT_SCRIPT", () => {
  it("injects the freeze style at document start, before any page script runs", () => {
    expect(FREEZE_INIT_SCRIPT).toContain("createElement('style')");
    expect(FREEZE_INIT_SCRIPT).toContain("DOMContentLoaded");
    // Embeds the freeze CSS so the rules are present before load.
    expect(FREEZE_INIT_SCRIPT).toContain("animation-duration: 0s");
  });
});

describe("SETTLE_SCRIPT", () => {
  it("awaits web fonts and image loads and resets scroll before the screenshot", () => {
    expect(SETTLE_SCRIPT).toContain("document.fonts");
    expect(SETTLE_SCRIPT).toContain("document.images");
    expect(SETTLE_SCRIPT).toContain("scrollTo(0, 0)");
  });
});
