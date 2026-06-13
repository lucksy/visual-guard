import { describe, it, expect } from "vitest";
import { parseConfig, type Config } from "../scripts/lib/config";
import { resolveTargets, type FetchLike } from "../scripts/lib/targets";

// --- Test doubles ---------------------------------------------------------
// targets.ts performs its only I/O through an injected `fetch`, so every test
// runs against a deterministic mock — no real network (T-06: "fetch mocked").

interface RouteSpec {
  status?: number;
  body?: unknown;
  /** Simulate a connection failure (fetch rejects). */
  unreachable?: boolean;
  /** Simulate a 2xx response whose body is not valid JSON. */
  jsonThrows?: boolean;
}

function mockFetch(routes: Record<string, RouteSpec>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const spec = routes[url];
    if (!spec || spec.unreachable) {
      throw new Error(`ECONNREFUSED ${url}`);
    }
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (spec.jsonThrows) throw new SyntaxError("Unexpected token < in JSON");
        return spec.body;
      },
    };
  };
  return { fetch, calls };
}

/** A fetch that fails the test if discovery ever touches the network. */
const failFetch: FetchLike = async (url) => {
  throw new Error(`fetch must not be called (discovery should be bypassed): ${url}`);
};

const SB_URL = "http://localhost:6006";
const INDEX_URL = `${SB_URL}/index.json`;
const STORIES_URL = `${SB_URL}/stories.json`;
const APP_URL = "http://localhost:3000";

function storybookConfig(opts: { stories?: string[]; viewports?: number[] } = {}): Config {
  const target: Record<string, unknown> = { type: "storybook", url: SB_URL };
  if (opts.stories) target.stories = opts.stories;
  return parseConfig({
    targets: [target],
    viewports: opts.viewports ?? [1280],
    states: ["default"],
  });
}

function appConfig(opts: { routes?: string[]; viewports?: number[]; states?: string[] }): Config {
  const target: Record<string, unknown> = { type: "app", url: APP_URL };
  if (opts.routes !== undefined) target.routes = opts.routes;
  return parseConfig({
    targets: [target],
    viewports: opts.viewports ?? [1280],
    states: opts.states ?? ["default"],
  });
}

// --- Storybook discovery --------------------------------------------------

describe("resolveTargets — Storybook discovery via /index.json", () => {
  it("discovers stories, skips docs entries, and expands story × viewport", async () => {
    const { fetch, calls } = mockFetch({
      [INDEX_URL]: {
        body: {
          v: 4,
          entries: {
            "example-button--primary": {
              id: "example-button--primary",
              title: "Example/Button",
              name: "Primary",
              type: "story",
            },
            "example-button--disabled": {
              id: "example-button--disabled",
              title: "Example/Button",
              name: "Disabled",
              type: "story",
            },
            "example-button--docs": {
              id: "example-button--docs",
              title: "Example/Button",
              name: "Docs",
              type: "docs",
            },
          },
        },
      },
    });

    const targets = await resolveTargets(storybookConfig({ viewports: [375, 1280] }), fetch);

    expect(calls).toEqual([INDEX_URL]); // index.json answered → never touched stories.json
    expect(targets).toHaveLength(4); // 2 stories × 2 viewports, docs excluded
    expect(targets).toContainEqual({
      name: "Button",
      state: "Primary",
      viewport: 375,
      kind: "storybook",
      url: "http://localhost:6006/iframe.html?id=example-button--primary&viewMode=story",
    });
    expect(targets).toContainEqual({
      name: "Button",
      state: "Disabled",
      viewport: 1280,
      kind: "storybook",
      url: "http://localhost:6006/iframe.html?id=example-button--disabled&viewMode=story",
    });
    expect(targets.some((t) => t.state === "Docs")).toBe(false);
  });

  it("derives the component name from the last segment of the story title", async () => {
    const { fetch } = mockFetch({
      [INDEX_URL]: {
        body: {
          v: 5,
          entries: {
            "forms-fields-input--default": {
              id: "forms-fields-input--default",
              title: "Forms/Fields/Input",
              name: "Default",
              type: "story",
            },
          },
        },
      },
    });
    const targets = await resolveTargets(storybookConfig(), fetch);
    expect(targets[0]?.name).toBe("Input");
  });

  it("tolerates a trailing slash on the Storybook url", async () => {
    const { fetch } = mockFetch({
      [INDEX_URL]: {
        body: { v: 4, entries: { "x--y": { id: "x--y", title: "X", name: "Y", type: "story" } } },
      },
    });
    const cfg = parseConfig({
      targets: [{ type: "storybook", url: "http://localhost:6006/" }],
      viewports: [1280],
      states: ["default"],
    });
    const targets = await resolveTargets(cfg, fetch);
    expect(targets[0]?.url).toBe("http://localhost:6006/iframe.html?id=x--y&viewMode=story");
  });
});

