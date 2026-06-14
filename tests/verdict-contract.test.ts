import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERDICT_KEYS, VERDICT_REPORT_KEYS } from "../scripts/report";

/**
 * T-14 contract test: the `visual-reviewer` subagent's structured output is an **interface**,
 * not prose. This asserts the JSON it documents matches the `VerdictReport` contract
 * field-for-field (so the agent's output can't silently drift from what the command/workflow
 * routes back into `ManifestImage.verdict`), and that the agent stays read-only. Prompt *quality*
 * (does it classify well?) is an eval/spot-check, not a unit assertion, per the SPEC.
 */
const here = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(here, "..", "agents", "visual-reviewer.md"), "utf8");

/** Parse the first ```json fenced block in a markdown doc. */
function firstJsonBlock(markdown: string): unknown {
  const m = /```json\s*([\s\S]*?)```/.exec(markdown);
  if (!m) throw new Error("no ```json block found in the agent doc");
  return JSON.parse(m[1]!);
}

/** Read the top YAML frontmatter as a flat string map (single-line values). */
function frontmatter(markdown: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!m) throw new Error("no frontmatter in the agent doc");
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0 && !line.startsWith(" ")) {
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

/** The reviewer documents an ARRAY of verdicts (one per changed image); return the first. */
function firstVerdict(): Record<string, unknown> {
  const parsed = firstJsonBlock(md);
  expect(Array.isArray(parsed)).toBe(true); // one self-addressing object per changed image
  return (parsed as unknown[])[0] as Record<string, unknown>;
}

describe("visual-reviewer agent contract", () => {
  it("documents exactly the VerdictReport JSON keys (field-for-field)", () => {
    expect(Object.keys(firstVerdict()).sort()).toEqual([...VERDICT_REPORT_KEYS].sort());
  });

  it("VERDICT_KEYS is the 8-field subset of VERDICT_REPORT_KEYS (the identifiers are the extra 3)", () => {
    expect([...VERDICT_KEYS].sort()).toEqual(
      [...VERDICT_REPORT_KEYS].filter((k) => !["target", "state", "viewport"].includes(k)).sort(),
    );
    expect(VERDICT_KEYS).toHaveLength(8);
    expect(VERDICT_REPORT_KEYS).toHaveLength(11);
  });

  it("uses the locked classification + severity enums in the example", () => {
    const v = firstVerdict() as { classification: string; severity: string };
    expect(["intentional", "bug", "design-system-violation"]).toContain(v.classification);
    expect(["low", "medium", "high"]).toContain(v.severity);
  });

  it("echoes target/state/viewport so the verdict is self-addressing", () => {
    const v = firstVerdict();
    expect(v).toHaveProperty("target");
    expect(v).toHaveProperty("state");
    expect(v).toHaveProperty("viewport");
  });

  it("is read-only, sonnet/high/15, and declares the playwright MCP probe tools (SPEC contract)", () => {
    const fm = frontmatter(md);
    expect(fm.name).toBe("visual-reviewer");
    expect(fm.model).toBe("sonnet");
    // The deep-probe budget is an explicit T-14 acceptance bullet — pin it so a regression to a
    // cheaper effort / smaller turn cap fails here, not silently.
    expect(fm.effort).toBe("high");
    expect(fm.maxTurns).toBe("15");
    // Allowlist must not grant Write/Edit; denylist must explicitly forbid them.
    expect(fm.tools).not.toMatch(/\bWrite\b/);
    expect(fm.tools).not.toMatch(/\bEdit\b/);
    expect(fm.disallowedTools).toMatch(/\bWrite\b/);
    expect(fm.disallowedTools).toMatch(/\bEdit\b/);
    // Deep-probe capability: the Playwright MCP nav + screenshot tools are granted.
    expect(fm.tools).toMatch(/mcp__playwright__playwright_navigate/);
    expect(fm.tools).toMatch(/mcp__playwright__playwright_screenshot/);
  });
});
