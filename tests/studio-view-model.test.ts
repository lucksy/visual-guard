import { describe, it, expect } from "vitest";
import {
  cardAriaLabel,
  countByBadge,
  deriveBadge,
  describeParityDrift,
  figmaDeepLink,
  filterComponents,
  formatDiffRatio,
  freshness,
  isCodeRegressed,
  livePreviewUrl,
  regressionSeries,
  sortComponents,
  sparklinePath,
  storyLink,
  timelineTicks,
  variantUnion,
} from "../scripts/studio/public/view-model.js";
import type { ComponentLike } from "../scripts/studio/public/view-model.js";

const comp = (over: Partial<ComponentLike> = {}): ComponentLike => ({
  name: "Button",
  key: "buttons/button",
  figma_file_key: null,
  figma_node_id: null,
  code_instance: null,
  code_target: null,
  status: null,
  parity_status: null,
  updated_at: null,
  ...over,
});

describe("deriveBadge — the 5-status vocabulary (SPEC §11.1)", () => {
  it("figma-only when designed but not built", () => {
    expect(deriveBadge(comp({ figma_node_id: "1:2" })).key).toBe("figma-only");
  });
  it("code-only when built but not in the library", () => {
    expect(deriveBadge(comp({ code_target: "Button" })).key).toBe("code-only");
  });
  it("in-sync when both exist and parity is same", () => {
    const b = deriveBadge(comp({ figma_node_id: "1:2", code_target: "Button", parity_status: "same" }));
    expect(b.key).toBe("in-sync");
    expect(b.tone).toBe("green");
  });
  it("changed when both exist and parity differs", () => {
    expect(deriveBadge(comp({ figma_node_id: "1:2", code_target: "B", parity_status: "changed" })).key).toBe(
      "changed",
    );
    expect(deriveBadge(comp({ figma_node_id: "1:2", code_target: "B", parity_status: "regression" })).key).toBe(
      "changed",
    );
  });
  it("new when both linked but not yet compared, or neither linked", () => {
    expect(deriveBadge(comp({ figma_node_id: "1:2", code_target: "B", parity_status: null })).key).toBe("new");
    expect(deriveBadge(comp({ figma_node_id: "1:2", code_target: "B", parity_status: "unknown" })).key).toBe(
      "new",
    );
    expect(deriveBadge(comp()).key).toBe("new");
  });
});

describe("isCodeRegressed + countByBadge", () => {
  it("flags a code regression independent of the parity badge", () => {
    expect(isCodeRegressed(comp({ status: "regression" }))).toBe(true);
    expect(isCodeRegressed(comp({ status: "same" }))).toBe(false);
  });
  it("counts each badge plus the total", () => {
    const list = [
      comp({ figma_node_id: "1", code_target: "a", parity_status: "same" }), // in-sync
      comp({ figma_node_id: "2", code_target: "b", parity_status: "changed" }), // changed
      comp({ figma_node_id: "3" }), // figma-only
      comp({ code_target: "d" }), // code-only
      comp(), // new
    ];
    expect(countByBadge(list)).toEqual({
      all: 5,
      "in-sync": 1,
      changed: 1,
      "figma-only": 1,
      "code-only": 1,
      new: 1,
    });
  });
});

describe("filterComponents", () => {
  const list = [
    comp({ name: "Button", key: "buttons/button", code_target: "Button" }),
    comp({ name: "Card", key: "cards/card", figma_node_id: "9" }),
  ];
  it("filters by case-insensitive name/key substring", () => {
    expect(filterComponents(list, { q: "card" }).map((c) => c.name)).toEqual(["Card"]);
    expect(filterComponents(list, { q: "BUTTONS/" }).map((c) => c.name)).toEqual(["Button"]);
    expect(filterComponents(list, { q: "zzz" })).toEqual([]);
  });
  it("filters by derived badge key, with 'all' meaning no badge filter", () => {
    expect(filterComponents(list, { badge: "code-only" }).map((c) => c.name)).toEqual(["Button"]);
    expect(filterComponents(list, { badge: "figma-only" }).map((c) => c.name)).toEqual(["Card"]);
    expect(filterComponents(list, { badge: "all" })).toHaveLength(2);
    expect(filterComponents(list, {})).toHaveLength(2);
  });
});