describe("resolveTargets — /stories.json fallback and Storybook < 7", () => {
  it("falls back to /stories.json, then rejects legacy Storybook < 7 with a clear error", async () => {
    const { fetch, calls } = mockFetch({
      [INDEX_URL]: { status: 404 },
      [STORIES_URL]: {
        body: {
          v: 3,
          stories: {
            "button--primary": { id: "button--primary", kind: "Button", name: "Primary" },
          },
        },
      },
    });
    await expect(resolveTargets(storybookConfig(), fetch)).rejects.toThrow(/Storybook >= 7/);
    expect(calls).toEqual([INDEX_URL, STORIES_URL]); // tried index first, then fell back
  });

  it("uses /stories.json when it carries a modern index payload", async () => {
    const { fetch, calls } = mockFetch({
      [INDEX_URL]: { status: 404 },
      [STORIES_URL]: {
        body: {
          v: 4,
          entries: { "card--default": { id: "card--default", title: "Card", name: "Default", type: "story" } },
        },
      },
    });
    const targets = await resolveTargets(storybookConfig(), fetch);
    expect(calls).toEqual([INDEX_URL, STORIES_URL]);
    expect(targets).toEqual([
      {
        name: "Card",
        state: "Default",
        viewport: 1280,
        kind: "storybook",
        url: "http://localhost:6006/iframe.html?id=card--default&viewMode=story",
      },
    ]);
  });

  it("rejects an index that reports a version below 4", async () => {
    const { fetch } = mockFetch({ [INDEX_URL]: { body: { v: 3, entries: {} } } });
    await expect(resolveTargets(storybookConfig(), fetch)).rejects.toThrow(/Storybook/);
  });
});

describe("resolveTargets — Storybook discovery failures", () => {
  it("throws an actionable error when neither endpoint is reachable", async () => {
    const { fetch } = mockFetch({
      [INDEX_URL]: { unreachable: true },
      [STORIES_URL]: { unreachable: true },
    });
    await expect(resolveTargets(storybookConfig(), fetch)).rejects.toThrow(
      /could not discover|Storybook running/i,
    );
  });

  it("treats invalid JSON as a miss and falls through", async () => {
    const { fetch } = mockFetch({
      [INDEX_URL]: { jsonThrows: true },
      [STORIES_URL]: { unreachable: true },
    });
    await expect(resolveTargets(storybookConfig(), fetch)).rejects.toThrow(
      /could not discover|invalid JSON/i,
    );
  });

  it("throws when the index has neither entries nor stories", async () => {
    const { fetch } = mockFetch({ [INDEX_URL]: { body: { v: 4, somethingElse: true } } });
    await expect(resolveTargets(storybookConfig(), fetch)).rejects.toThrow(/entries|Storybook >= 7/i);
  });

  it("throws when the index payload is not a JSON object", async () => {
    const { fetch } = mockFetch({ [INDEX_URL]: { body: 42 } });
    await expect(resolveTargets(storybookConfig(), fetch)).rejects.toThrow(/object/i);
  });
});

describe("resolveTargets — Storybook discovery hygiene", () => {
  it("skips index entries with a missing or blank id", async () => {
    const { fetch } = mockFetch({
      [INDEX_URL]: {
        body: {
          v: 4,
          entries: {
            "good--default": { id: "good--default", title: "Good", name: "Default", type: "story" },
            blank: { id: "", title: "Blank", name: "X", type: "story" },
          },
        },
      },
    });
    const targets = await resolveTargets(storybookConfig(), fetch);
    expect(targets.map((t) => t.name)).toEqual(["Good"]); // empty-id entry dropped
    expect(targets.every((t) => t.name.length > 0)).toBe(true);
  });
});

