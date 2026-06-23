import { describe, it, expect } from "vitest";

/**
 * `monitor-targets.mjs` is a plain `.mjs` the dev-server monitor runs with a bare `node` (no tsx,
 * no engine deps), so — like detect-ui-change.mjs / install-deps.mjs — its testable logic is
 * imported here via a runtime-variable specifier so `tsc` never tries to type the un-typed `.mjs`.
 */
interface MonTarget {
  id?: string;
  kind: string;
  label: string;
  origin: string;
  url?: string;
  routes?: string[];
  stories?: string[] | null;
}
interface PollResult {
  status: string;
  detail: string;
}
interface RunOpts {
  fetchImpl: (url: string) => Promise<unknown>;
  log: (line: string) => void;
  prevState?: Map<string, string>;
  timeoutMs?: number;
}

const specifier = "../scripts/monitor-targets.mjs";
const mod = (await import(specifier)) as {
  resolveConfig: (
    cwd: string,
    env?: Record<string, string | undefined>,
    io?: { existsImpl?: (p: string) => boolean; readFileImpl?: (p: string) => string },
  ) => unknown;
  targetsFromConfig: (parsed: unknown) => MonTarget[];
  pollTarget: (
    target: MonTarget,
    fetchImpl: (url: string) => Promise<unknown>,
    timeoutMs?: number,
  ) => Promise<PollResult>;
  formatLine: (target: MonTarget, result: PollResult) => string;
  statusKey: (result: PollResult) => string;
  runOnce: (targets: MonTarget[], opts: RunOpts) => Promise<unknown[]>;
  runPass: (targets: MonTarget[], opts: RunOpts) => Promise<Map<string, string>>;
  parseArgs: (argv: string[]) => { once: boolean; intervalMs: number };
};
const {
  resolveConfig,
  targetsFromConfig,
  pollTarget,
  formatLine,
  statusKey,
  runOnce,
  runPass,
  parseArgs,
} = mod;

interface RouteResult {
  ok?: boolean;
  status?: number;
  json?: unknown;
  throw?: boolean;
}

/** A mock fetch routing by exact URL; an entry's `throw` (or a missing entry) simulates a refusal. */
function mockFetch(routes: Record<string, RouteResult>): (url: string) => Promise<unknown> {
  return async (url: string) => {
    const entry = routes[url];
    if (!entry || entry.throw) {
      throw new Error("ECONNREFUSED");
    }
    const status = entry.status ?? 200;
    return { ok: entry.ok ?? status < 400, status, json: async () => entry.json };
  };
}

describe("resolveConfig", () => {
  it("prefers project visual.config.json, then config/, then the plugin root", () => {
    const files: Record<string, string> = {
      "/p/visual.config.json": JSON.stringify({ from: "project" }),
      "/p/config/visual.config.json": JSON.stringify({ from: "config-dir" }),
    };
    const io = {
      existsImpl: (path: string): boolean => path in files,
      readFileImpl: (path: string): string => files[path] ?? "",
    };
    expect(resolveConfig("/p", {}, io)).toEqual({ from: "project" });

    files["/p/visual.config.json"] = "{ broken"; // project config now unparseable → falls through
    expect(resolveConfig("/p", {}, io)).toEqual({ from: "config-dir" });
  });

  it("falls back to the bundled plugin-root config", () => {
    const files: Record<string, string> = {
      "/plugin/config/visual.config.json": JSON.stringify({ from: "plugin" }),
    };
    const io = {
      existsImpl: (path: string): boolean => path in files,
      readFileImpl: (path: string): string => files[path] ?? "",
    };
    expect(resolveConfig("/p", { CLAUDE_PLUGIN_ROOT: "/plugin" }, io)).toEqual({ from: "plugin" });
  });

  it("returns null when nothing parses", () => {
    expect(resolveConfig("/p", {}, { existsImpl: () => false, readFileImpl: () => "" })).toBeNull();
    expect(
      resolveConfig("/p", {}, { existsImpl: () => true, readFileImpl: () => "{ broken" }),
    ).toBeNull();
  });
});