describe("sortComponents", () => {
  it("urgency: regressed first, then badge urgency, then name", () => {
    const list = [
      comp({ name: "Zeta", figma_node_id: "1", code_target: "z", parity_status: "same" }), // in-sync (4)
      comp({ name: "Alpha", figma_node_id: "2", code_target: "a", parity_status: "changed" }), // changed (0)
      comp({ name: "Reg", code_target: "r", status: "regression" }), // code-only but REGRESSED → first
    ];
    expect(sortComponents(list, "urgency").map((c) => c.name)).toEqual(["Reg", "Alpha", "Zeta"]);
  });
  it("name + recent modes, non-mutating", () => {
    const list = [
      comp({ name: "B", updated_at: "2026-01-01T00:00:00.000Z" }),
      comp({ name: "A", updated_at: "2026-06-01T00:00:00.000Z" }),
    ];
    expect(sortComponents(list, "name").map((c) => c.name)).toEqual(["A", "B"]);
    expect(sortComponents(list, "recent").map((c) => c.name)).toEqual(["A", "B"]); // A is newer
    expect(list.map((c) => c.name)).toEqual(["B", "A"]); // original untouched
  });
});

describe("variantUnion", () => {
  it("merges by normalized name with an origin tag", () => {
    const u = variantUnion([
      { source: "figma", name: "Default" },
      { source: "code", name: "default" }, // same after normalize → both
      { source: "figma", name: "Loading" }, // figma-only
      { source: "code", name: "Hover" }, // code-only
    ]);
    expect(u).toEqual([
      { name: "Default", inFigma: true, inCode: true, origin: "both" },
      { name: "Hover", inFigma: false, inCode: true, origin: "code-only" },
      { name: "Loading", inFigma: true, inCode: false, origin: "figma-only" },
    ]);
  });
});

describe("timelineTicks", () => {
  it("orders oldest→newest and flags the latest as current", () => {
    const ticks = timelineTicks([
      { id: 2, version_seq: 2, captured_at: "t2", git_sha: "bbb" },
      { id: 1, version_seq: 1, captured_at: "t1", figma_version_id: "v1" },
      { id: 3, version_seq: 3, captured_at: "t3" },
    ]);
    expect(ticks.map((t) => t.versionSeq)).toEqual([1, 2, 3]);
    expect(ticks.map((t) => t.isCurrent)).toEqual([false, false, true]);
    expect(ticks[0]?.figmaVersionId).toBe("v1");
    expect(ticks[1]?.gitSha).toBe("bbb");
  });
});

describe("freshness", () => {
  const base = Date.parse("2026-06-16T12:00:00.000Z");
  it("renders relative buckets", () => {
    expect(freshness(null, base)).toBe("never");
    expect(freshness("nonsense", base)).toBe("unknown");
    expect(freshness("2026-06-16T11:59:30.000Z", base)).toBe("just now"); // 30s
    expect(freshness("2026-06-16T11:56:00.000Z", base)).toBe("4m ago");
    expect(freshness("2026-06-16T09:00:00.000Z", base)).toBe("3h ago");
    expect(freshness("2026-06-11T12:00:00.000Z", base)).toBe("5d ago");
  });
});

describe("labels + deep links", () => {
  it("cardAriaLabel includes status, regression, and variant count", () => {
    expect(cardAriaLabel(comp({ figma_node_id: "1", code_target: "b", parity_status: "changed" }), 4)).toBe(
      "Button, status Changed, 4 variants",
    );
    expect(cardAriaLabel(comp({ code_target: "b", status: "regression" }), 1)).toBe(
      "Button, status Code-only, code regression, 1 variant",
    );
  });
  it("figmaDeepLink converts node ids and encodes; null when incomplete", () => {
    expect(figmaDeepLink("abc123", "1:2")).toBe(
      "https://www.figma.com/file/abc123?node-id=1-2",
    );
    expect(figmaDeepLink("abc", null)).toBeNull();
    expect(figmaDeepLink(null, "1:2")).toBeNull();
  });
  it("storyLink builds a Storybook path and tolerates a trailing slash", () => {
    expect(storyLink("http://localhost:6006/", "components-button--primary")).toBe(
      "http://localhost:6006/?path=/story/components-button--primary",
    );
    expect(storyLink("https://sb.example.com", "btn--primary")).toBe(
      "https://sb.example.com/?path=/story/btn--primary",
    );
    expect(storyLink(null, "x")).toBeNull();
  });

  it("storyLink rejects a non-http(s) base URL (no javascript:/data: href from hostile config)", () => {
    expect(storyLink("javascript:alert(1)", "x")).toBeNull();
    expect(storyLink("data:text/html,<script>", "x")).toBeNull();
    expect(storyLink("not a url", "x")).toBeNull();
  });
});

