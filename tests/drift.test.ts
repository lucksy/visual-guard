import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../scripts/lib/studio/db";
import { rollupLifecycle, setLifecycle, upsertComponent } from "../scripts/lib/studio/store";
import { studioDbPath } from "../scripts/lib/studio/keys";
import { formatDriftReport, parseDriftArgs, runDrift } from "../scripts/drift";

const EMPTY = {
  delta: { newFigma: [], newCode: [], removedFigma: [], removedCode: [] },
  removed: [],
  stale: [],
  renamed: 0,
  figmaOnly: 0,
  codeOnly: 0,
  matched: 0,
};

/** No emoji / non-ASCII anywhere in the output (the repo's plain-ASCII output rule). */
const isAscii = (s: string): boolean => /^[\x20-\x7E\n]*$/.test(s);

describe("parseDriftArgs", () => {
  it("defaults cwd/out and accepts --cwd / --out / (ignored) --config", () => {
    expect(parseDriftArgs([])).toEqual({ cwd: process.cwd(), outRoot: ".visual-guard" });
    expect(parseDriftArgs(["--cwd", "/tmp/x", "--out", "out", "--config", "c.json"])).toEqual({
      cwd: "/tmp/x",
      outRoot: "out",
    });
  });
  it("throws on an unknown flag", () => {
    expect(() => parseDriftArgs(["--nope"])).toThrow(/unknown argument/);
  });
});

describe("formatDriftReport (emoji-free)", () => {
  it("renders a plain-ASCII advisory summary, with the clean-state line when there is no drift", () => {
    const text = formatDriftReport({ ...EMPTY, matched: 2, figmaOnly: 1 });
    expect(isAscii(text)).toBe(true);
    expect(text).toContain("advisory");
    expect(text).toMatch(/no rename\/removal/);
  });
  it("lists removed / stale / new components when present", () => {
    const text = formatDriftReport({
      ...EMPTY,
      removed: ["a/x"],
      stale: ["b/y"],
      delta: { newFigma: ["c/z"], newCode: [], removedFigma: [], removedCode: [] },
    });
    expect(isAscii(text)).toBe(true);
    expect(text).toContain("removed: a/x");
    expect(text).toContain("stale: b/y");
    expect(text).toContain("new figma: c/z");
  });
});

describe("runDrift (orchestration; advisory, never throws)", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-drift-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("reports unavailable when there is no index, still writing last-drift.json", () => {
    const result = runDrift({ cwd: tmp, outRoot: ".visual-guard" });
    expect(result.available).toBe(false);
    expect(result.text).toContain("no studio index");
    expect(isAscii(result.text)).toBe(true);
    const out = JSON.parse(readFileSync(join(tmp, ".visual-guard", "last-drift.json"), "utf8"));
    expect(out.available).toBe(false);
  });

  it("computes the report from a seeded index and writes last-drift.json (emoji-free)", () => {
    const db = openDb(join(tmp, studioDbPath(".visual-guard")));
    const m = upsertComponent(db, { key: "b/btn", name: "Button", figmaNodeId: "1:1", codeTarget: "Button" });
    rollupLifecycle(db, m);
    const removed = upsertComponent(db, { key: "b/old", name: "Old", codeTarget: "Old" });
    setLifecycle(db, removed, "removed");
    db.close();

    const result = runDrift({ cwd: tmp, outRoot: ".visual-guard" });
    expect(result.available).toBe(true);
    expect(result.report?.removed).toEqual(["b/old"]);
    expect(result.report?.matched).toBe(1);
    expect(isAscii(result.text)).toBe(true);
    const out = JSON.parse(readFileSync(join(tmp, ".visual-guard", "last-drift.json"), "utf8"));
    expect(out.available).toBe(true);
    expect(out.removed).toEqual(["b/old"]);
  });
});
