import { describe, it, expect } from "vitest";
import type { RenderTarget } from "../scripts/lib/targets";
import type { ImportGraph } from "../scripts/lib/graph/import-graph";
import {
  FP_VERSION,
  engineFingerprint,
  storyFingerprint,
  globalFingerprint,
  renderFingerprint,
  neverSkip,
  computeFingerprint,
  type FileHash,
  type SkipContext,
} from "../scripts/lib/fingerprint";

// ---- fixtures ---------------------------------------------------------------------------------

const BTN_SF = "src/components/button/button.stories.tsx"; // lowercased graph key

const story = (over: Partial<RenderTarget> = {}): RenderTarget => ({
  instance: "components",
  name: "Button",
  state: "primary",
  viewport: 1280,
  kind: "storybook",
  url: "http://localhost:6006/iframe.html?id=button--primary&viewMode=story",
  storyId: "button--primary",
  storyFile: "src/components/Button/Button.stories.tsx", // original casing; predicate lowercases it
  ...over,
});

/** A built, complete graph whose only story is BTN_SF. */
const graph = (over: Partial<ImportGraph> = {}): ImportGraph => ({
  built: true,
  fileToStoryFiles: new Map(),
  storyIncomplete: new Map([[BTN_SF, false]]),
  storyClosure: new Map([[BTN_SF, new Set(["/abs/button.tsx", "/abs/button.stories.tsx"])]]),
  ...over,
});

const ctx = (over: Partial<SkipContext> = {}): SkipContext => ({
  graph: graph(),
  closureHashesByStory: new Map<string, readonly FileHash[] | null>([
    [BTN_SF, [["src/components/button/button.tsx", "h1"], ["src/components/button/button.stories.tsx", "h2"]]],
  ]),
  global: "G0",
  ...over,
});

// ---- fingerprint determinism + sensitivity ----------------------------------------------------

describe("engineFingerprint", () => {
  it("is deterministic for the same playwright version + chromium revision", () => {
    expect(engineFingerprint("1.49.1", "1148")).toBe(engineFingerprint("1.49.1", "1148"));
  });
  it("changes when the playwright version changes", () => {
    expect(engineFingerprint("1.49.1", "1148")).not.toBe(engineFingerprint("1.50.0", "1148"));
  });
  it("changes when ONLY the Chromium revision changes (same version, swapped binary)", () => {
    expect(engineFingerprint("1.49.1", "1148")).not.toBe(engineFingerprint("1.49.1", "1149"));
  });
});

describe("storyFingerprint", () => {
  const a: FileHash[] = [["a.ts", "h1"], ["b.ts", "h2"]];
  it("is order-independent (sorts by path)", () => {
    expect(storyFingerprint(a)).toBe(storyFingerprint([["b.ts", "h2"], ["a.ts", "h1"]]));
  });
  it("changes when any closure file's content hash changes", () => {
    expect(storyFingerprint(a)).not.toBe(storyFingerprint([["a.ts", "h1"], ["b.ts", "DIFF"]]));
  });
  it("changes when a closure file is renamed (path is part of the hash)", () => {
    expect(storyFingerprint(a)).not.toBe(storyFingerprint([["a.ts", "h1"], ["b2.ts", "h2"]]));
  });
  it("changes when a file is added to / removed from the closure", () => {
    expect(storyFingerprint(a)).not.toBe(storyFingerprint([["a.ts", "h1"]]));
    expect(storyFingerprint(a)).not.toBe(storyFingerprint([...a, ["c.ts", "h3"]]));
  });
  it("is case-insensitive on the path (matches the graph's keying)", () => {
    expect(storyFingerprint([["A.TS", "h1"]])).toBe(storyFingerprint([["a.ts", "h1"]]));
  });
});

describe("globalFingerprint", () => {
  const g: FileHash[] = [["tokens.css", "t1"]];
  it("changes when a global file changes", () => {
    expect(globalFingerprint(g, "E0")).not.toBe(globalFingerprint([["tokens.css", "t2"]], "E0"));
  });
  it("changes when the engine fingerprint changes", () => {
    expect(globalFingerprint(g, "E0")).not.toBe(globalFingerprint(g, "E1"));
  });
  it("is order-independent across global files", () => {
    expect(globalFingerprint([["a", "1"], ["b", "2"]], "E0")).toBe(
      globalFingerprint([["b", "2"], ["a", "1"]], "E0"),
    );
  });
});