describe("targetsFromConfig", () => {
  it("extracts storybook + app targets and skips invalid ones", () => {
    const targets = targetsFromConfig({
      targets: [
        { type: "storybook", url: "http://localhost:6006" },
        { type: "app", name: "web", url: "http://localhost:3000", routes: ["/login", "/checkout"] },
        { type: "app" }, // no url → skipped
        { type: "bogus", url: "http://x" }, // bad type → skipped
        { type: "app", url: "not a url" }, // unparseable → skipped
      ],
    });
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      kind: "storybook",
      label: "localhost:6006",
      origin: "http://localhost:6006",
    });
    expect(targets[1]).toMatchObject({ kind: "app", label: "web", routes: ["/login", "/checkout"] });
  });

  it("returns [] for a config with no targets", () => {
    expect(targetsFromConfig(null)).toEqual([]);
    expect(targetsFromConfig({})).toEqual([]);
  });

  it("gives each target a unique id even when display labels collide", () => {
    const targets = targetsFromConfig({
      targets: [
        { type: "app", name: "dup", url: "http://localhost:3000", routes: [] },
        { type: "app", name: "dup", url: "http://localhost:4000", routes: [] },
      ],
    });
    expect(targets).toHaveLength(2);
    expect(targets[0]?.label).toBe(targets[1]?.label); // same display label …
    expect(targets[0]?.id).not.toBe(targets[1]?.id); // … but distinct ids
  });
});

describe("pollTarget — storybook", () => {
  const target: MonTarget = {
    kind: "storybook",
    label: "localhost:6006",
    origin: "http://localhost:6006",
    url: "http://localhost:6006",
    routes: [],
    stories: null,
  };

  it("ready with a story count from index.json", async () => {
    const fetchImpl = mockFetch({
      "http://localhost:6006/index.json": { json: { v: 5, entries: { a: {}, b: {}, c: {} } } },
    });
    expect(await pollTarget(target, fetchImpl)).toEqual({ status: "ready", detail: "3 stories" });
  });

  it("singular 'story' for a count of 1", async () => {
    const fetchImpl = mockFetch({
      "http://localhost:6006/index.json": { json: { entries: { a: {} } } },
    });
    expect((await pollTarget(target, fetchImpl)).detail).toBe("1 story");
  });

  it("degraded on a non-ok index.json", async () => {
    const fetchImpl = mockFetch({ "http://localhost:6006/index.json": { status: 503 } });
    expect(await pollTarget(target, fetchImpl)).toEqual({
      status: "degraded",
      detail: "index.json → HTTP 503",
    });
  });

  it("degraded on a legacy SB6 stories.json shape (the engine requires SB >= 7)", async () => {
    const fetchImpl = mockFetch({
      "http://localhost:6006/index.json": { json: { v: 3, stories: { a: {}, b: {} } } },
    });
    expect(await pollTarget(target, fetchImpl)).toEqual({
      status: "degraded",
      detail: "legacy Storybook (SB6) — capture requires SB >= 7",
    });
  });

  it("degraded when the index has no entries", async () => {
    const fetchImpl = mockFetch({ "http://localhost:6006/index.json": { json: { v: 5 } } });
    expect((await pollTarget(target, fetchImpl)).status).toBe("degraded");
  });

  it("unreachable when the index fetch throws", async () => {
    expect(await pollTarget(target, mockFetch({}))).toEqual({ status: "unreachable", detail: "" });
  });
});

describe("pollTarget — app", () => {
  const target: MonTarget = {
    kind: "app",
    label: "web",
    origin: "http://localhost:3000",
    url: "http://localhost:3000",
    routes: ["/login", "/checkout"],
    stories: null,
  };

  it("ready when the origin and all routes respond", async () => {
    const fetchImpl = mockFetch({
      "http://localhost:3000": { status: 200 },
      "http://localhost:3000/login": { status: 200 },
      "http://localhost:3000/checkout": { status: 200 },
    });
    expect(await pollTarget(target, fetchImpl)).toEqual({ status: "ready", detail: "2 route(s) ok" });
  });

  it("degraded when a route 5xxs", async () => {
    const fetchImpl = mockFetch({
      "http://localhost:3000": { status: 200 },
      "http://localhost:3000/login": { status: 200 },
      "http://localhost:3000/checkout": { status: 500 },
    });
    expect(await pollTarget(target, fetchImpl)).toEqual({
      status: "degraded",
      detail: "/checkout → HTTP 500",
    });
  });

  it("unreachable when the origin refuses", async () => {
    expect(await pollTarget(target, mockFetch({}))).toEqual({ status: "unreachable", detail: "" });
  });
});

