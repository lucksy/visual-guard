export const meta = {
  name: "visual-review",
  description:
    "Fan-out visual + token review across components × viewports, adversarially verify each finding with independent skeptics, and synthesize one report of only verified findings.",
  phases: [
    { title: "Review", detail: "visual-reviewer + token-auditor across components × viewports" },
    { title: "Verify", detail: "independent skeptics, majority gate, per finding" },
    { title: "Synthesize", detail: "one report of only independently-verified findings" },
  ],
};

// Visual Guard — /visual-review fan-out workflow TEMPLATE (T-19).
//
// Launched by the `visual-review` skill via the Workflow tool with:
//   args = { manifestPath, units: [{ instance, target, viewport }], driftPath? }
// `units` is one entry per flagged image; `driftPath` (optional) is a DriftFinding[] JSON the
// token-auditor explains. The workflow can't touch the filesystem itself — each subagent Reads
// what it needs (it has Read/Grep/Bash); we only pass paths + identifiers in the prompts.
//
// Shape: fan review out (pipeline, no barrier) → as each review returns, adversarially verify
// every finding with N independent skeptics behind a majority gate → synthesize ONE report from
// only the verified findings. Edit the constants below to tune breadth/strictness, then save it
// as /visual-review (run /workflows, press `s`).

const manifestPath = (args && args.manifestPath) || ".visual-guard/runs/latest/manifest.json";
const units = (args && Array.isArray(args.units) && args.units) || [];
const driftPath = (args && args.driftPath) || null;
const SKEPTICS = 3; // independent verifiers per finding
const MAJORITY = Math.floor(SKEPTICS / 2) + 1; // findings survive only with a majority "real"

// One reviewer/auditor finding: the VerdictReport the plugin agents emit.
const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "target",
          "state",
          "viewport",
          "severity",
          "classification",
          "issue",
          "file",
          "line",
          "cause",
          "impact",
          "fix",
        ],
        properties: {
          target: { type: "string" },
          state: { type: ["string", "null"] },
          viewport: { type: ["number", "null"] },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          classification: {
            type: "string",
            enum: ["intentional", "bug", "design-system-violation"],
          },
          issue: { type: "string" },
          file: { type: "string" },
          line: { type: "number" },
          cause: { type: "string" },
          impact: { type: "array", items: { type: "string" } },
          fix: { type: "string" },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["real", "reasoning"],
  properties: {
    real: { type: "boolean", description: "true only if independently confirmed as a real issue" },
    reasoning: { type: "string" },
  },
};

// Spawn SKEPTICS independent verifiers for one finding; survives only on a majority "real".
async function verifyFinding(finding, lane) {
  const votes = await parallel(
    Array.from(
      { length: SKEPTICS },
      (_unused, i) => () =>
        agent(
          `Independently VERIFY this Visual Guard finding by reading the cited evidence at ` +
            `${manifestPath} and ${finding.file}. Default to real:false unless you can confirm it ` +
            `from the pixels/source — do not rubber-stamp. Skeptic ${i + 1} of ${SKEPTICS}.\n\n` +
            `Finding: ${JSON.stringify(finding)}`,
          { label: `verify:${finding.target}:${i + 1}`, phase: "Verify", schema: VERDICT_SCHEMA },
        ),
    ),
  );
  const real = votes.filter(Boolean).filter((v) => v.real).length >= MAJORITY;
  return { finding, lane, real };
}

phase("Review");

// Visual lane: fan out across components × viewports; verify each finding as its review returns.
const visual = await pipeline(
  units,
  (unit) =>
    agent(
      `Read ${manifestPath} and review the target "${unit.instance}/${unit.target}" at viewport ` +
        `${unit.viewport}. Classify each changed image (intentional | bug | design-system-violation), ` +
        `deep-probing ambiguous diffs via the Playwright MCP before deciding. Return your verdicts.`,
      {
        label: `review:${unit.target}@${unit.viewport}`,
        phase: "Review",
        agentType: "visual-reviewer",
        schema: FINDINGS_SCHEMA,
      },
    ),
  (result, unit) =>
    parallel(
      (result && result.findings ? result.findings : []).map(
        (f) => () => verifyFinding(f, `visual:${unit.target}@${unit.viewport}`),
      ),
    ),
);

// Token lane: if a DriftFinding[] was provided, the token-auditor explains drift the pixel diff
// misses, and each drift is verified the same way.
let token = [];
if (driftPath) {
  const audited = await agent(
    `Read the DriftFinding[] at ${driftPath} and emit a verdict per drift (classification ` +
      `"design-system-violation", state/viewport null). Grep usages for impact; never invent a finding.`,
    { label: "audit:tokens", phase: "Review", agentType: "token-auditor", schema: FINDINGS_SCHEMA },
  );
  token = await parallel(
    (audited && audited.findings ? audited.findings : []).map(
      (f) => () => verifyFinding(f, "token"),
    ),
  );
}

const confirmed = [...visual.flat(), ...token]
  .filter(Boolean)
  .filter((v) => v.real)
  .map((v) => v.finding);

phase("Synthesize");

const report = await agent(
  `Synthesize ONE Visual Guard report from these ${confirmed.length} INDEPENDENTLY-VERIFIED ` +
    `findings (do not add any others). Group by severity (high → low); for each give: target, ` +
    `state@viewport, classification, file:line, cause, impact, and the recommended fix. End with a ` +
    `one-line summary. Findings:\n${JSON.stringify(confirmed)}`,
  { label: "synthesize", phase: "Synthesize" },
);

log(`Verified ${confirmed.length} finding(s) across ${units.length} unit(s)`);

return { confirmed, report };
