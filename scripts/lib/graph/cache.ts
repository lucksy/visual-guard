import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FileImports, Resolver } from "./resolver";

/**
 * Persistent import-graph cache (Phase 3). Rebuilding the graph from scratch every run re-parses and
 * re-resolves every reachable file (the dominant cost). This caches each file's resolved edges keyed
 * by a CONTENT HASH, so an unchanged file reuses its edges without re-parsing.
 *
 * The cardinal invariant forbids a STALE hit (a file whose edges changed served from cache → a
 * missed dependency → under-capture). Two guards make a stale hit impossible:
 *   1. Per-file CONTENT HASH — an entry is reused only when the file is byte-identical, so its edges
 *      are exactly what the resolver would recompute (the resolver is deterministic given content +
 *      options).
 *   2. A whole-cache KEY = optionsHash (tsconfig paths/baseUrl/moduleResolution) + a TREE fingerprint
 *      (the project's file list). A change to either discards the ENTIRE cache. The tree fingerprint
 *      is essential: an extensionless `import './x'` resolves by what's ON DISK, so ADDING `x.ts`
 *      next to an existing `x.css` shifts the edge WITHOUT changing the importer's content — only a
 *      tree change catches that. (A content modification can't shift any resolution; paths are stable.)
 */

const CACHE_VERSION = 2;

export interface CacheEntry {
  /** sha1 of the file's content when these edges were computed. */
  hash: string;
  /** Resolved in-project edge paths (absolute), as the resolver returned them. */
  resolved: string[];
  /** Whether the file had an unresolved/dynamic import (graph-incomplete). */
  incomplete: boolean;
}

interface GraphCacheFile {
  version: number;
  /** optionsHash + tree fingerprint; a mismatch discards the whole cache. */
  key: string;
  files: Record<string, CacheEntry>;
}

/** sha1 hex of a string (content / options / tree fingerprint). */
export function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Load the cache for `key`, or an empty cache when the file is absent, version-mismatched,
 * key-mismatched (options or tree changed), or corrupt. Never throws — any doubt → empty (full
 * rebuild), the conservative, never-stale choice.
 */
export function loadGraphCache(path: string, key: string): Map<string, CacheEntry> {
  try {
    if (!existsSync(path)) return new Map();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GraphCacheFile>;
    if (
      parsed.version !== CACHE_VERSION ||
      parsed.key !== key ||
      typeof parsed.files !== "object" ||
      parsed.files === null
    ) {
      return new Map();
    }
    const map = new Map<string, CacheEntry>();
    for (const [file, entry] of Object.entries(parsed.files)) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.hash === "string" &&
        Array.isArray(entry.resolved) &&
        typeof entry.incomplete === "boolean"
      ) {
        map.set(file, {
          hash: entry.hash,
          resolved: entry.resolved.filter((r): r is string => typeof r === "string"),
          incomplete: entry.incomplete,
        });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Persist the cache (best-effort — a write failure never fails the run). */
export function saveGraphCache(path: string, key: string, cache: Map<string, CacheEntry>): void {
  try {
    const files: Record<string, CacheEntry> = {};
    for (const [file, entry] of cache) {
      files[file] = entry;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: CACHE_VERSION, key, files }, null, 2)}\n`);
  } catch {
    /* best-effort: a cache write must never break a run */
  }
}

/**
 * Wrap a {@link Resolver} so `extractImports` reuses cached edges for a byte-identical file: read +
 * hash the file, and on a matching cached hash return the cached edges WITHOUT re-parsing/resolving.
 * On a hash mismatch / cache miss / read failure, delegate to the real resolver and update the cache.
 * A cache entry is only ever served when its stored hash equals the file's current content hash, so a
 * stale hit is impossible. `cache` is mutated in place (call {@link saveGraphCache} after the build).
 */
export function withCache(
  resolver: Resolver,
  cache: Map<string, CacheEntry>,
  readFile: (path: string) => string,
): Resolver {
  return {
    tsconfigFound: resolver.tsconfigFound,
    optionsHash: resolver.optionsHash,
    extractImports: (absFile: string): FileImports => {
      let hash: string;
      try {
        hash = sha1(readFile(absFile));
      } catch {
        // Unreadable → can't cache; let the resolver handle it (it returns incomplete on read error).
        return resolver.extractImports(absFile);
      }
      const cached = cache.get(absFile);
      if (cached !== undefined && cached.hash === hash) {
        return { resolved: cached.resolved, unresolvedOrDynamic: cached.incomplete };
      }
      const fresh = resolver.extractImports(absFile);
      cache.set(absFile, { hash, resolved: fresh.resolved, incomplete: fresh.unresolvedOrDynamic });
      return fresh;
    },
  };
}
