import { describe, it, expect } from "vitest";
import {
  blobPath,
  blobsDir,
  codeComponentKey,
  figmaBaselineDir,
  figmaComponentKey,
  figmaImagePath,
  figmaMetaPath,
  parseCodeBaselineKey,
  sanitizeNodeId,
  studioDbPath,
} from "../scripts/lib/studio/keys";

describe("parseCodeBaselineKey", () => {
  it("parses the engine's <instance>/<name>/<state>@<viewport>.png scheme", () => {
    expect(parseCodeBaselineKey("localhost-6006/Button/default@1280.png")).toEqual({
      instance: "localhost-6006",
      name: "Button",
      state: "default",
      viewport: 1280,
    });
  });

  it("returns null for keys that aren't a 3-segment code render", () => {
    expect(parseCodeBaselineKey("Button/default@1280.png")).toBeNull(); // 2 segments
    expect(parseCodeBaselineKey("a/b/c/d@1.png")).toBeNull(); // 4 segments
    expect(parseCodeBaselineKey(".figma/KEY/1-23/default@0.png")).toBeNull(); // figma subtree
    expect(parseCodeBaselineKey("i/n/state.png")).toBeNull(); // no @viewport
    expect(parseCodeBaselineKey("i/n/state@x.png")).toBeNull(); // non-numeric viewport
    expect(parseCodeBaselineKey("i/n/state@0.png")).toBeNull(); // viewport must be positive
    expect(parseCodeBaselineKey("i//state@1.png")).toBeNull(); // empty name segment
  });
});

describe("component key derivation", () => {
  it("derives a path-sanitized code component key", () => {
    expect(codeComponentKey("localhost-6006", "Button")).toBe("localhost-6006/Button");
    // untrusted segments are sanitized so the key can't carry separators/traversal
    const key = codeComponentKey("a/b", "../evil");
    expect(key.split("/")).toHaveLength(2); // exactly instance/name — no injected separators
    expect(key).not.toContain(".."); // no parent-dir traversal survives
  });

  it("namespaces figma component keys per file, keeping the API node id verbatim", () => {
    expect(figmaComponentKey("AbC123", "1:23")).toBe("figma/AbC123/1:23");
  });
});

describe("on-disk layout helpers (SPEC §7)", () => {
  it("locates the gitignored DB and blob cache under the out root", () => {
    expect(studioDbPath()).toBe(".visual-guard/studio.db");
    expect(studioDbPath(".vg")).toBe(".vg/studio.db");
    expect(blobsDir()).toBe(".visual-guard/cache/blobs");
    expect(blobPath("abc123")).toBe(".visual-guard/cache/blobs/abc123.png");
  });

  it("locates committed figma baselines + meta under the baseline dir", () => {
    expect(figmaBaselineDir(".visual-baselines")).toBe(".visual-baselines/.figma");
    expect(figmaMetaPath(".visual-baselines")).toBe(".visual-baselines/figma_meta.json");
  });

  it("sanitizes a node id into a cross-platform path segment (`:` → `-`)", () => {
    expect(sanitizeNodeId("1:23")).toBe("1-23");
  });

  it("builds a path-confined, Windows-safe figma image path", () => {
    expect(figmaImagePath(".visual-baselines", "AbC123", "1:23", "size=lg", 2)).toBe(
      ".visual-baselines/.figma/AbC123/1-23/size-lg@2.png",
    );
    // default variant + viewport
    expect(figmaImagePath(".visual-baselines", "AbC123", "1:23")).toBe(
      ".visual-baselines/.figma/AbC123/1-23/default@0.png",
    );
  });
});
