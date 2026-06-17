import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeCodeFingerprint,
  figmaNodeUnchanged,
  matchesAnyGlob,
  planSync,
  shouldResyncCode,
} from "../scripts/lib/studio/fingerprint";
import { collectUiFiles, targetSignature } from "../scripts/studio/sync";
import { parseConfig } from "../scripts/lib/config";

describe("matchesAnyGlob (mirrors the hook's matcher)", () => {
  const globs = ["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss}"];
  it("matches UI source at any depth, rejects non-UI files", () => {
    expect(matchesAnyGlob("src/Button.tsx", globs)).toBe(true);
    expect(matchesAnyGlob("a/b/c/styles.scss", globs)).toBe(true);
    expect(matchesAnyGlob("README.md", globs)).toBe(false);
    expect(matchesAnyGlob("src/util.ts", globs)).toBe(false);
  });
});

describe("computeCodeFingerprint", () => {
  const files = [
    { path: "src/Button.tsx", mtimeMs: 1000 },
    { path: "src/Card.tsx", mtimeMs: 2000 },
  ];
  it("is order-independent over the file list", () => {
    const a = computeCodeFingerprint({ targetSignature: "sig", files });
    const b = computeCodeFingerprint({ targetSignature: "sig", files: [...files].reverse() });
    expect(a).toBe(b);
  });
  it("changes when a file's mtime, the file set, or the target signature changes", () => {
    const base = computeCodeFingerprint({ targetSignature: "sig", files });
    const touched = computeCodeFingerprint({
      targetSignature: "sig",
      files: [{ path: "src/Button.tsx", mtimeMs: 1001 }, files[1]!],
    });
    const added = computeCodeFingerprint({ targetSignature: "sig", files: [...files, { path: "x.tsx", mtimeMs: 3 }] });
    const reconfig = computeCodeFingerprint({ targetSignature: "OTHER", files });
    expect(new Set([base, touched, added, reconfig]).size).toBe(4); // all distinct
  });
});

describe("shouldResyncCode", () => {
  it("re-syncs when no prior, when changed, or when forced; skips when identical", () => {
    expect(shouldResyncCode(null, "abc")).toBe(true);
    expect(shouldResyncCode("abc", "def")).toBe(true);
    expect(shouldResyncCode("abc", "abc")).toBe(false);
    expect(shouldResyncCode("abc", "abc", true)).toBe(true); // --force
  });
});

describe("planSync — the incremental skip/stamp decision (full vs --target)", () => {
  it("FULL sync: skips only when the fingerprint is unchanged (unless --force); always stamps", () => {
    expect(planSync(undefined, "abc", "abc")).toEqual({ skip: true, stamp: true }); // unchanged → skip
    expect(planSync(undefined, "abc", "def")).toEqual({ skip: false, stamp: true }); // changed → run
    expect(planSync(undefined, null, "abc")).toEqual({ skip: false, stamp: true }); // first run
    expect(planSync(undefined, "abc", "abc", true)).toEqual({ skip: false, stamp: true }); // --force
  });
  it("--target subset: never skips on the fingerprint AND never stamps whole-project freshness", () => {
    // Even with an identical fingerprint, a targeted run must proceed and must NOT stamp (or a later
    // full sync would wrongly skip the components this subset never rendered).
    expect(planSync("Button", "abc", "abc")).toEqual({ skip: false, stamp: false });
    expect(planSync("Button", "abc", "def")).toEqual({ skip: false, stamp: false });
  });
});

describe("figmaNodeUnchanged", () => {
  it("only skips when both lastModified values are present and equal", () => {
    expect(figmaNodeUnchanged("2026-06-01", "2026-06-01")).toBe(true);
    expect(figmaNodeUnchanged("2026-06-01", "2026-06-02")).toBe(false);
    expect(figmaNodeUnchanged(undefined, "2026-06-01")).toBe(false);
    expect(figmaNodeUnchanged("2026-06-01", undefined)).toBe(false);
    expect(figmaNodeUnchanged(null, null)).toBe(false);
  });
});

describe("collectUiFiles — the walk feeding the fingerprint", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-fp-"));
    const put = (rel: string): void => {
      const abs = join(tmp, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, "x");
    };
    put("src/Button.tsx");
    put("src/button.css");
    put("src/util.ts"); // not UI
    put("README.md"); // not UI
    put("node_modules/pkg/index.tsx"); // skipped dir
    put(".visual-guard/cache/blobs/a.tsx"); // skipped dir
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns only uiGlob-matching files (posix paths), skipping node_modules/.visual-guard", () => {
    const config = parseConfig({ targets: [{ type: "storybook", url: "http://x" }] });
    const files = collectUiFiles(tmp, config.uiGlobs).map((f) => f.path).sort();
    expect(files).toEqual(["src/Button.tsx", "src/button.css"]);
  });

  it("targetSignature is stable and reflects target/viewport/state config", () => {
    const a = parseConfig({ targets: [{ type: "storybook", url: "http://x" }] });
    const b = parseConfig({ targets: [{ type: "storybook", url: "http://y" }] });
    expect(targetSignature(a)).toBe(targetSignature(a));
    expect(targetSignature(a)).not.toBe(targetSignature(b));
  });
});
