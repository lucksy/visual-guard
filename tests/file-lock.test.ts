import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withFileLock, writeFileAtomic } from "../scripts/lib/studio/file-lock";

describe("withFileLock", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-lock-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("holds the lock dir during fn, returns its value, and releases after", () => {
    const target = join(tmp, "f.json");
    let heldDuringFn = false;
    const ret = withFileLock(target, () => {
      heldDuringFn = existsSync(`${target}.lock`);
      return 42;
    });
    expect(ret).toBe(42);
    expect(heldDuringFn).toBe(true);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("releases the lock even when fn throws", () => {
    const target = join(tmp, "f.json");
    expect(() =>
      withFileLock(target, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("times out when a FRESH (non-stale) lock is held by another holder", () => {
    const target = join(tmp, "f.json");
    mkdirSync(`${target}.lock`); // simulate a live holder
    expect(() =>
      withFileLock(target, () => "never", { timeoutMs: 80, retryMs: 10, staleMs: 60_000 }),
    ).toThrow(/timed out/);
    // the foreign lock is left intact (we never broke a non-stale holder)
    expect(existsSync(`${target}.lock`)).toBe(true);
  });

  it("breaks a STALE lock (orphaned by a crashed holder) and acquires", () => {
    const target = join(tmp, "f.json");
    const lockDir = `${target}.lock`;
    mkdirSync(lockDir);
    const old = (Date.now() - 60_000) / 1000; // age it far past staleMs
    utimesSync(lockDir, old, old);
    let acquired = false;
    withFileLock(target, () => {
      acquired = true;
    }, { staleMs: 1_000, timeoutMs: 2_000, retryMs: 10 });
    expect(acquired).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  it("serializes nested-by-construction sections (the second call waits for the first to release)", () => {
    const target = join(tmp, "f.json");
    const order: string[] = [];
    withFileLock(target, () => {
      order.push("A-in");
      // lock is held; a fresh acquire here would time out — proving exclusivity
      expect(() => withFileLock(target, () => "x", { timeoutMs: 50, retryMs: 10, staleMs: 60_000 })).toThrow(
        /timed out/,
      );
      order.push("A-out");
    });
    // after release, a new acquire succeeds
    withFileLock(target, () => order.push("B"));
    expect(order).toEqual(["A-in", "A-out", "B"]);
  });
});

describe("writeFileAtomic", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-atomic-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the content and leaves NO temp file behind", () => {
    const target = join(tmp, "f.json");
    writeFileAtomic(target, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(readdirSync(tmp).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  it("overwrites an existing file", () => {
    const target = join(tmp, "f.json");
    writeFileSync(target, "old");
    writeFileAtomic(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  it("creates the parent directory if missing", () => {
    const target = join(tmp, "nested", "deep", "f.json");
    writeFileAtomic(target, "x");
    expect(readFileSync(target, "utf8")).toBe("x");
  });
});