describe("resolveTargets — explicit story list bypasses discovery", () => {
  it("treats an explicit empty story list as a deliberate bypass — no discovery, no renders", async () => {
    // `stories: []` is an explicit (if empty) list; it must NOT silently hit the network.
    const targets = await resolveTargets(storybookConfig({ stories: [] }), failFetch);
    expect(targets).toEqual([]);
  });

  it("filters blank ids out of an explicit story list", async () => {
    const cfg = storybookConfig({ stories: ["", "  ", "real--default"] });
    const targets = await resolveTargets(cfg, failFetch);
    expect(targets.map((t) => t.name)).toEqual(["real"]);
  });

  it("expands an explicit story list × viewports without any network call", async () => {
    const cfg = storybookConfig({
      stories: ["example-button--primary", "standalone"],
      viewports: [375, 1280],
    });
    const targets = await resolveTargets(cfg, failFetch);
    expect(targets).toHaveLength(4); // 2 stories × 2 viewports
    expect(targets).toContainEqual({
      name: "example-button",
      state: "primary",
      viewport: 375,
      kind: "storybook",
      url: "http://localhost:6006/iframe.html?id=example-button--primary&viewMode=story",
    });
    // An id with no "--" separator falls back to a "default" state.
    expect(targets).toContainEqual({
      name: "standalone",
      state: "default",
      viewport: 1280,
      kind: "storybook",
      url: "http://localhost:6006/iframe.html?id=standalone&viewMode=story",
    });
  });
});

// --- App route expansion --------------------------------------------------

describe("resolveTargets — app route expansion", () => {
  it("expands routes × viewports × states and makes no network call", async () => {
    const cfg = appConfig({ routes: ["/login", "/checkout"], viewports: [375, 1280], states: ["default", "hover"] });
    const targets = await resolveTargets(cfg, failFetch);
    expect(targets).toHaveLength(8); // 2 routes × 2 viewports × 2 states
    expect(targets).toContainEqual({
      name: "login",
      state: "default",
      viewport: 375,
      kind: "app",
      url: "http://localhost:3000/login",
    });
    expect(targets).toContainEqual({
      name: "checkout",
      state: "hover",
      viewport: 1280,
      kind: "app",
      url: "http://localhost:3000/checkout",
    });
  });

  it("orders app expansion as route, then viewport, then state", async () => {
    const cfg = appConfig({ routes: ["/a"], viewports: [375, 1280], states: ["default", "hover"] });
    const targets = await resolveTargets(cfg, failFetch);
    expect(targets.map((t) => `${t.viewport}:${t.state}`)).toEqual([
      "375:default",
      "375:hover",
      "1280:default",
      "1280:hover",
    ]);
  });

  it("derives a stable name from each route, including '/' and nested/relative paths", async () => {
    const cfg = appConfig({ routes: ["/", "/user/settings", "dashboard"], viewports: [1280], states: ["default"] });
    const targets = await resolveTargets(cfg, failFetch);
    expect(targets.map((t) => t.name)).toEqual(["index", "user-settings", "dashboard"]);
    expect(targets.map((t) => t.url)).toEqual([
      "http://localhost:3000/",
      "http://localhost:3000/user/settings",
      "http://localhost:3000/dashboard",
    ]);
  });

  it("throws naming routes when an app target has none", async () => {
    const cfg = appConfig({ routes: undefined, viewports: [1280], states: ["default"] });
    await expect(resolveTargets(cfg, failFetch)).rejects.toThrow(/routes/);
  });
});

// --- Mixed config ---------------------------------------------------------

describe("resolveTargets — mixed config", () => {
  it("resolves targets in config order: storybook first, then app", async () => {
    const { fetch } = mockFetch({
      [INDEX_URL]: {
        body: {
          v: 4,
          entries: { "card--default": { id: "card--default", title: "Card", name: "Default", type: "story" } },
        },
      },
    });
    const cfg = parseConfig({
      targets: [
        { type: "storybook", url: SB_URL },
        { type: "app", url: APP_URL, routes: ["/home"] },
      ],
      viewports: [1280],
      states: ["default"],
    });
    const targets = await resolveTargets(cfg, fetch);
    expect(targets.map((t) => t.kind)).toEqual(["storybook", "app"]);
    expect(targets[0]?.name).toBe("Card");
    expect(targets[1]?.name).toBe("home");
  });
});
