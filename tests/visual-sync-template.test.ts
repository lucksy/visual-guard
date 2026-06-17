import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P2 structure test (mirrors visual-review-template.test.ts). The `/visual-sync` skill ships a
 * dynamic-workflow SCRIPT TEMPLATE; plugins can't bundle a workflow, so the skill launches it via the
 * Workflow tool. We can't run it here (it needs the runtime's injected globals + would spawn real
 * subagents and call the Figma MCP), so this asserts deterministically: (1) it parses as a valid
 * workflow script (top-level await + return), and (2) its contract is intact — the five phases, the
 * code-first ordering, the figma-closed graceful exit, the get_metadata→record-figma enumerate, the
 * fan-out get_screenshot capture, and the engine/CLI references.
 */
const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, "..", "skills", "visual-sync");
const template = readFileSync(join(skillDir, "workflow.template.js"), "utf8");
const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
const command = readFileSync(join(here, "..", "commands", "visual-sync.md"), "utf8");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => unknown;

describe("visual-sync workflow template", () => {
  it("parses as a valid workflow script (TLA + top-level return, runtime-wrapped)", () => {
    const body = template.replace(/^\s*export\s+const\s+meta/m, "const meta");
    expect(() => {
      new AsyncFunction("phase", "agent", "parallel", "pipeline", "log", "workflow", "args", "budget", body);
    }).not.toThrow();
  });

  it("declares a meta block with the six sync phases", () => {
    const match = /export const meta = (\{[\s\S]*?\n\});/.exec(template);
    expect(match).not.toBeNull();
    const meta = new Function(`return (${match![1]})`)() as {
      name: string;
      description: string;
      phases: { title: string }[];
    };
    expect(meta.name).toBe("visual-sync");
    expect(meta.description.length).toBeGreaterThan(0);
    expect(meta.phases.map((p) => p.title)).toEqual([
      "Preflight",
      "Code",
      "Enumerate",
      "Reconcile",
      "Capture",
      "Conformance",
    ]);
  });

  it("syncs code first and references the headless code-sync CLI", () => {
    // The Code phase runs before any Figma work (code-first value).
    expect(template.indexOf('phase("Code")')).toBeLessThan(template.indexOf('phase("Enumerate")'));
    expect(template).toMatch(/scripts\/studio\/sync\.ts/);
  });

  it("gracefully degrades when Figma is unavailable (code synced, figma skipped)", () => {
    expect(template).toMatch(/figmaReady/);
    expect(template).toMatch(/figma:\s*["']skipped["']/);
  });

  it("enumerates via get_metadata + record-figma and fans out get_screenshot capture", () => {
    expect(template).toMatch(/mcp__figma-desktop__get_metadata/);
    expect(template).toMatch(/mcp__figma-desktop__get_screenshot/);
    expect(template).toMatch(/record-figma\.ts enumerate/);
    expect(template).toMatch(/record-figma\.ts match/);
    expect(template).toMatch(/record-figma\.ts record/);
    expect(template).toMatch(/parallel\(/); // bounded fan-out across node batches
    expect(template).toMatch(/BATCH/);
  });

  it("stops early with an actionable message when the engine isn't installed", () => {
    expect(template).toMatch(/engineReady/);
    expect(template).toMatch(/engine-not-installed/);
  });

  it("captures component-set variants, finalizes figma-pending, and prefers the configured file key", () => {
    expect(template).toMatch(/\.variants/); // carries enumerated variants into capture
    expect(template).toMatch(/--variant/); // records each variant child as a distinct lane
    expect(template).toMatch(/record-figma\.ts pending/); // flip uncaptured links to figma-pending
    expect(template).toMatch(/argFileKey \|\|/); // configured fileKey wins over a URL-derived guess (D11)
  });

  it("scores advisory conformance (P5) as the final phase after both sides are populated", () => {
    expect(template).toMatch(/phase\("Conformance"\)/);
    expect(template).toMatch(/studio\.ts conformance/);
    // Conformance runs AFTER the Figma capture (both design + code baselines must exist first).
    expect(template.indexOf('phase("Capture")')).toBeLessThan(template.indexOf('phase("Conformance")'));
  });
});

describe("visual-sync SKILL.md + command", () => {
  it("the skill has frontmatter and launches the bundled template via the Workflow tool", () => {
    expect(/^---\n[\s\S]*?\ndescription:\s*.+/m.test(skill)).toBe(true);
    expect(skill).toMatch(/workflow\.template\.js/);
    expect(skill).toMatch(/Workflow\(/);
    expect(skill).toMatch(/scriptPath/);
    expect(skill).toMatch(/\/workflows/);
    expect(skill).toMatch(/\.claude\/workflows/);
    expect(skill.toLowerCase()).toMatch(/no token/);
  });

  it("the command does the engine + Figma-MCP availability preflight", () => {
    // command frontmatter leads with `description:` (no `name:` line, unlike a skill)
    expect(/^---\n[\s\S]*?description:\s*.+/m.test(command)).toBe(true);
    expect(command).toMatch(/install-deps\.mjs/);
    expect(command).toMatch(/--check/);
    expect(command).toMatch(/mcp__figma-desktop__get_metadata/);
    expect(command).toMatch(/Workflow\(/);
  });
});
