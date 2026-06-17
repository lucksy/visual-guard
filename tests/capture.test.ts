import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseConfig } from "../scripts/lib/config";
import type { FetchLike, RenderTarget } from "../scripts/lib/targets";
import {
  captureAll,
  filterTargets,
  makeRunId,
  parseArgs,
  probeOrigins,
  readPngDimensions,
  renderRelPath,
  resolveConcurrency,
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
    expect(parseArgs([])).toEqual({ config: "config/visual.config.json" });
  });

  it("reads --config, --target, and --run", () => {
    expect(parseArgs(["--target", "Button", "--config", "c.json", "--run", "R1"])).toEqual({
      config: "c.json",
      target: "Button",
      runId: "R1",
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
