import { describe, it, expect } from "vitest";
import { buildImportGraph, graphComplete } from "../scripts/lib/graph/import-graph";
import type { FileImports, Resolver } from "../scripts/lib/graph/resolver";

/** A resolver backed by a fixed edge map (absolute paths) — no fs, fully deterministic. */
function fakeResolver(edges: Record<string, FileImports>): Resolver {
  return {
    tsconfigFound: true,
    extractImports: (abs): FileImports => edges[abs] ?? { resolved: [], unresolvedOrDynamic: false },
  };
}

const ROOT = "/p";

describe("buildImportGraph — closure inversion + cross-import", () => {
  // A.stories → A → {shared, A.css};  B.stories → B → shared.  shared & A reach BOTH stories.
  const edges: Record<string, FileImports> = {
    "/p/A.stories.tsx": { resolved: ["/p/A.tsx"], unresolvedOrDynamic: false },
    "/p/A.tsx": { resolved: ["/p/shared.ts", "/p/A.css"], unresolvedOrDynamic: false },
    "/p/A.css": { resolved: [], unresolvedOrDynamic: false },
    "/p/shared.ts": { resolved: [], unresolvedOrDynamic: false },
    "/p/B.stories.tsx": { resolved: ["/p/A.tsx"], unresolvedOrDynamic: false }, // B's story imports A
  };
  const graph = buildImportGraph(ROOT, ["/p/A.stories.tsx", "/p/B.stories.tsx"], fakeResolver(edges));

  it("builds and is complete when no edge is unresolved/dynamic", () => {
    expect(graph.built).toBe(true);
    expect(graphComplete(graph)).toBe(true);
  });

  it("inverts so a shared dependency reaches every story that imports it (the cross-import gap)", () => {
    expect([...(graph.fileToStoryFiles.get("shared.ts") ?? [])].sort()).toEqual([
      "a.stories.tsx",
      "b.stories.tsx",
    ]);
    // A.tsx is imported by both story files too.
    expect([...(graph.fileToStoryFiles.get("a.tsx") ?? [])].sort()).toEqual([
      "a.stories.tsx",
      "b.stories.tsx",
    ]);
    // A.css reaches both (both stories import A which imports A.css).
    expect([...(graph.fileToStoryFiles.get("a.css") ?? [])].sort()).toEqual([
      "a.stories.tsx",
      "b.stories.tsx",
    ]);
  });

  it("maps a story file to itself (editing a story file scopes its own stories)", () => {
    expect(graph.fileToStoryFiles.get("a.stories.tsx")).toEqual(new Set(["a.stories.tsx"]));
  });

  it("keys are lowercased rel-posix (case-insensitive lookup)", () => {
    expect(graph.fileToStoryFiles.has("shared.ts")).toBe(true);
    expect(graph.fileToStoryFiles.has("Shared.ts")).toBe(false); // only the lowercased key exists
  });
});

describe("buildImportGraph — incompleteness + budget (conservative)", () => {
  it("marks a story incomplete when any file in its closure is unresolved/dynamic", () => {
    const edges: Record<string, FileImports> = {
      "/p/A.stories.tsx": { resolved: ["/p/A.tsx"], unresolvedOrDynamic: false },
      "/p/A.tsx": { resolved: ["/p/dyn.ts"], unresolvedOrDynamic: true }, // a computed dynamic import
      "/p/dyn.ts": { resolved: [], unresolvedOrDynamic: false },
    };
    const graph = buildImportGraph(ROOT, ["/p/A.stories.tsx"], fakeResolver(edges));
    expect(graph.storyIncomplete.get("a.stories.tsx")).toBe(true);
    expect(graphComplete(graph)).toBe(false);
  });

  it("abandons the graph (built:false) when the file budget is exceeded", () => {
    const edges: Record<string, FileImports> = {
      "/p/A.stories.tsx": { resolved: ["/p/A.tsx"], unresolvedOrDynamic: false },
      "/p/A.tsx": { resolved: ["/p/shared.ts"], unresolvedOrDynamic: false },
      "/p/shared.ts": { resolved: [], unresolvedOrDynamic: false },
    };
    const graph = buildImportGraph(ROOT, ["/p/A.stories.tsx"], fakeResolver(edges), { maxFiles: 1 });
    expect(graph.built).toBe(false);
    expect(graphComplete(graph)).toBe(false);
  });
});
