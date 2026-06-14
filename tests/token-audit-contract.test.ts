import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DriftFinding } from "../scripts/lib/tokens";
import { VERDICT_REPORT_KEYS } from "../scripts/report";

/**
 * T-17 contract test: the `token-auditor` consumes the engine's `DriftFinding[]` and emits the
 * SAME verdict contract as `visual-reviewer`. This pins both sides as interfaces: the input
 * `DriftFinding` keys are held stable by a compile-time exhaustiveness guard, and the output the
 * agent documents must match `VerdictReport` field-for-field. Prompt quality is an eval/spot-check.
 */

// Compile-time guard: this object MUST list exactly DriftFinding's keys — adding/removing a field
// on DriftFinding breaks `tsc` here, so the auditor's documented input contract can't drift.
const DRIFT_FINDING_SHAPE = {
  file: true,
  line: true,
  cssProperty: true,
  literal: true,
  canonicalValue: true,
  type: true,
  suggestedToken: true,
  alternatives: true,
  confidence: true,
  reason: true,
} satisfies Record<keyof DriftFinding, true>;
const DRIFT_FINDING_KEYS = Object.keys(DRIFT_FINDING_SHAPE).sort();

const here = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(here, "..", "agents", "token-auditor.md"), "utf8");

function firstJsonBlock(markdown: string): unknown {
  const m = /```json\s*([\s\S]*?)```/.exec(markdown);
  if (!m) throw new Error("no ```json block found in the agent doc");
  return JSON.parse(m[1]!);
}

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

/** The auditor documents an array of verdicts; this returns the first element. */
function firstVerdict(): Record<string, unknown> {
  const parsed = firstJsonBlock(md);
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  return obj as Record<string, unknown>;
}

describe("token-auditor agent contract", () => {
  it("keeps the DriftFinding input keys stable", () => {
    expect(DRIFT_FINDING_KEYS).toEqual([
      "alternatives",
      "canonicalValue",
      "confidence",
      "cssProperty",
      "file",
      "line",
      "literal",
      "reason",
      "suggestedToken",
      "type",
    ]);
    // The doc must reference the finding fields it consumes (so the prompt stays in sync).
    for (const key of ["literal", "suggestedToken", "confidence", "alternatives"]) {
      expect(md).toContain(key);
    }
  });

  it("emits the VerdictReport contract field-for-field (same shape as visual-reviewer)", () => {
    expect(Object.keys(firstVerdict()).sort()).toEqual([...VERDICT_REPORT_KEYS].sort());
  });

  it("marks token drift as a design-system violation that spans all states/viewports", () => {
    const v = firstVerdict();
    expect(v.classification).toBe("design-system-violation");
    expect(v.state).toBeNull(); // drift is source-level, not tied to one rendered image
    expect(v.viewport).toBeNull();
  });

  it("documents the T-17 cause/fix templates + severity enum in the example", () => {
    const v = firstVerdict() as Record<string, string>;
    // cause: "hardcoded <literal> replaces <suggestedToken>"
    expect(v.cause).toMatch(/^hardcoded .+ replaces .+$/);
    // fix: "replace <literal> with var(<token>)"
    expect(v.fix).toMatch(/^replace .+ with var\(.+\)$/);
    expect(["low", "medium", "high"]).toContain(v.severity);
  });

  it("is lightweight, read-only, sonnet (no Write/Edit, no browser)", () => {
    const fm = frontmatter(md);
    expect(fm.name).toBe("token-auditor");
    expect(fm.model).toBe("sonnet");
    // "lightweight" relative to the reviewer (effort high / 15 turns) — pin the cheaper budget.
    expect(fm.effort).toBe("medium");
    expect(fm.maxTurns).toBe("10");
    expect(fm.tools).not.toMatch(/\bWrite\b/);
    expect(fm.tools).not.toMatch(/\bEdit\b/);
    expect(fm.tools).not.toMatch(/mcp__playwright/); // source-level audit needs no rendering
    expect(fm.disallowedTools).toMatch(/\bWrite\b/);
    expect(fm.disallowedTools).toMatch(/\bEdit\b/);
  });
});
