import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isServableImagePath, resolveServableImage } from "../scripts/lib/studio/images";

describe("isServableImagePath — lexical guard (the mandatory ..-escape test)", () => {
  it("accepts paths under the two image roots", () => {
    expect(isServableImagePath(".visual-baselines/inst/Button/default@1280.png")).toBe(true);
    expect(isServableImagePath(".visual-baselines/.figma/F/1-2/default@0.png")).toBe(true);
    expect(isServableImagePath(".visual-guard/cache/blobs/abc.png")).toBe(true);
  });

  it("refuses traversal, absolute paths, other roots, backslashes, NUL, and empties", () => {
    // The headline path-traversal cases:
    expect(isServableImagePath("../etc/passwd")).toBe(false);
    expect(isServableImagePath(".visual-baselines/../../etc/passwd")).toBe(false);
    expect(isServableImagePath(".visual-guard/../.ssh/id_rsa")).toBe(false);
    // Absolute (POSIX + Windows drive):
    expect(isServableImagePath("/etc/passwd")).toBe(false);
    expect(isServableImagePath("C:\\Windows\\system32")).toBe(false);
    // Outside the allowed roots entirely:
    expect(isServableImagePath("src/secret.png")).toBe(false);
    expect(isServableImagePath("node_modules/x.png")).toBe(false);
    // Malformed:
    expect(isServableImagePath("a\\b.png")).toBe(false); // backslash
    expect(isServableImagePath(".visual-baselines/a\0.png")).toBe(false); // NUL
    expect(isServableImagePath("")).toBe(false);
    // @ts-expect-error — defends against a non-string image_path from a malformed DB row
    expect(isServableImagePath(null)).toBe(false);
  });

  it("refuses a path that only LOOKS like it starts with a root (prefix-confusion)", () => {
    // ".visual-baselines-evil/" must not pass just because it shares the prefix.
    expect(isServableImagePath(".visual-baselines-evil/x.png")).toBe(false);
    expect(isServableImagePath(".visual-guardian/x.png")).toBe(false);
  });
});

describe("resolveServableImage — realpath confinement over a real tree", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vg-img-"));
    mkdirSync(join(root, ".visual-baselines", ".figma", "F", "1-2"), { recursive: true });
    mkdirSync(join(root, ".visual-guard", "cache", "blobs"), { recursive: true });
    writeFileSync(join(root, ".visual-baselines", ".figma", "F", "1-2", "default@0.png"), "PNG");
    writeFileSync(join(root, ".visual-guard", "cache", "blobs", "abc.png"), "PNG");
    // A secret OUTSIDE both roots, used by the symlink-escape test.
    writeFileSync(join(root, "secret.txt"), "TOP SECRET");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("resolves a real file under each root", () => {
    expect(resolveServableImage(root, ".visual-baselines/.figma/F/1-2/default@0.png")).not.toBeNull();
    expect(resolveServableImage(root, ".visual-guard/cache/blobs/abc.png")).not.toBeNull();
  });

  it("returns null for a missing file and for a lexical escape", () => {
    expect(resolveServableImage(root, ".visual-baselines/.figma/F/1-2/nope.png")).toBeNull();
    expect(resolveServableImage(root, "../secret.txt")).toBeNull();
    expect(resolveServableImage(root, ".visual-baselines/../secret.txt")).toBeNull();
  });

  it("REFUSES a symlink that is lexically inside a root but points outside it (realpath)", () => {
    // Lexically under .visual-baselines/, but the real target is the out-of-tree secret.
    const linkPath = join(root, ".visual-baselines", "escape.png");
    symlinkSync(join(root, "secret.txt"), linkPath);
    // Lexical guard alone would pass (".visual-baselines/escape.png"); realpath must reject it.
    expect(isServableImagePath(".visual-baselines/escape.png")).toBe(true);
    expect(resolveServableImage(root, ".visual-baselines/escape.png")).toBeNull();
  });
});
