import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERDICT_REPORT_KEYS } from "../scripts/report";

/**
 * T-19 structure test. The `/visual-review` skill ships a dynamic-workflow SCRIPT TEMPLATE
 * (plugins can't bundle workflows, so the skill launches this template via the Workflow tool).
 * We can't run it here — it needs the Workflow runtime's injected globals (phase/agent/parallel/
 * pipeline) and would spawn real subagents. So this asserts, deterministically:
 *   1. the template parses as a valid workflow script (top-level await + return, which is NOT raw
 *      ESM — the runtime wraps the body in an async function, so we validate it the same way), and
 *   2. its structure is intact: the 3 phases, the fan-out, the adversarial-verify majority gate,
 *      both subagents, and a single synthesis — i.e. the contract can't silently degrade.
 */
const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, "..", "skills", "visual-review");
const template = readFileSync(join(skillDir, "workflow.template.js"), "utf8");
const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => unknown;

/** Extract the balanced `{...}` object literal that follows `const <name> = ` and eval it. */
function objectLiteralAfter(src: string, name: string): Record<string, unknown> {
  const decl = src.indexOf(`const ${name}`);
  if (decl === -1) throw new Error(`no const ${name}`);
  const start = src.indexOf("{", decl);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      return new Function(`return (${src.slice(start, i + 1)})`)() as Record<string, unknown>;
    }
  }
  throw new Error(`unbalanced literal for ${name}`);
}

describe("visual-review workflow template", () => {
  it("parses as a valid workflow script (TLA + top-level return, runtime-wrapped)", () => {
    // `export const meta` is module-level; the rest is an async-function body. Strip the export
    // and compile the body — a syntax error throws here, valid script does not (never executed).
    const body = template.replace(/^\s*export\s+const\s+meta/m, "const meta");
    expect(() => {
      new AsyncFunction(
        "phase",
        "agent",
        "parallel",
        "pipeline",
        "log",
        "workflow",
        "args",
        "budget",
        body,
      );
    }).not.toThrow();
  });

  it("declares a meta block with the three review phases", () => {
    const match = /export const meta = (\{[\s\S]*?\n\});/.exec(template);
    expect(match).not.toBeNull();
    // meta is a pure literal — eval it synchronously (Function, not AsyncFunction).
    const meta = new Function(`return (${match![1]})`)() as {
      name: string;
      description: string;
      phases: { title: string }[];
    };
    expect(meta.name).toBe("visual-review");
    expect(meta.description.length).toBeGreaterThan(0);
    expect(meta.phases.map((p) => p.title)).toEqual(["Review", "Verify", "Synthesize"]);
  });

  it("fans review out and uses BOTH plugin subagents", () => {
    expect(template).toMatch(/pipeline\(/); // fan-out across components × viewports
    expect(template).toMatch(/parallel\(/); // concurrent skeptics per finding
    expect(template).toMatch(/agentType:\s*["']visual-reviewer["']/);
    expect(template).toMatch(/agentType:\s*["']token-auditor["']/);
  });

  it("forces the locked VerdictReport shape via the agent output schema (not just substrings)", () => {
    // The producer agents are invoked with FINDINGS_SCHEMA; its item shape MUST equal the locked
    // VerdictReport contract, or a lane could read a property the agents never emit.
    const schema = objectLiteralAfter(template, "FINDINGS_SCHEMA") as {
      properties: { findings: { items: { required: string[] } } };
    };
    expect([...schema.properties.findings.items.required].sort()).toEqual(
      [...VERDICT_REPORT_KEYS].sort(),
    );
  });

  it("adversarially verifies each finding behind a majority gate (the Verify phase group)", () => {
    // independent skeptics + a real majority threshold (not a single rubber-stamp).
    expect(template).toMatch(/MAJORITY/);
    expect(template).toMatch(/length\s*>=\s*MAJORITY/);
    expect(template).toMatch(/Math\.floor\(SKEPTICS\s*\/\s*2\)\s*\+\s*1/);
    // Verify interleaves with Review (pipeline), so it's a PER-AGENT phase group, not a top-level
    // phase() call — assert that precise form, and that meta declares it (checked above).
    expect(template).toMatch(/phase:\s*["']Verify["']/);
  });

  it("synthesizes EXACTLY ONE report and returns the verified findings", () => {
    expect(template).toMatch(/phase\("Synthesize"\)/);
    expect(template).toMatch(/INDEPENDENTLY-VERIFIED/);
    expect(template).toMatch(/return\s*\{\s*confirmed/);
    // Exactly one synthesis invocation — a refactor that synthesized per-unit (inside a loop)
    // would produce N reports and must fail here.
    expect((template.match(/label:\s*["']synthesize["']/g) ?? []).length).toBe(1);
  });
});

describe("visual-review SKILL.md", () => {
  it("has frontmatter with a description and launches the bundled template via the Workflow tool", () => {
    expect(/^---\n[\s\S]*?\ndescription:\s*.+/m.test(skill)).toBe(true);
    expect(skill).toMatch(/workflow\.template\.js/);
    expect(skill).toMatch(/Workflow\(/);
    expect(skill).toMatch(/scriptPath/);
  });

  it("offers to save the run as /visual-review and keeps the read-only boundary", () => {
    expect(skill).toMatch(/\/workflows/);
    expect(skill).toMatch(/\.claude\/workflows/);
    expect(skill.toLowerCase()).toMatch(/read-only/);
  });
});
