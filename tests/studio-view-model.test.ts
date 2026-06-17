import { describe, it, expect } from "vitest";
import {
  cardAriaLabel,
  countByBadge,
  deriveBadge,
  figmaDeepLink,
  filterComponents,
  freshness,
  isCodeRegressed,
  livePreviewUrl,
  sortComponents,
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
