import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sha1,
  loadGraphCache,
  saveGraphCache,
  withCache,
  type CacheEntry,
} from "../scripts/lib/graph/cache";
import type { FileImports, Resolver } from "../scripts/lib/graph/resolver";

describe("sha1", () => {
  it("is deterministic and content-sensitive", () => {
    expect(sha1("abc")).toBe(sha1("abc"));
    expect(sha1("abc")).not.toBe(sha1("abd"));
  });
});

describe("loadGraphCache / saveGraphCache", () => {
  let dir = "";
  let path = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vg-cache-"));
    path = join(dir, "graph.json");
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty for a missing cache file", () => {
    expect(loadGraphCache(path, "k").size).toBe(0);
  });

  it("round-trips entries for a matching key", () => {
    const cache = new Map<string, CacheEntry>([
      ["/a.ts", { hash: "h", resolved: ["/b.ts"], incomplete: false }],
    ]);
    saveGraphCache(path, "k", cache);
    expect(loadGraphCache(path, "k").get("/a.ts")).toEqual({
      hash: "h",
      resolved: ["/b.ts"],
      incomplete: false,
    });
  });

  it("discards the WHOLE cache on a key mismatch (options or tree changed)", () => {
    saveGraphCache(path, "k1", new Map([["/a.ts", { hash: "h", resolved: [], incomplete: false }]]));
    expect(loadGraphCache(path, "k2").size).toBe(0);
  });

  it("returns empty on a corrupt cache file", () => {
    writeFileSync(path, "not json{");
    expect(loadGraphCache(path, "k").size).toBe(0);
  });
});

describe("withCache — a stale hit is impossible", () => {
  let calls: string[] = [];
  let fileContent: Record<string, string> = {};
  const read = (p: string): string => {
    const content = fileContent[p];
    if (content === undefined) throw new Error("ENOENT");
    return content;
  };
  const counting = (edgesFor: (text: string) => FileImports): Resolver => ({
    tsconfigFound: true,
    optionsHash: "o",
    extractImports: (abs): FileImports => {
      calls.push(abs);
      return edgesFor(fileContent[abs] ?? "");
    },
  });
  beforeEach(() => {
    calls = [];
    fileContent = {};
  });

  it("reuses edges for a byte-identical file (resolver parses ONCE)", () => {
    fileContent["/a.ts"] = "import './b'";
    const cache = new Map<string, CacheEntry>();
    const r = withCache(
      counting(() => ({ resolved: ["/b.ts"], unresolvedOrDynamic: false })),
      cache,
      read,
    );
    expect(r.extractImports("/a.ts").resolved).toEqual(["/b.ts"]);
    expect(r.extractImports("/a.ts").resolved).toEqual(["/b.ts"]); // 2nd call → cache hit
    expect(calls).toEqual(["/a.ts"]); // the resolver was invoked only once
  });

  it("re-parses when the content changes — never serves stale edges", () => {
    fileContent["/a.ts"] = "v1";
    const cache = new Map<string, CacheEntry>();
    const r = withCache(
      counting((text) => ({ resolved: text === "v1" ? ["/b.ts"] : ["/c.ts"], unresolvedOrDynamic: false })),
      cache,
      read,
    );
    expect(r.extractImports("/a.ts").resolved).toEqual(["/b.ts"]);
    fileContent["/a.ts"] = "v2"; // content changed (hash differs)
    expect(r.extractImports("/a.ts").resolved).toEqual(["/c.ts"]); // re-parsed → fresh edges
    expect(calls).toEqual(["/a.ts", "/a.ts"]);
  });

  it("delegates to the resolver on a read failure (file gone → its incompleteness stands)", () => {
    const cache = new Map<string, CacheEntry>();
    const r = withCache(
      counting(() => ({ resolved: [], unresolvedOrDynamic: true })),
      cache,
      read,
    );
    expect(r.extractImports("/missing.ts").unresolvedOrDynamic).toBe(true);
    expect(calls).toEqual(["/missing.ts"]);
  });
});