describe("livePreviewUrl", () => {
  it("returns a loopback http(s) render URL verbatim", () => {
    expect(livePreviewUrl("http://localhost:61000/?story=button--primary&mode=preview")).toBe(
      "http://localhost:61000/?story=button--primary&mode=preview",
    );
    expect(livePreviewUrl("http://127.0.0.1:6006/iframe.html?id=btn--primary&viewMode=story")).toBe(
      "http://127.0.0.1:6006/iframe.html?id=btn--primary&viewMode=story",
    );
  });

  it("rejects null/empty, non-http(s), non-loopback, and garbage (CSP would block them anyway)", () => {
    expect(livePreviewUrl(null)).toBeNull();
    expect(livePreviewUrl("")).toBeNull();
    expect(livePreviewUrl("https://evil.example.com/?story=x")).toBeNull();
    expect(livePreviewUrl("http://192.168.1.5:61000/?story=x")).toBeNull();
    expect(livePreviewUrl("javascript:alert(1)")).toBeNull();
    expect(livePreviewUrl("not a url")).toBeNull();
  });
});

// --- P6: diff & comparison helpers -----------------------------------------

describe("filterComponents — broadened search corpus (P6)", () => {
  it("matches the description, not just name/key", () => {
    const list = [
      comp({ name: "Button", key: "btn", description: "the main call to action" }),
      comp({ name: "Card", key: "card", description: "a surface container" }),
    ];
    expect(filterComponents(list, { q: "call to action" }).map((c) => c.name)).toEqual(["Button"]);
    expect(filterComponents(list, { q: "surface" }).map((c) => c.name)).toEqual(["Card"]);
    // A null description never throws and just doesn't match.
    expect(filterComponents([comp({ name: "X", key: "x" })], { q: "anything" })).toEqual([]);
  });
});

describe("formatDiffRatio", () => {
  it("formats a 0..1 ratio as a 2-decimal percentage, null for non-numbers", () => {
    expect(formatDiffRatio(0.0123)).toBe("1.23%");
    expect(formatDiffRatio(0)).toBe("0.00%");
    expect(formatDiffRatio(1)).toBe("100.00%");
    expect(formatDiffRatio(null)).toBeNull();
    expect(formatDiffRatio(undefined)).toBeNull();
    expect(formatDiffRatio(NaN)).toBeNull();
  });
});

describe("regressionSeries", () => {
  it("reverses newest-first rows to oldest→newest and coerces NULL ratios to 0", () => {
    const rows = [
      { diff_ratio: 0.3, status: "regression", computed_at: "t3" },
      { diff_ratio: null, status: "new", computed_at: "t2" },
      { diff_ratio: 0.1, status: "changed", computed_at: "t1" },
    ];
    const s = regressionSeries(rows);
    expect(s.map((p) => p.ratio)).toEqual([0.1, 0, 0.3]);
    expect(s.map((p) => p.at)).toEqual(["t1", "t2", "t3"]);
    expect(regressionSeries(null)).toEqual([]);
    expect(regressionSeries(undefined)).toEqual([]);
  });
});

describe("sparklinePath", () => {
  it("returns '' for empty, a flat 2-point line for a single sample", () => {
    expect(sparklinePath([], 100, 24)).toBe("");
    expect(sparklinePath([0.5], 100, 24)).toBe("0,0.00 100,0.00"); // single point → top line at its own max
  });

  it("maps a series across the width with y inverted and normalized to its own max", () => {
    const pts = sparklinePath([0, 0.5, 1], 100, 20).split(" ");
    expect(pts).toHaveLength(3);
    // x spreads 0..100; y inverts (max value → 0, zero → height).
    expect(pts[0]).toBe("0.00,20.00"); // 0 → bottom
    expect(pts[2]).toBe("100.00,0.00"); // max → top
  });

  it("draws an all-zero series along the bottom (no divide-by-zero)", () => {
    expect(sparklinePath([0, 0, 0], 60, 30)).toBe("0.00,30.00 30.00,30.00 60.00,30.00");
  });
});

describe("describeParityDrift", () => {
  it("names which conformance axis drifted (advisory)", () => {
    expect(describeParityDrift(null, null)).toBeNull();
    expect(describeParityDrift(0.01, 0.01)).toMatch(/aligned/);
    expect(describeParityDrift(0.3, 0.01)).toMatch(/size drifts/);
    expect(describeParityDrift(0.01, 0.3)).toMatch(/color drifts/);
    expect(describeParityDrift(0.3, 0.3)).toMatch(/size and color/);
  });
});
