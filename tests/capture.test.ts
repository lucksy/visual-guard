import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parseConfig } from "../scripts/lib/config";
import type { FetchLike, RenderTarget } from "../scripts/lib/targets";
import {
  captureAll,
  filterByScope,
  filterTargets,
  makeRunId,
  parseArgs,
  probeOrigins,
  readFingerprints,
  readPngDimensions,
  readScopeFile,
  renderRelPath,
  resolveConcurrency,
  selectRotatingRecapture,
  type CaptureDeps,
  type Launcher,
  type RendersFile,
} from "../scripts/capture";

const render = (over: Partial<RenderTarget> = {}): RenderTarget => ({
  instance: "components",
  name: "Button",
  state: "Primary",
  viewport: 1280,
  kind: "storybook",
  url: "http://localhost:6006/iframe.html?id=button--primary&viewMode=story",
  ...over,
});

// --- Pure helpers ---------------------------------------------------------

describe("parseArgs", () => {
  it("defaults config and leaves target/run unset", () => {
    expect(parseArgs([])).toEqual({ config: "config/visual.config.json", skipUnchanged: false });
  });

  it("reads --config, --target, and --run", () => {
    expect(parseArgs(["--target", "Button", "--config", "c.json", "--run", "R1"])).toEqual({
      config: "c.json",
      target: "Button",
      runId: "R1",
      skipUnchanged: false,
    });
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("throws on a flag missing its value", () => {
    expect(() => parseArgs(["--target"])).toThrow(/missing value/);
  });

  it("reads --concurrency as a positive integer", () => {
    expect(parseArgs(["--concurrency", "6"]).concurrency).toBe(6);
  });

  it("throws on a non-positive or non-integer --concurrency", () => {
    expect(() => parseArgs(["--concurrency", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--concurrency", "2.5"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--concurrency", "x"])).toThrow(/positive integer/);
  });

  it("reads --scope-file", () => {
    expect(parseArgs(["--scope-file", ".visual-guard/scope.json"]).scopeFile).toBe(
      ".visual-guard/scope.json",
    );
  });
});

describe("filterByScope", () => {
  const targets = [
    render({ name: "Button", storyId: "button--primary" }),
    render({ name: "Card", storyId: "card--default" }),
    render({ name: "Input", storyId: "input--default" }),
  ];

  it("keeps renders by component name (case-insensitive)", () => {
    expect(filterByScope(targets, { components: ["button", "card"], storyIds: [] }).map((t) => t.name)).toEqual(
      ["Button", "Card"],
    );
  });

  it("keeps renders by exact story id", () => {
    expect(
      filterByScope(targets, { components: [], storyIds: ["input--default"] }).map((t) => t.name),
    ).toEqual(["Input"]);
  });

  it("keeps nothing for an empty scope (callers only apply for mode 'scoped')", () => {
    expect(filterByScope(targets, { components: [], storyIds: [] })).toEqual([]);
  });
});

describe("readScopeFile (never narrows on uncertainty)", () => {
  const reads = (content: string) => (): string => content;

  it("returns the scope for a 'scoped' decision", () => {
    expect(
      readScopeFile("x", reads(JSON.stringify({ mode: "scoped", components: ["Button"], storyIds: [] }))),
    ).toEqual({ components: ["Button"], storyIds: [] });
  });

  it("returns null for mode 'all' or 'none' (→ full sweep)", () => {
    expect(readScopeFile("x", reads(JSON.stringify({ mode: "all" })))).toBeNull();
    expect(readScopeFile("x", reads(JSON.stringify({ mode: "none" })))).toBeNull();
  });

  it("returns null for a 'scoped' decision with nothing to keep (never capture 0)", () => {
    expect(readScopeFile("x", reads(JSON.stringify({ mode: "scoped", components: [], storyIds: [] })))).toBeNull();
  });

  it("returns null on a malformed/unreadable file (→ full sweep, never narrow on error)", () => {
    expect(readScopeFile("x", reads("not json"))).toBeNull();
    expect(
      readScopeFile("x", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});

describe("resolveConcurrency", () => {
  it("uses an explicit request (floored) when >= 1", () => {
    expect(resolveConcurrency(5, 8)).toBe(5);
    expect(resolveConcurrency(2.9, 8)).toBe(2);
    expect(resolveConcurrency(1, 1)).toBe(1);
    expect(resolveConcurrency(50, 4)).toBe(50); // explicit is not clamped — the caller does that
  });

  it("falls back to a cores-based default (cores−1, clamped 2..8) on absent/bogus request", () => {
    expect(resolveConcurrency(undefined, 8)).toBe(7);
    expect(resolveConcurrency(0, 8)).toBe(7); // < 1 → fallback
    expect(resolveConcurrency(undefined, 1)).toBe(2); // clamp up to 2
    expect(resolveConcurrency(undefined, 100)).toBe(8); // clamp down to 8
    expect(resolveConcurrency(undefined, 0)).toBe(3); // unknown cores → assume 4 → 3
  });
});

describe("renderRelPath", () => {
  it("nests instance / name / state@viewport.png", () => {
    expect(renderRelPath(render())).toBe("components/Button/Primary@1280.png");
  });
});

describe("makeRunId", () => {
  it("formats a UTC timestamp as YYYYMMDD-HHMMSS", () => {
    expect(makeRunId(new Date("2026-06-13T08:09:05.000Z"))).toBe("20260613-080905");
  });
});

describe("filterTargets", () => {
  const targets = [
    render({ instance: "components", name: "Button" }),
    render({ instance: "components", name: "Card" }),
    render({ instance: "icons", name: "Button" }),
  ];

  it("returns all targets when no filter is given", () => {
    expect(filterTargets(targets)).toHaveLength(3);
  });

  it("matches by component name across instances", () => {
    expect(filterTargets(targets, "button").map((t) => t.instance)).toEqual(["components", "icons"]);
  });

  it("matches by instance label", () => {
    expect(filterTargets(targets, "components").map((t) => t.name)).toEqual(["Button", "Card"]);
  });

  it("matches by instance/name", () => {
    expect(filterTargets(targets, "icons/Button")).toHaveLength(1);
  });
});

describe("probeOrigins", () => {
  it("dedupes origins across renders", () => {
    expect(
      probeOrigins([
        render({ url: "http://localhost:6006/iframe.html?id=a" }),
        render({ url: "http://localhost:6006/iframe.html?id=b" }),
        render({ url: "http://localhost:3000/login" }),
      ]),
    ).toEqual(["http://localhost:6006", "http://localhost:3000"]);
  });
});

describe("readPngDimensions", () => {
  /** A 24-byte PNG header (signature + IHDR width/height) — enough for the dimension reader. */
  const pngHeader = (width: number, height: number): Buffer => {
    const buf = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8); // IHDR chunk length
    buf.write("IHDR", 12, "latin1");
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf;
  };

  it("reads width/height from a PNG IHDR header", () => {
    expect(readPngDimensions(pngHeader(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it("returns null for a non-PNG / truncated / zero-sized buffer (never throws)", () => {
    expect(readPngDimensions(Buffer.from("PNG-BYTES"))).toBeNull(); // too short + wrong signature
    expect(readPngDimensions(pngHeader(0, 10))).toBeNull(); // zero dimension
    const wrongChunk = pngHeader(10, 10);
    wrongChunk.write("IDAT", 12, "latin1"); // valid signature but not IHDR first
    expect(readPngDimensions(wrongChunk)).toBeNull();
  });
});

// --- Orchestration (fake browser, no real Chromium) -----------------------

interface FakeCalls {
  contexts: unknown[];
  initScripts: string[];
  gotos: string[];
  styles: string[];
  evaluates: string[];
  screenshots: number;
  pageCloses: number;
  contextCloses: number;
  browserCloses: number;
}

function fakeBrowser(
  screenshotBuffer: Buffer = Buffer.from("PNG-BYTES"),
): { launch: Launcher; calls: FakeCalls } {
  const calls: FakeCalls = {
    contexts: [],
    initScripts: [],
    gotos: [],
    styles: [],
    evaluates: [],
    screenshots: 0,
    pageCloses: 0,
    contextCloses: 0,
    browserCloses: 0,
  };
  const launch: Launcher = async () => ({
    newContext: async (options) => {
      calls.contexts.push(options);
      return {
        addInitScript: async (script: string) => {
          calls.initScripts.push(script);
        },
        newPage: async () => ({
          goto: async (url: string) => {
            calls.gotos.push(url);
            return null;
          },
          addStyleTag: async ({ content }: { content: string }) => {
            calls.styles.push(content);
            return null;
          },
          evaluate: async (script: string) => {
            calls.evaluates.push(script);
            return undefined;
          },
          screenshot: async () => {
            calls.screenshots++;
            return screenshotBuffer;
          },
          close: async () => {
            calls.pageCloses++;
          },
        }),
        close: async () => {
          calls.contextCloses++;
        },
      };
    },
    close: async () => {
      calls.browserCloses++;
    },
  });
  return { launch, calls };
}

const okFetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}) });

function deps(over: Partial<CaptureDeps>): CaptureDeps {
  return {
    fetch: okFetch,
    launch: fakeBrowser().launch,
    writeFile: () => undefined,
    readFile: () => {
      throw new Error("readFile not stubbed");
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

describe("captureAll", () => {
  it("captures every render into instance-nested paths and freezes animations", async () => {
    const config = parseConfig({
      targets: [
        {
          type: "storybook",
          url: "http://localhost:6006",
          name: "components",
          stories: ["button--primary"],
        },
      ],
      viewports: [375, 1280],
      states: ["default"],
    });
    const { launch, calls } = fakeBrowser();
    const writes: Record<string, Buffer> = {};

    const result = await captureAll(
      config,
      { runId: "RUN1", outRoot: ".vg-test" },
      deps({ launch, writeFile: (p, d) => void (writes[p] = d) }),
    );

    expect(result.runId).toBe("RUN1");
    expect(result.written).toEqual([
      "components/button/primary@375.png",
      "components/button/primary@1280.png",
    ]);
    expect(calls.screenshots).toBe(2);
    expect(calls.gotos).toEqual([
      "http://localhost:6006/iframe.html?id=button--primary&viewMode=story",
      "http://localhost:6006/iframe.html?id=button--primary&viewMode=story",
    ]);
    // Freeze is registered before load (addInitScript) AND re-applied after load (addStyleTag).
    expect(calls.initScripts).toHaveLength(2);
    expect(calls.initScripts.every((s) => s.includes("animation-duration: 0s"))).toBe(true);
    expect(calls.styles.every((s) => s.includes("caret-color"))).toBe(true);
    // Fonts/images settle runs before each screenshot.
    expect(calls.evaluates.every((s) => s.includes("document.fonts"))).toBe(true);
    // Every page and context is closed (no resource leak).
    expect(calls.pageCloses).toBe(2);
    expect(calls.contextCloses).toBe(2);
    expect(calls.browserCloses).toBe(1);
    expect(Object.keys(writes)).toContain(
      join(".vg-test", "runs", "RUN1", "current", "components/button/primary@1280.png"),
    );
  });

  it("persists a renders.json sidecar keyed by render path (manifest v2, T-13)", async () => {
    const config = parseConfig({
      targets: [
        {
          type: "storybook",
          url: "http://localhost:6006",
          name: "components",
          stories: ["button--primary"],
        },
      ],
      viewports: [1280],
      states: ["default"],
    });
    const { launch } = fakeBrowser();
    const writes: Record<string, Buffer> = {};

    await captureAll(
      config,
      { runId: "RUN1", outRoot: ".vg-test" },
      deps({ launch, writeFile: (p, d) => void (writes[p] = d) }),
    );

    const rendersPath = join(".vg-test", "runs", "RUN1", "renders.json");
    expect(Object.keys(writes)).toContain(rendersPath);
    const parsed = JSON.parse(writes[rendersPath]!.toString()) as RendersFile;
    expect(parsed.version).toBe(1);
    expect(parsed.renders["components/button/primary@1280.png"]).toEqual({
      url: "http://localhost:6006/iframe.html?id=button--primary&viewMode=story",
      kind: "storybook",
      viewport: 1280,
      currentDimensions: null, // the fake screenshot buffer isn't a real PNG → dims unread
    });
  });

  it("threads a real PNG's dimensions into renders.json (currentDimensions non-null path)", async () => {
    // A valid 24-byte PNG header (signature + IHDR width/height) so readPngDimensions resolves
    // dims — proves the capture → renders.json wiring yields a non-null currentDimensions, not
    // just the null branch the placeholder-buffer test covers.
    const pngHeader = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngHeader, 0);
    pngHeader.writeUInt32BE(13, 8);
    pngHeader.write("IHDR", 12, "latin1");
    pngHeader.writeUInt32BE(1280, 16);
    pngHeader.writeUInt32BE(480, 20);

    const config = parseConfig({
      targets: [
        { type: "storybook", url: "http://localhost:6006", name: "components", stories: ["button--primary"] },
      ],
      viewports: [1280],
      states: ["default"],
    });
    const { launch } = fakeBrowser(pngHeader);
    const writes: Record<string, Buffer> = {};

    await captureAll(
      config,
      { runId: "RUN1", outRoot: ".vg-test" },
      deps({ launch, writeFile: (p, d) => void (writes[p] = d) }),
    );

    const rendersPath = join(".vg-test", "runs", "RUN1", "renders.json");
    const parsed = JSON.parse(writes[rendersPath]!.toString()) as RendersFile;
    expect(parsed.renders["components/button/primary@1280.png"]!.currentDimensions).toEqual({
      width: 1280,
      height: 480,
    });
  });

  it("uses a timestamp run id when none is provided", async () => {
    const config = parseConfig({
      targets: [{ type: "storybook", url: "http://localhost:6006", stories: ["a--b"] }],
      viewports: [1280],
      states: ["default"],
    });
    const result = await captureAll(config, { outRoot: ".vg-test" }, deps({}));
    expect(result.runId).toBe("20260101-000000");
  });

  it("fails fast with an actionable message when a target server is unreachable (R2)", async () => {
    const config = parseConfig({
      targets: [{ type: "storybook", url: "http://localhost:6006", stories: ["a--b"] }],
      viewports: [1280],
      states: ["default"],
    });
    const downFetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      captureAll(config, { runId: "R" }, deps({ fetch: downFetch })),
    ).rejects.toThrow(/could not reach http:\/\/localhost:6006/);
  });

  it("throws when --target matches no render", async () => {
    const config = parseConfig({
      targets: [{ type: "storybook", url: "http://localhost:6006", stories: ["a--b"] }],
      viewports: [1280],
      states: ["default"],
    });
    await expect(
      captureAll(config, { target: "Nonexistent" }, deps({})),
    ).rejects.toThrow(/no targets matched/);
  });

  // --- failFast tolerance (managed-harness / Studio-sync path) ---
  // A browser whose goto throws for any URL containing `badUrlSubstring`, simulating a story that
  // crashes on load (e.g. an auto-generated story for a prop-required component).
  function throwingBrowser(badUrlSubstring: string): Launcher {
    return async () => ({
      newContext: async () => ({
        addInitScript: async () => undefined,
        newPage: async () => ({
          goto: async (url: string) => {
            if (url.includes(badUrlSubstring)) throw new Error("net::ERR_ABORTED loading story");
            return null;
          },
          addStyleTag: async () => null,
          evaluate: async () => undefined,
          screenshot: async () => Buffer.from("PNG-BYTES"),
          close: async () => undefined,
        }),
        close: async () => undefined,
      }),
      close: async () => undefined,
    });
  }

  const twoLadleStories = parseConfig({
    targets: [
      { type: "ladle", url: "http://localhost:61000", name: "ui", stories: ["button--primary", "modal--open"] },
    ],
    viewports: [1280],
    states: ["default"],
  });

  it("aborts the whole run by default (failFast) when a render fails to load", async () => {
    await expect(
      captureAll(twoLadleStories, { runId: "R", outRoot: ".vg-test" }, deps({ launch: throwingBrowser("modal--open") })),
    ).rejects.toThrow(/failed to capture ui\/modal/);
  });

  it("with failFast:false records the error, writes no png for it, and finishes the run", async () => {
    const writes: Record<string, Buffer> = {};
    const result = await captureAll(
      twoLadleStories,
      { runId: "R", outRoot: ".vg-test", failFast: false },
      deps({ launch: throwingBrowser("modal--open"), writeFile: (p, d) => void (writes[p] = d) }),
    );
    // The good render is written; the failed one is not.
    expect(result.written).toEqual(["ui/button/primary@1280.png"]);
    // renders.json records BOTH lanes; only the failed one carries an `error` + null dimensions.
    const rendersPath = join(".vg-test", "runs", "R", "renders.json");
    const parsed = JSON.parse(writes[rendersPath]!.toString()) as RendersFile;
    expect(parsed.renders["ui/button/primary@1280.png"]!.error).toBeUndefined();
    expect(parsed.renders["ui/modal/open@1280.png"]!.error).toMatch(/ERR_ABORTED/);
    expect(parsed.renders["ui/modal/open@1280.png"]!.currentDimensions).toBeNull();
  });

  it("namespaces multiple instances so same-named components don't collide", async () => {
    const config = parseConfig({
      targets: [
        { type: "app", url: "http://localhost:3000", name: "web", routes: ["/home"] },
        { type: "app", url: "http://localhost:4000", name: "admin", routes: ["/home"] },
      ],
      viewports: [1280],
      states: ["default"],
    });
    const result = await captureAll(config, { runId: "R" }, deps({}));
    expect(result.written).toEqual([
      "web/home/default@1280.png",
      "admin/home/default@1280.png",
    ]);
  });

  it("preserves target order in `written` even when later renders finish first (concurrency)", async () => {
    // Four stories; a launcher whose goto delay DECREASES with story order, so completion order is
    // reversed (d, c, b, a) while the pool runs them in parallel. The index-slotted result must
    // still come back in target order (a, b, c, d) — order is config-driven, never completion-driven.
    const order = ["a--x", "b--x", "c--x", "d--x"];
    const config = parseConfig({
      targets: [{ type: "storybook", url: "http://localhost:6006", name: "components", stories: order }],
      viewports: [1280],
      states: ["default"],
    });
    const reverseCompletionLauncher: Launcher = async () => ({
      newContext: async () => ({
        addInitScript: async () => undefined,
        newPage: async () => ({
          goto: async (url: string) => {
            const idx = order.findIndex((id) => url.includes(`id=${id}`));
            // a (idx 0) waits longest → finishes last; d (idx 3) finishes first.
            await new Promise((resolve) => setTimeout(resolve, (order.length - idx) * 10));
            return null;
          },
          addStyleTag: async () => null,
          evaluate: async () => undefined,
          screenshot: async () => Buffer.from("PNG-BYTES"),
          close: async () => undefined,
        }),
        close: async () => undefined,
      }),
      close: async () => undefined,
    });

    const result = await captureAll(
      config,
      { runId: "R", outRoot: ".vg-test", concurrency: 4 },
      deps({ launch: reverseCompletionLauncher }),
    );

    expect(result.written).toEqual([
      "components/a/x@1280.png",
      "components/b/x@1280.png",
      "components/c/x@1280.png",
      "components/d/x@1280.png",
    ]);
  });

  it("captures only the scoped components when options.scope is set", async () => {
    const config = parseConfig({
      targets: [
        {
          type: "storybook",
          url: "http://localhost:6006",
          name: "components",
          stories: ["button--primary", "card--default", "input--default"],
        },
      ],
      viewports: [1280],
      states: ["default"],
    });
    const { launch, calls } = fakeBrowser();
    const result = await captureAll(
      config,
      { runId: "R", outRoot: ".vg-test", scope: { components: ["button"], storyIds: [] } },
      deps({ launch }),
    );
    expect(result.written).toEqual(["components/button/primary@1280.png"]);
    expect(calls.screenshots).toBe(1);
  });

  it("captures the matching subset when a scope names a known + an unknown component (partial match)", async () => {
    const config = parseConfig({
      targets: [
        {
          type: "storybook",
          url: "http://localhost:6006",
          name: "components",
          stories: ["button--primary", "card--default"],
        },
      ],
      viewports: [1280],
      states: ["default"],
    });
    const { launch, calls } = fakeBrowser();
    const result = await captureAll(
      config,
      // "ghost" has no render (e.g. its stories were filtered out) — must NOT error, just capture button.
      { runId: "R", outRoot: ".vg-test", scope: { components: ["button", "ghost"], storyIds: [] } },
      deps({ launch }),
    );
    expect(result.written).toEqual(["components/button/primary@1280.png"]);
    expect(calls.screenshots).toBe(1);
  });

  it("fails with an actionable message when the scope matches no render", async () => {
    const config = parseConfig({
      targets: [{ type: "storybook", url: "http://localhost:6006", stories: ["button--primary"] }],
      viewports: [1280],
      states: ["default"],
    });
    await expect(
      captureAll(config, { scope: { components: ["nonexistent"], storyIds: [] } }, deps({})),
    ).rejects.toThrow(/no renders matched the change scope/);
  });

  it("sanitizes a malicious --run id so the run dir cannot escape outRoot", async () => {
    const config = parseConfig({
      targets: [{ type: "storybook", url: "http://localhost:6006", stories: ["a--b"] }],
      viewports: [1280],
      states: ["default"],
    });
    const result = await captureAll(
      config,
      { runId: "../../../../etc/evil", outRoot: ".vg-test" },
      deps({}),
    );
    expect(result.runId).not.toContain("..");
    expect(result.runId).not.toContain("/");
    expect(result.runDir.startsWith(join(".vg-test", "runs"))).toBe(true);
  });
});

describe("readFingerprints", () => {
  const read = (obj: unknown): ((p: string) => Buffer) => () => Buffer.from(JSON.stringify(obj));

  it("parses a valid fingerprints file (fp required, png optional)", () => {
    const fps = readFingerprints(
      "x",
      read({ version: 1, renders: { "a.png": { fp: "F1", png: "P1" }, "b.png": { fp: "F2" } } }),
    );
    expect(fps).toEqual({ "a.png": { fp: "F1", png: "P1" }, "b.png": { fp: "F2" } });
  });

  it("returns {} on a wrong version, malformed shape, or unreadable file (skip nothing on uncertainty)", () => {
    expect(readFingerprints("x", read({ version: 2, renders: { "a.png": { fp: "F1" } } }))).toEqual({});
    expect(readFingerprints("x", read({ version: 1, renders: null }))).toEqual({});
    expect(readFingerprints("x", read({ version: 1 }))).toEqual({});
    expect(
      readFingerprints("x", () => {
        throw new Error("ENOENT");
      }),
    ).toEqual({});
  });

  it("drops entries with no string fp", () => {
    const fps = readFingerprints(
      "x",
      read({ version: 1, renders: { good: { fp: "F" }, bad: { png: "P" }, alsoBad: 7 } }),
    );
    expect(fps).toEqual({ good: { fp: "F" } });
  });
});

describe("selectRotatingRecapture (the forced-recapture safety bound)", () => {
  const keys = Array.from({ length: 100 }, (_, i) => `k${String(i).padStart(3, "0")}.png`);

  it("re-shoots ceil(sqrt(N)) by default — negligible for large N", () => {
    expect(selectRotatingRecapture(keys, "RUN").size).toBe(10); // ceil(sqrt(100)) → 10% here
    expect(selectRotatingRecapture(Array.from({ length: 9 }, (_, i) => `${i}`), "RUN").size).toBe(3);
    // For the enterprise case the overhead is tiny: ceil(sqrt(20000)) = 142 → ~0.7%.
    expect(selectRotatingRecapture(Array.from({ length: 20000 }, (_, i) => `${i}`), "RUN").size).toBe(142);
  });

  it("0 disables forced recapture; a quota ≥ N re-shoots them all", () => {
    expect(selectRotatingRecapture(keys, "RUN", 0).size).toBe(0);
    expect(selectRotatingRecapture(keys, "RUN", 999).size).toBe(keys.length);
    expect(selectRotatingRecapture([], "RUN").size).toBe(0);
  });

  it("is deterministic per run id, and ROTATES the window across run ids", () => {
    const a = selectRotatingRecapture(keys, "RUN-A", 10);
    const b = selectRotatingRecapture(keys, "RUN-B", 10);
    expect(selectRotatingRecapture(keys, "RUN-A", 10)).toEqual(a); // deterministic
    expect([...a]).not.toEqual([...b]); // different run → different window (rotation over runs)
  });

  it("over enough rotations, every key gets re-verified (no permanent blind spot)", () => {
    const seen = new Set<string>();
    for (let r = 0; r < 200; r++) {
      for (const k of selectRotatingRecapture(keys, `run-${r}`, 10)) seen.add(k);
    }
    expect(seen.size).toBe(keys.length); // full coverage → bounded-latency, not caught-never
  });
});

describe("captureAll — fingerprint-skip (--skip-unchanged, opt-in)", () => {
  const baselineDir = ".vg-baselines-test";
  const rel = "components/button/primary@1280.png";
  const baselineBytes = Buffer.from("BASELINE-PNG-BYTES");
  const pngSha1 = createHash("sha1").update(baselineBytes).digest("hex");
  const fpFile = "/tmp/fps-current.json";

  const oneStory = parseConfig({
    targets: [
      { type: "storybook", url: "http://localhost:6006", name: "components", stories: ["button--primary"] },
    ],
    viewports: [1280],
    states: ["default"],
  });

  /** A reader that routes the current-fps path, the approved-fps path, and the baseline PNG path. */
  const routedRead =
    (currentJson: unknown, approvedJson: unknown, png: Buffer = baselineBytes) =>
    (p: string): Buffer => {
      if (p === fpFile) return Buffer.from(JSON.stringify(currentJson));
      if (p === join(baselineDir, "fingerprints.json")) return Buffer.from(JSON.stringify(approvedJson));
      if (p === join(baselineDir, rel)) return png;
      throw new Error(`unexpected read ${p}`);
    };

  const run = (over: Parameters<typeof captureAll>[1], read: (p: string) => Buffer) => {
    const { launch, calls } = fakeBrowser();
    const writes: Record<string, Buffer> = {};
    return captureAll(
      oneStory,
      { runId: "R", outRoot: ".vg-test", baselineDir, ...over },
      deps({ launch, writeFile: (p, d) => void (writes[p] = d), readFile: read }),
    ).then((result) => ({ result, calls, writes }));
  };

  // skipForceSample:0 disables the rotating forced-recapture so these tests exercise the PURE copy-
  // forward mechanic (rotating recapture is tested separately below).
  const SKIP_ON = { skipUnchanged: true, fingerprintsFile: fpFile, skipForceSample: 0 } as const;
  const matchCurrent = { version: 1, renders: { [rel]: { fp: "FP1" } } };
  const matchApproved = { version: 1, renders: { [rel]: { fp: "FP1", png: pngSha1 } } };

  it("copies the baseline forward (NO browser) when current fp == approved fp and the PNG is intact", async () => {
    const { result, calls, writes } = await run(SKIP_ON, routedRead(matchCurrent, matchApproved));
    expect(calls.screenshots).toBe(0); // never screenshotted
    expect(calls.browserCloses).toBe(0); // browser never even launched (all skipped)
    expect(writes[join(".vg-test", "runs", "R", "current", rel)]).toEqual(baselineBytes); // copied forward
    expect(result.written).toEqual([rel]);
    const renders = JSON.parse(
      writes[join(".vg-test", "runs", "R", "renders.json")]!.toString("utf8"),
    ) as RendersFile;
    expect(renders.renders[rel]?.skipped).toBe(true);
  });

  it("CAPTURES (no skip) when the current fp differs from the approved fp", async () => {
    const { calls } = await run(
      SKIP_ON,
      routedRead({ version: 1, renders: { [rel]: { fp: "DIFFERENT" } } }, matchApproved),
    );
    expect(calls.screenshots).toBe(1);
  });

  it("CAPTURES (fail closed) when the approved entry carries NO baseline-PNG hash (tamper-evidence absent)", async () => {
    const { calls } = await run(
      SKIP_ON,
      routedRead(matchCurrent, { version: 1, renders: { [rel]: { fp: "FP1" } } }),
    );
    expect(calls.screenshots).toBe(1);
  });

  it("CAPTURES when the live baseline PNG no longer hashes to the approved png (tampered/corrupted baseline)", async () => {
    const { calls } = await run(
      SKIP_ON,
      routedRead(matchCurrent, matchApproved, Buffer.from("CORRUPTED-DIFFERENT-BYTES")),
    );
    expect(calls.screenshots).toBe(1);
  });

  it("CAPTURES when --skip-unchanged is OFF, even with matching fingerprints (opt-in)", async () => {
    const { calls } = await run(
      { fingerprintsFile: fpFile },
      routedRead(matchCurrent, matchApproved),
    );
    expect(calls.screenshots).toBe(1);
  });

  it("persists the run's current fingerprints to runs/<id>/fingerprints.json (even without --skip-unchanged)", async () => {
    const { writes } = await run({ fingerprintsFile: fpFile }, routedRead(matchCurrent, matchApproved));
    const persisted = JSON.parse(
      writes[join(".vg-test", "runs", "R", "fingerprints.json")]!.toString("utf8"),
    ) as { version: number; renders: Record<string, { fp: string }> };
    expect(persisted.version).toBe(1);
    expect(persisted.renders[rel]).toEqual({ fp: "FP1" }); // so /visual-baseline can pair fp↔PNG
  });

  it("CAPTURES when no --fingerprints file is supplied", async () => {
    // readFile should never be hit for fps (skip disabled w/o a fingerprints path); only capture writes.
    const { calls } = await run({ skipUnchanged: true }, () => {
      throw new Error("should not read");
    });
    expect(calls.screenshots).toBe(1);
  });

  it("mixes skip + capture: one story copied forward, the other screenshotted (browser launched once)", async () => {
    const twoStories = parseConfig({
      targets: [
        {
          type: "storybook",
          url: "http://localhost:6006",
          name: "components",
          stories: ["button--primary", "card--default"],
        },
      ],
      viewports: [1280],
      states: ["default"],
    });
    const relCard = "components/card/default@1280.png";
    const { launch, calls } = fakeBrowser();
    const writes: Record<string, Buffer> = {};
    const read = (p: string): Buffer => {
      if (p === fpFile) {
        return Buffer.from(JSON.stringify({ version: 1, renders: { [rel]: { fp: "FP1" } } }));
      }
      if (p === join(baselineDir, "fingerprints.json")) {
        return Buffer.from(JSON.stringify(matchApproved)); // only button has an approved entry
      }
      if (p === join(baselineDir, rel)) return baselineBytes;
      throw new Error(`unexpected read ${p}`);
    };
    const result = await captureAll(
      twoStories,
      { runId: "R", outRoot: ".vg-test", baselineDir, ...SKIP_ON },
      deps({ launch, writeFile: (p, d) => void (writes[p] = d), readFile: read }),
    );
    expect(calls.browserCloses).toBe(1); // launched once for the un-skippable card
    expect(calls.screenshots).toBe(1); // only the card was shot
    expect(new Set(result.written)).toEqual(new Set([rel, relCard]));
    const renders = JSON.parse(
      writes[join(".vg-test", "runs", "R", "renders.json")]!.toString("utf8"),
    ) as RendersFile;
    expect(renders.renders[rel]?.skipped).toBe(true);
    expect(renders.renders[relCard]?.skipped).toBeUndefined();
  });

  it("DROPS the run's persisted fps when a source INPUT changed during the run (approve-time TOCTOU guard)", async () => {
    const inputRel = "src/Button.tsx";
    const inputAbs = resolve(inputRel);
    const scopeTimeHash = createHash("sha1").update(Buffer.from("SOURCE_AT_SCOPE")).digest("hex");
    const fpsWithInputs = { version: 1, renders: { [rel]: { fp: "FP1" } }, inputs: { [inputRel]: scopeTimeHash } };
    const read = (p: string): Buffer => {
      if (p === fpFile) return Buffer.from(JSON.stringify(fpsWithInputs));
      if (p === join(baselineDir, "fingerprints.json")) return Buffer.from(JSON.stringify(matchApproved));
      if (p === join(baselineDir, rel)) return baselineBytes;
      if (p === inputAbs) return Buffer.from("SOURCE_CHANGED_MID_RUN"); // hash ≠ scopeTimeHash → TOCTOU detected
      throw new Error(`unexpected read ${p}`);
    };
    const { launch } = fakeBrowser();
    const writes: Record<string, Buffer> = {};
    await captureAll(
      oneStory,
      { runId: "R", outRoot: ".vg-test", baselineDir, skipUnchanged: true, fingerprintsFile: fpFile, skipForceSample: 0 },
      deps({ launch, writeFile: (p, d) => void (writes[p] = d), readFile: read }),
    );
    const persisted = JSON.parse(
      writes[join(".vg-test", "runs", "R", "fingerprints.json")]!.toString("utf8"),
    ) as { renders: Record<string, unknown> };
    expect(persisted.renders).toEqual({}); // dropped → /visual-baseline can't record a poisoned fp↔PNG pair
  });

  it("rotating recapture FORCE re-shoots a sample of the skip-eligible set (bounds blind spots)", async () => {
    const fourViewports = parseConfig({
      targets: [
        { type: "storybook", url: "http://localhost:6006", name: "components", stories: ["button--primary"] },
      ],
      viewports: [375, 768, 1280, 1440],
      states: ["default"],
    });
    const rels = [375, 768, 1280, 1440].map((v) => `components/button/primary@${v}.png`);
    const current = { version: 1, renders: Object.fromEntries(rels.map((r) => [r, { fp: "FP1" }])) };
    const approvedAll = { version: 1, renders: Object.fromEntries(rels.map((r) => [r, { fp: "FP1", png: pngSha1 }])) };
    const read = (p: string): Buffer => {
      if (p === fpFile) return Buffer.from(JSON.stringify(current));
      if (p === join(baselineDir, "fingerprints.json")) return Buffer.from(JSON.stringify(approvedAll));
      if (rels.some((r) => p === join(baselineDir, r))) return baselineBytes;
      throw new Error(`unexpected read ${p}`);
    };
    const { launch, calls } = fakeBrowser();
    const writes: Record<string, Buffer> = {};
    // default skipForceSample → ceil(sqrt(4)) = 2 forced, 2 copied forward.
    const result = await captureAll(
      fourViewports,
      { runId: "R", outRoot: ".vg-test", baselineDir, skipUnchanged: true, fingerprintsFile: fpFile },
      deps({ launch, writeFile: (p, d) => void (writes[p] = d), readFile: read }),
    );
    expect(calls.screenshots).toBe(2); // 2 of the 4 skip-eligible were physically re-verified
    const renders = JSON.parse(
      writes[join(".vg-test", "runs", "R", "renders.json")]!.toString("utf8"),
    ) as RendersFile;
    const skipped = Object.values(renders.renders).filter((r) => r.skipped === true).length;
    expect(skipped).toBe(2); // the other 2 copied forward
    expect(result.written.length).toBe(4); // all present (2 shot + 2 copied)
  });
});