describe("formatLine + statusKey", () => {
  const target: MonTarget = {
    kind: "storybook",
    label: "localhost:6006",
    origin: "http://localhost:6006",
  };

  it("formats each status with its icon", () => {
    expect(formatLine(target, { status: "ready", detail: "42 stories" })).toBe(
      "ok storybook localhost:6006 ready (42 stories)",
    );
    expect(formatLine(target, { status: "unreachable", detail: "" })).toBe(
      "?? storybook localhost:6006 unreachable (http://localhost:6006)",
    );
    expect(
      formatLine(
        { kind: "app", label: "web", origin: "http://localhost:3000" },
        { status: "degraded", detail: "/checkout → HTTP 500" },
      ),
    ).toBe("!! app web /checkout → HTTP 500");
  });

  it("statusKey changes when status or detail changes", () => {
    expect(statusKey({ status: "ready", detail: "3 stories" })).toBe("ready:3 stories");
    expect(statusKey({ status: "ready", detail: "4 stories" })).not.toBe(
      statusKey({ status: "ready", detail: "3 stories" }),
    );
  });
});

describe("runOnce / runPass", () => {
  const targets: MonTarget[] = [
    {
      kind: "storybook",
      label: "sb",
      origin: "http://localhost:6006",
      url: "http://localhost:6006",
      routes: [],
      stories: null,
    },
  ];

  it("runOnce logs a line per target", async () => {
    const lines: string[] = [];
    await runOnce(targets, {
      fetchImpl: mockFetch({
        "http://localhost:6006/index.json": { json: { entries: { a: {} } } },
      }),
      log: (line) => lines.push(line),
    });
    expect(lines).toEqual(["ok storybook sb ready (1 story)"]);
  });

  it("runPass logs only on a status transition", async () => {
    const prevState = new Map<string, string>();
    const lines: string[] = [];
    const log = (line: string): void => {
      lines.push(line);
    };

    // First pass: ready → logged.
    const readyFetch = mockFetch({
      "http://localhost:6006/index.json": { json: { entries: { a: {} } } },
    });
    await runPass(targets, { fetchImpl: readyFetch, log, prevState });
    expect(lines).toHaveLength(1);

    // Second pass, same status → NOT logged again.
    await runPass(targets, { fetchImpl: readyFetch, log, prevState });
    expect(lines).toHaveLength(1);

    // Third pass, now unreachable → a new transition is logged.
    await runPass(targets, { fetchImpl: mockFetch({}), log, prevState });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("unreachable");
  });

  it("tracks two same-label targets separately (colliding labels don't drop transitions)", async () => {
    // Built via targetsFromConfig so each carries a unique id; prevState keys by id, not label.
    const dup = targetsFromConfig({
      targets: [
        { type: "app", name: "dup", url: "http://localhost:3000", routes: [] },
        { type: "app", name: "dup", url: "http://localhost:4000", routes: [] },
      ],
    });
    const prevState = new Map<string, string>();
    const lines: string[] = [];
    await runPass(dup, {
      fetchImpl: mockFetch({ "http://localhost:3000": { status: 200 }, "http://localhost:4000": { status: 200 } }),
      log: (line) => lines.push(line),
      prevState,
    });
    // Both transitions are reported (keyed by id) — a label-keyed map would have logged only one.
    expect(lines).toHaveLength(2);
    expect(prevState.size).toBe(2);
  });
});

describe("parseArgs", () => {
  it("defaults to a polling loop", () => {
    expect(parseArgs([])).toEqual({ once: false, intervalMs: 5000 });
  });
  it("reads --once and --interval", () => {
    expect(parseArgs(["--once"])).toMatchObject({ once: true });
    expect(parseArgs(["--interval", "1000"])).toMatchObject({ intervalMs: 1000 });
    expect(parseArgs(["--interval", "nope"])).toMatchObject({ intervalMs: 5000 }); // invalid ignored
  });

  it("does not swallow a following flag as the --interval value", () => {
    // `--interval --once`: --once must NOT be consumed as the (invalid) interval value.
    expect(parseArgs(["--interval", "--once"])).toEqual({ once: true, intervalMs: 5000 });
  });
});
