import { relative } from "node:path";
import type { Resolver } from "./resolver";

/**
 * The static import graph for change-scoped capture (Phase 1). Built by walking the transitive
 * import closure of each STORY FILE (a graph root, from the Storybook index's `importPath`) via the
 * TS-compiler-API {@link Resolver}, then inverting to "changed file → the story files that reach it".
 *
 * Everything is keyed by LOWERCASED project-relative posix paths, matching the engine's
 * case-insensitive classification (scope.ts) so a casing variant on a case-insensitive filesystem
 * can't make a lookup miss (which, under a complete graph, would be a silent under-capture).
 *
 * `storyIncomplete[sf] === true` when ANY file in sf's closure had an unresolved/dynamic import
 * (CS-D2): that story's dependency set isn't trustworthy, so it is captured in EVERY scoped run.
 * `built === false` means the build failed or exceeded budget → the caller must fall back to a full
 * sweep (the graph is an accelerator, never the safety net).
 */
export interface ImportGraph {
  built: boolean;
  /** lowercased changed-file rel-posix → set of lowercased story-file rel-posix reaching it. */
  fileToStoryFiles: Map<string, Set<string>>;
  /** lowercased story-file rel-posix → whether any node in its closure is import-incomplete. */
  storyIncomplete: Map<string, boolean>;
}

/** A graph is "complete" iff it built AND no story's closure contains an unresolved/dynamic import. */
export function graphComplete(graph: ImportGraph): boolean {
  if (!graph.built) return false;
  for (const incomplete of graph.storyIncomplete.values()) {
    if (incomplete) return false;
  }
  return true;
}

function relPosixLower(projectRoot: string, abs: string): string {
  return relative(projectRoot, abs).split("\\").join("/").toLowerCase();
}

export interface BuildOptions {
  /** Cap on total distinct files visited; exceeding it marks the graph un-built (→ full-sweep fallback). */
  maxFiles?: number;
}

/**
 * Build the import graph from absolute story-file `roots`. `resolver.extractImports` supplies each
 * file's resolved in-project edges + its incompleteness flag; node_modules is already excluded by
 * the resolver. Per-file edges are memoized so a shared util is parsed once across roots.
 */
export function buildImportGraph(
  projectRoot: string,
  roots: string[],
  resolver: Resolver,
  options: BuildOptions = {},
): ImportGraph {
  const maxFiles = options.maxFiles ?? 50000;
  const fileToStoryFiles = new Map<string, Set<string>>();
  const storyIncomplete = new Map<string, boolean>();
  const edgeCache = new Map<string, { resolved: string[]; unresolvedOrDynamic: boolean }>();
  const edgesOf = (abs: string): { resolved: string[]; unresolvedOrDynamic: boolean } => {
    let edges = edgeCache.get(abs);
    if (edges === undefined) {
      edges = resolver.extractImports(abs);
      edgeCache.set(abs, edges);
    }
    return edges;
  };

  let visited = 0;
  for (const rootAbs of roots) {
    const rootKey = relPosixLower(projectRoot, rootAbs);
    const seen = new Set<string>(); // absolute paths in this root's closure
    const stack: string[] = [rootAbs];
    let incomplete = false;
    while (stack.length > 0) {
      const file = stack.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      if (++visited > maxFiles) {
        // Over budget — abandon the whole graph so the caller falls back to a full sweep.
        return { built: false, fileToStoryFiles: new Map(), storyIncomplete: new Map() };
      }
      const { resolved, unresolvedOrDynamic } = edgesOf(file);
      if (unresolvedOrDynamic) incomplete = true;
      for (const dep of resolved) {
        if (!seen.has(dep)) stack.push(dep);
      }
    }
    // Last write wins if the same story file is a root twice (it won't be — roots are de-duped by
    // the caller), and incompleteness is OR-ed across a closure by construction above.
    storyIncomplete.set(rootKey, storyIncomplete.get(rootKey) === true || incomplete);
    for (const abs of seen) {
      const fileKey = relPosixLower(projectRoot, abs);
      let set = fileToStoryFiles.get(fileKey);
      if (set === undefined) {
        set = new Set<string>();
        fileToStoryFiles.set(fileKey, set);
      }
      set.add(rootKey);
    }
  }

  return { built: true, fileToStoryFiles, storyIncomplete };
}