describe("renderFingerprint", () => {
  it("differs per viewport, state, and kind (the render-local axes)", () => {
    const base = renderFingerprint(story(), "S", "G");
    expect(base).not.toBe(renderFingerprint(story({ viewport: 375 }), "S", "G"));
    expect(base).not.toBe(renderFingerprint(story({ state: "hover" }), "S", "G"));
    expect(base).not.toBe(renderFingerprint(story({ kind: "app" }), "S", "G"));
  });
  it("differs when the story (S) or global (G) fingerprint differs", () => {
    expect(renderFingerprint(story(), "S", "G")).not.toBe(renderFingerprint(story(), "S2", "G"));
    expect(renderFingerprint(story(), "S", "G")).not.toBe(renderFingerprint(story(), "S", "G2"));
  });
  it("ignores the URL origin (host:port) but honors the path + query", () => {
    const onPort6006 = story({ url: "http://localhost:6006/iframe.html?id=button--primary&viewMode=story" });
    const onPort9999 = story({ url: "http://localhost:9999/iframe.html?id=button--primary&viewMode=story" });
    const otherStory = story({ url: "http://localhost:6006/iframe.html?id=button--secondary&viewMode=story" });
    expect(renderFingerprint(onPort6006, "S", "G")).toBe(renderFingerprint(onPort9999, "S", "G"));
    expect(renderFingerprint(onPort6006, "S", "G")).not.toBe(renderFingerprint(otherStory, "S", "G"));
  });
});

// ---- neverSkip: the safety gate ---------------------------------------------------------------

describe("neverSkip (capture is the default; skip is the rare exception)", () => {
  it("a fully fingerprintable Storybook story is skippable (neverSkip=false)", () => {
    expect(neverSkip(story(), ctx())).toBe(false);
  });

  it("NEVER skips when the graph is undefined (Phase-0 fallback)", () => {
    expect(neverSkip(story(), ctx({ graph: undefined }))).toBe(true);
  });
  it("NEVER skips when the graph is not built", () => {
    expect(neverSkip(story(), ctx({ graph: graph({ built: false }) }))).toBe(true);
  });
  it("NEVER skips an app route (no storyId)", () => {
    expect(neverSkip(story({ storyId: undefined, kind: "app" }), ctx())).toBe(true);
  });
  it("NEVER skips a target with no storyFile (Ladle / explicit list)", () => {
    expect(neverSkip(story({ storyFile: undefined }), ctx())).toBe(true);
    expect(neverSkip(story({ storyFile: "" }), ctx())).toBe(true);
  });
  it("NEVER skips a story whose closure is graph-incomplete", () => {
    expect(neverSkip(story(), ctx({ graph: graph({ storyIncomplete: new Map([[BTN_SF, true]]) }) }))).toBe(
      true,
    );
  });
  it("NEVER skips a story absent from the graph's completeness map", () => {
    expect(neverSkip(story(), ctx({ graph: graph({ storyIncomplete: new Map() }) }))).toBe(true);
  });
  it("NEVER skips when the closure hashes are missing (not provided)", () => {
    expect(neverSkip(story(), ctx({ closureHashesByStory: new Map() }))).toBe(true);
  });
  it("NEVER skips when a closure file was unhashable (null)", () => {
    expect(
      neverSkip(story(), ctx({ closureHashesByStory: new Map([[BTN_SF, null]]) })),
    ).toBe(true);
  });
});

// ---- computeFingerprint: null exactly when neverSkip ------------------------------------------

describe("computeFingerprint", () => {
  it("returns null exactly when neverSkip is true", () => {
    const cases: Array<[string, SkipContext, RenderTarget]> = [
      ["graph undefined", ctx({ graph: undefined }), story()],
      ["app route", ctx(), story({ storyId: undefined })],
      ["no storyFile", ctx(), story({ storyFile: undefined })],
      ["incomplete", ctx({ graph: graph({ storyIncomplete: new Map([[BTN_SF, true]]) }) }), story()],
      ["unhashable closure", ctx({ closureHashesByStory: new Map([[BTN_SF, null]]) }), story()],
    ];
    for (const [label, c, r] of cases) {
      expect(neverSkip(r, c), label).toBe(true);
      expect(computeFingerprint(r, c), label).toBeNull();
    }
  });

  it("returns a stable, non-null fingerprint for a fingerprintable render", () => {
    const fp = computeFingerprint(story(), ctx());
    expect(fp).not.toBeNull();
    expect(computeFingerprint(story(), ctx())).toBe(fp);
  });

  it("equals the manual S⊕G⊕axes composition", () => {
    const c = ctx();
    const sf = BTN_SF;
    const s = storyFingerprint(c.closureHashesByStory.get(sf)!);
    expect(computeFingerprint(story(), c)).toBe(renderFingerprint(story(), s, c.global));
  });

  it("changes when a closure file's content changes (the whole point)", () => {
    const before = computeFingerprint(story(), ctx());
    const after = computeFingerprint(
      story(),
      ctx({
        closureHashesByStory: new Map([
          [BTN_SF, [["src/components/button/button.tsx", "CHANGED"], ["src/components/button/button.stories.tsx", "h2"]]],
        ]),
      }),
    );
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("changes when the global fingerprint changes (a token/global/engine edit busts every render)", () => {
    expect(computeFingerprint(story(), ctx())).not.toBe(computeFingerprint(story(), ctx({ global: "G_CHANGED" })));
  });
});

describe("FP_VERSION", () => {
  it("is a positive integer kill-switch", () => {
    expect(Number.isInteger(FP_VERSION)).toBe(true);
    expect(FP_VERSION).toBeGreaterThan(0);
  });
});
