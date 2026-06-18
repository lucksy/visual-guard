import { describe, it, expect } from "vitest";
import { parseConfig, type Config } from "../scripts/lib/config";
import { resolveTargets, sanitizePathSegment, type FetchLike } from "../scripts/lib/targets";

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
// Instance labels derived from the URL host:port when no explicit `name` is set.
const SB_INSTANCE = "localhost-6006";
const APP_INSTANCE = "localhost-3000";

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
      instance: SB_INSTANCE,
      name: "Button",
      state: "Primary",
      viewport: 375,
      kind: "storybook",
      url: "http://localhost:6006/iframe.html?id=example-button--primary&viewMode=story",
      storyId: "example-button--primary",
    });
    expect(targets).toContainEqual({
      instance: SB_INSTANCE,
      name: "Button",
      state: "Disabled",
      viewport: 1280,
      kind: "storybook",
      url: "http://localhost:6006/iframe.html?id=example-button--disabled&viewMode=story",
      storyId: "example-button--disabled",
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
        instance: SB_INSTANCE,
        name: "Card",
        state: "Default",
        viewport: 1280,
        kind: "storybook",
        url: "http://localhost:6006/iframe.html?id=card--default&viewMode=story",
        storyId: "card--default",
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
      instance: SB_INSTANCE,
      name: "example-button",
      state: "primary",
      viewport: 375,
      kind: "storybook",
      url: "http://localhost:6006/iframe.html?id=example-button--primary&viewMode=story",
      storyId: "example-button--primary",
    });
    // An id with no "--" separator falls back to a "default" state.
    expect(targets).toContainEqual({
      instance: SB_INSTANCE,
      name: "standalone",
      state: "default",
      viewport: 1280,
      kind: "storybook",
      url: "http://localhost:6006/iframe.html?id=standalone&viewMode=story",
      storyId: "standalone",
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
      instance: APP_INSTANCE,
      name: "login",
      state: "default",
      viewport: 375,
      kind: "app",
      url: "http://localhost:3000/login",
    });
    expect(targets).toContainEqual({
      instance: APP_INSTANCE,
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

// --- Instance labels (multi-instance namespacing) -------------------------

describe("resolveTargets — instance labels", () => {
  it("derives the instance label from the URL host:port when no name is set", async () => {
    const { fetch } = mockFetch({
      [INDEX_URL]: {
        body: { v: 4, entries: { "x--y": { id: "x--y", title: "X", name: "Y", type: "story" } } },
      },
    });
    const targets = await resolveTargets(storybookConfig(), fetch);
    expect(targets.every((t) => t.instance === "localhost-6006")).toBe(true);
  });

  it("uses an explicit target name as the instance label", async () => {
    const { fetch } = mockFetch({
      [INDEX_URL]: {
        body: { v: 4, entries: { "x--y": { id: "x--y", title: "X", name: "Y", type: "story" } } },
      },
    });
    const cfg = parseConfig({
      targets: [{ type: "storybook", url: SB_URL, name: "components" }],
      viewports: [1280],
      states: ["default"],
    });
    const targets = await resolveTargets(cfg, fetch);
    expect(targets.every((t) => t.instance === "components")).toBe(true);
  });

  it("namespaces multiple Storybook + app instances distinctly", async () => {
    const { fetch } = mockFetch({
      "http://localhost:6006/index.json": {
        body: { v: 4, entries: { "btn--default": { id: "btn--default", title: "Button", name: "Default", type: "story" } } },
      },
      "http://localhost:6007/index.json": {
        body: { v: 4, entries: { "ico--default": { id: "ico--default", title: "Icon", name: "Default", type: "story" } } },
      },
    });
    const cfg = parseConfig({
      targets: [
        { type: "storybook", url: "http://localhost:6006", name: "components" },
        { type: "storybook", url: "http://localhost:6007" }, // host:port fallback
        { type: "app", url: "http://localhost:3000", name: "web", routes: ["/home"] },
        { type: "app", url: "http://localhost:4000", name: "admin", routes: ["/home"] },
      ],
      viewports: [1280],
      states: ["default"],
    });
    const targets = await resolveTargets(cfg, fetch);

    // Two app instances share component name "home" but live in distinct instance namespaces.
    const homes = targets.filter((t) => t.name === "home");
    expect(homes.map((t) => t.instance).sort()).toEqual(["admin", "web"]);
    expect(targets.find((t) => t.name === "Button")?.instance).toBe("components");
    expect(targets.find((t) => t.name === "Icon")?.instance).toBe("localhost-6007");
  });

  it("fails fast when two targets resolve to the same instance label", async () => {
    const cfg = parseConfig({
      targets: [
        { type: "app", url: "http://localhost:3000", name: "dup", routes: ["/a"] },
        { type: "app", url: "http://localhost:4000", name: "dup", routes: ["/b"] },
      ],
      viewports: [1280],
      states: ["default"],
    });
    await expect(resolveTargets(cfg, failFetch)).rejects.toThrow(/duplicate instance label.*dup/i);
  });

  it("fails fast when two unnamed targets share a host:port", async () => {
    const cfg = parseConfig({
      targets: [
        { type: "app", url: "http://localhost:3000", routes: ["/a"] },
        { type: "app", url: "http://localhost:3000", routes: ["/b"] },
      ],
      viewports: [1280],
      states: ["default"],
    });
    await expect(resolveTargets(cfg, failFetch)).rejects.toThrow(/duplicate instance label/i);
  });

  it("throws an actionable error when a target url is not a valid URL", async () => {
    const cfg = parseConfig({
      targets: [{ type: "app", url: "not-a-url", routes: ["/a"] }],
      viewports: [1280],
      states: ["default"],
    });
    await expect(resolveTargets(cfg, failFetch)).rejects.toThrow(/not a valid URL/i);
  });
});

// --- Path-traversal hardening (instance/name/state become filesystem segments) -------

describe("sanitizePathSegment", () => {
  it("strips path separators, parent-dir refs, and leading dots", () => {
    expect(sanitizePathSegment("../../etc/passwd")).not.toMatch(/\.\.|\//);
    expect(sanitizePathSegment("a/b\\c")).toBe("a-b-c");
    expect(sanitizePathSegment("..")).toBe("_"); // pure parent-dir refs collapse to empty → "_"
    expect(sanitizePathSegment("\0\0")).toBe("-"); // control chars → dash (safe, no traversal)
  });

  it("leaves ordinary segment values unchanged", () => {
    expect(sanitizePathSegment("Button")).toBe("Button");
    expect(sanitizePathSegment("localhost-6006")).toBe("localhost-6006");
    expect(sanitizePathSegment("user-settings")).toBe("user-settings");
  });
});

describe("resolveTargets — untrusted values can't escape the path", () => {
  const traversal = (segment: string): boolean => !segment.includes("..") && !segment.includes("/");

  it("sanitizes a malicious discovered story title and name", async () => {
    const { fetch } = mockFetch({
      [INDEX_URL]: {
        body: {
          v: 4,
          entries: {
            "evil--x": {
              id: "evil--x",
              title: "../../../../etc",
              name: "../../passwd",
              type: "story",
            },
          },
        },
      },
    });
    const targets = await resolveTargets(storybookConfig(), fetch);
    expect(targets).toHaveLength(1);
    expect(traversal(targets[0]!.name)).toBe(true);
    expect(traversal(targets[0]!.state)).toBe(true);
  });

  it("sanitizes a malicious explicit story id", async () => {
    const cfg = storybookConfig({ stories: ["../../evil--../../state"] });
    const targets = await resolveTargets(cfg, failFetch);
    expect(traversal(targets[0]!.name)).toBe(true);
    expect(traversal(targets[0]!.state)).toBe(true);
  });

  it("sanitizes a malicious app target name (instance) and route (name) and state", async () => {
    const cfg = parseConfig({
      targets: [{ type: "app", url: "http://localhost:3000", name: "../../../../", routes: ["/../../etc"] }],
      viewports: [1280],
      states: ["../../evil"],
    });
    const targets = await resolveTargets(cfg, failFetch);
    expect(traversal(targets[0]!.instance)).toBe(true);
    expect(traversal(targets[0]!.name)).toBe(true);
    expect(traversal(targets[0]!.state)).toBe(true);
  });
});

// --- Ladle discovery (the React harness Visual Guard can scaffold) --------

const LADLE_URL = "http://localhost:61000";
const LADLE_META_URL = `${LADLE_URL}/meta.json`;
const LADLE_INSTANCE = "localhost-61000";

function ladleConfig(
  opts: { stories?: string[]; viewports?: number[]; managed?: boolean } = {},
): Config {
  const target: Record<string, unknown> = { type: "ladle", url: LADLE_URL };
  if (opts.stories) target.stories = opts.stories;
  if (opts.managed !== undefined) target.managed = opts.managed;
  return parseConfig({
    targets: [target],
    viewports: opts.viewports ?? [1280],
    states: ["default"],
  });
}

describe("resolveTargets — Ladle discovery via /meta.json", () => {
  it("discovers stories from meta.json and expands story × viewport with preview URLs", async () => {
    const { fetch, calls } = mockFetch({
      [LADLE_META_URL]: {
        body: {
          stories: {
            "button--primary": { name: "Primary" },
            "button--disabled": { name: "Disabled" },
          },
        },
      },
    });
    const renders = await resolveTargets(ladleConfig({ viewports: [375, 1280] }), fetch);
    expect(calls).toEqual([LADLE_META_URL]);
    expect(renders).toHaveLength(4); // 2 stories × 2 viewports
    expect(renders[0]).toMatchObject({
      instance: LADLE_INSTANCE,
      name: "button",
      state: "Primary",
      viewport: 375,
      url: `${LADLE_URL}/?story=button--primary&mode=preview`,
      kind: "ladle",
    });
  });

  it("bypasses discovery when explicit stories are listed (no network)", async () => {
    const renders = await resolveTargets(ladleConfig({ stories: ["card--default"] }), failFetch);
    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({
      name: "card",
      state: "default",
      kind: "ladle",
      url: `${LADLE_URL}/?story=card--default&mode=preview`,
    });
  });

  it("preserves the managed flag through config parsing", () => {
    const cfg = ladleConfig({ managed: true });
    expect(cfg.targets[0]).toMatchObject({ type: "ladle", managed: true });
  });

  it("fails with an actionable error when meta.json has no stories", async () => {
    const { fetch } = mockFetch({ [LADLE_META_URL]: { body: { notStories: {} } } });
    await expect(resolveTargets(ladleConfig(), fetch)).rejects.toThrow(/Ladle meta .* has no "stories"/);
  });

  it("sanitizes a malicious ladle story id from meta.json", async () => {
    const safe = (segment: string): boolean => !segment.includes("..") && !segment.includes("/");
    const { fetch } = mockFetch({
      // No `name` field → the state derives from the (malicious) id, exercising id sanitization.
      [LADLE_META_URL]: { body: { stories: { "../../evil--../../state": {} } } },
    });
    const renders = await resolveTargets(ladleConfig(), fetch);
    expect(safe(renders[0]!.name)).toBe(true);
    expect(safe(renders[0]!.state)).toBe(true);
  });
});
