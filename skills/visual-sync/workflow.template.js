export const meta = {
  name: "visual-sync",
  description:
    "Populate Component Studio: code snapshots via the headless engine, then Figma design snapshots via the Figma MCP fanned out across subagents. Code-first, content-hash idempotent, and resumable (closed Figma leaves components figma-pending).",
  phases: [
    { title: "Preflight", detail: "engine --check + Figma-MCP availability" },
    { title: "Code", detail: "headless engine capture → compare → studio.db" },
    { title: "Enumerate", detail: "get_metadata → COMPONENT / COMPONENT_SET nodes" },
    { title: "Reconcile", detail: "match Figma↔code → a component key per node" },
    { title: "Capture", detail: "fan out get_screenshot per node → record-figma" },
    { title: "Conformance", detail: "score Figma↔code parity (advisory) + prune" },
  ],
};

// Visual Guard — /visual-sync dual-population workflow TEMPLATE (T-P2).
//
// Launched by the `visual-sync` skill via the Workflow tool with:
//   args = { pluginRoot, configPath, baselineDir?, outRoot?, target?, fileKey? }
//
// MCP tools are agent-callable ONLY and the Workflow runtime cannot touch the filesystem, so every
// step that captures/reads/writes runs INSIDE a subagent (agent()), and the Figma capture fans out
// across subagents (the "use dynamic workflows to speed up Figma access" idea — now the right tool).
// Code capture is the headless engine (scripts/studio/sync.ts); Figma capture is get_screenshot per
// node recorded through scripts/studio/record-figma.ts. No token, no rate limit. Edit BATCH to tune
// fan-out, then save it as /visual-sync (run /workflows, press `s`).

const pluginRoot = (args && args.pluginRoot) || ".";
const configPath = (args && args.configPath) || "config/visual.config.json";
const outRoot = (args && args.outRoot) || ".visual-guard";
const tsx = pluginRoot + "/node_modules/.bin/tsx";
const baselineFlag = args && args.baselineDir ? " --baseline " + args.baselineDir : "";
const targetFlag = args && args.target ? " --target " + args.target : "";
const argFileKey = (args && args.fileKey) || null;
const BATCH = 6; // Figma nodes captured per subagent (bounded fan-out; no rate limit to respect)

const PREFLIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["engineReady", "engineHealthy", "figmaReady"],
  properties: {
    engineReady: { type: "boolean", description: "install-deps.mjs --check .installed" },
    engineHealthy: {
      type: "boolean",
      description: "the FINAL --check .healthy (after an in-place repair, if one was needed)",
    },
    brokenNatives: {
      type: "array",
      items: { type: "string" },
      description: "addons still failing to load after repair (empty when healthy)",
    },
    figmaReady: { type: "boolean", description: "Figma desktop MCP answered get_metadata" },
  },
};

const ENUMERATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["components"],
  properties: {
    fileKey: { type: ["string", "null"] },
    components: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nodeId", "name", "kind", "variants"],
        properties: {
          nodeId: { type: "string" },
          name: { type: "string" },
          kind: { type: "string", enum: ["component", "component-set"] },
          variants: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["nodeId", "name"],
              properties: { nodeId: { type: "string" }, name: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

const MATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["resolved"],
  properties: {
    resolved: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nodeId", "name", "componentKey"],
        properties: {
          nodeId: { type: "string" },
          name: { type: "string" },
          componentKey: { type: "string" },
        },
      },
    },
  },
};

const CAPTURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["recorded", "pending"],
  properties: {
    recorded: { type: "number", description: "Figma nodes captured + recorded this batch" },
    pending: { type: "array", items: { type: "string" }, description: "node ids left figma-pending" },
  },
};

// Forces the code-sync subagent to report whether it ACTUALLY ran the fixed command (vs. investigating
// and returning prose). `ran` gates the fail-fast below.
const CODE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["ran"],
  properties: {
    ran: {
      type: "boolean",
      description: "true ONLY if you executed the exact command and it printed its JSON summary",
    },
    components: { type: "number" },
    currentSnapshots: { type: "number" },
    error: { type: ["string", "null"], description: "the command's stderr if it exited non-zero" },
  },
};

phase("Preflight");

const pre = await agent(
  "Check readiness for a Component Studio sync. You are a COMMAND RUNNER for the engine checks — run " +
    "the EXACT commands below with the Bash tool, verbatim; do not substitute paths.\n" +
    "(1) Engine: run 'node " + pluginRoot + "/scripts/install-deps.mjs --check' and read the one-line " +
    "JSON. engineReady = its .installed.\n" +
    "    - If .installed is true but .healthy is false (.brokenNatives lists broken native addons), the " +
    "engine's native bindings are broken in the tree the scripts load (the code sync would crash " +
    "ERR_DLOPEN_FAILED). REPAIR in place: run 'node " + pluginRoot + "/scripts/install-deps.mjs' (NO " +
    "--check — it repairs), then run '--check' again. Set engineHealthy = the FINAL .healthy and " +
    "brokenNatives = the FINAL .brokenNatives.\n" +
    "    - If .installed is true and .healthy is true, engineHealthy = true, brokenNatives = [].\n" +
    "    - If .installed is false, engineReady = false (engineHealthy = false).\n" +
    "(2) Figma: call the mcp__figma-desktop__get_metadata tool with NO nodeId; figmaReady = it answers " +
    "(lists pages or a selection) rather than erroring that the server/file is unavailable.\n" +
    "Return { engineReady, engineHealthy, brokenNatives, figmaReady }.",
  { label: "preflight", phase: "Preflight", schema: PREFLIGHT_SCHEMA },
);

if (!pre || !pre.engineReady) {
  log("Engine isn't installed — run /visual-setup first, then re-run /visual-sync. Stopping.");
  return { error: "engine-not-installed" };
}

// Health gate (mirrors the command's prose preflight, because the SAVED `/visual-sync` workflow runs
// DIRECTLY — bypassing that prose). If the engine is installed but its native bindings still don't load
// after the in-place repair, STOP before the Code phase (which loads better-sqlite3) — entering it would
// just crash ERR_DLOPEN_FAILED with no recovery.
if (pre.engineHealthy === false) {
  const broken = (pre.brokenNatives || []).join(", ") || "native addons";
  log(
    "Engine native bindings (" + broken + ") could not be repaired — stopping. Reinstall/update the " +
      "plugin (`/plugin` → update visual-guard) so its tree is rebuilt for this machine.",
  );
  return { error: "engine-native-broken", brokenNatives: pre.brokenNatives || [] };
}

phase("Code");

// Code-first: the headless engine populates code snapshots even when Figma is unavailable. This is a
// FIXED, deterministic command — but the workflow runtime can't run Bash itself, so it must hand it to
// a subagent. Past failure: the subagent "investigated" project-relative tooling instead of running
// the absolute command it was given, ran ~76 min, and recorded nothing. So constrain it to a pure
// command-runner contract + a forced result schema, and FAIL FAST below if it didn't actually run.
const codeCmd =
  tsx + " " + pluginRoot + "/scripts/studio/sync.ts --config " + configPath +
  baselineFlag + targetFlag + " --out " + outRoot;
const code = await agent(
  "You are a COMMAND RUNNER, not an investigator. Use the Bash tool to execute this command EXACTLY, " +
    "verbatim — do NOT change, shorten, or substitute any path (the absolute paths are correct), do " +
    "NOT look for project-relative tooling (no `./node_modules`, no relative `scripts/…`), do NOT " +
    "`cd` elsewhere or explore the repo. Run it ONCE:\n\n  " + codeCmd + "\n\n" +
    'It prints a one-line JSON summary like {"command":"sync","components":N,"currentSnapshots":M,...}. ' +
    "On success return { ran: true, ...that parsed JSON }. If the command itself exits non-zero, return " +
    '{ ran: false, error: "<its stderr>" } — e.g. a "could not reach" error means the dev ' +
    "server/Storybook is down. Do not retry with different paths.",
  { label: "code-sync", phase: "Code", schema: CODE_SCHEMA },
);

// Fail-fast: if the deterministic code sync didn't actually run, STOP — never proceed into the Figma
// fan-out (where the wasted time/tokens compounded). Surface the exact command so the user can run it.
if (!code || code.ran !== true) {
  log("Code sync did not run — stopping. Run it directly:\n  " + codeCmd);
  return { error: "code-sync-failed", code: code || null };
}
log(
  "Code snapshots synced" +
    (typeof code.components === "number" ? " (" + code.components + " component(s))" : "") + ".",
);

// Figma is interactive-only: if the desktop app/MCP isn't available, code is still synced and any
// Figma-linked components remain figma-pending for the next run. Never treat this as a failure.
if (!pre.figmaReady) {
  log("Figma desktop app/MCP unavailable — code is synced; Figma stays figma-pending. Re-run with Figma open.");
  return { code, figma: "skipped" };
}

phase("Enumerate");

const enumerated = await agent(
  "Enumerate the open Figma file's components via the Figma MCP. Call mcp__figma-desktop__get_metadata " +
    "with no nodeId to list the top-level pages, then call it again per page id to get that page's XML; " +
    "concatenate the XML and write it to '" + outRoot + "/cache/figma-metadata.xml'. Then run " +
    "'" + tsx + " " + pluginRoot + "/scripts/studio/record-figma.ts enumerate --metadata " +
    outRoot + "/cache/figma-metadata.xml' and return its components[]. Also report the file's key " +
    "(from the file URL) as fileKey.",
  { label: "enumerate", phase: "Enumerate", schema: ENUMERATE_SCHEMA },
);
const components = (enumerated && enumerated.components) || [];
// Prefer the configured file key (D11: matching is namespaced per file) over a URL-derived guess.
const fileKey = argFileKey || (enumerated && enumerated.fileKey);
log("Enumerated " + components.length + " Figma component(s).");

if (components.length === 0 || !fileKey) {
  log("No Figma components found (or no file key) — nothing to capture. Code remains synced.");
  return { code, figmaComponents: components.length, recorded: 0 };
}

phase("Reconcile");

// Match BEFORE capture so each node is recorded under the right component key (matched code key, or a
// figma-only key) — override map > unambiguous normalized name > surfaced (never fuzzily guessed).
const matched = await agent(
  "Resolve each enumerated Figma component to the Studio component key it should record under. Write " +
    "the enumerated components to '" + outRoot + "/cache/figma-enum.json' as { \"components\": [...] }, " +
    "then run '" + tsx + " " + pluginRoot + "/scripts/studio/record-figma.ts match --figma " +
    outRoot + "/cache/figma-enum.json --file-key " + fileKey + " --config " + configPath +
    " --out " + outRoot + "' and return its resolved[] (each { nodeId, name, componentKey }).",
  { label: "reconcile", phase: "Reconcile", schema: MATCH_SCHEMA },
);
const resolved = (matched && matched.resolved) || [];

// Carry each component's enumerated variants through so a COMPONENT_SET's children are captured as
// distinct variant lanes (SPEC §9.1) — not collapsed onto the top-level node.
const units = resolved.map((r) => {
  const comp = components.find((c) => c.nodeId === r.nodeId);
  return {
    nodeId: r.nodeId,
    name: r.name,
    componentKey: r.componentKey,
    variants: (comp && comp.variants) || [],
  };
});

phase("Capture");

// Fan out get_screenshot + record across bounded batches of components (subagents run concurrently).
const batches = [];
for (let i = 0; i < units.length; i += BATCH) {
  batches.push(units.slice(i, i + BATCH));
}
const captured = await parallel(
  batches.map((batch, bi) => () =>
    agent(
      "Capture " + batch.length + " Figma component(s) and record each as a committed design baseline. " +
        "For EACH unit below: if it has a non-empty variants[], capture EACH variant child — call " +
        "mcp__figma-desktop__get_screenshot with the VARIANT's nodeId, save the PNG, then run " +
        "'" + tsx + " " + pluginRoot + "/scripts/studio/record-figma.ts record --component-key " +
        "<unit.componentKey> --file-key " + fileKey + " --node-id <unit.nodeId> --variant " +
        "\"<variant.name>\" --name \"<unit.name>\" --image <png> --config " + configPath + " --out " +
        outRoot + "'. If variants[] is empty, capture the unit node itself (its nodeId, no --variant). " +
        "Save PNGs under '" + outRoot + "/cache/figma-" + bi + "-<index>.png'. If a get_screenshot " +
        "fails, SKIP that node (it stays figma-pending) and add its nodeId to pending. Return " +
        "{ recorded, pending }.\n\nUnits:\n" + JSON.stringify(batch),
      { label: "capture:" + bi, phase: "Capture", schema: CAPTURE_SCHEMA },
    ),
  ),
);

const recorded = captured.filter(Boolean).reduce((sum, r) => sum + (r.recorded || 0), 0);
const pending = captured.filter(Boolean).reduce((acc, r) => acc.concat(r.pending || []), []);

// Flip any figma-linked component still missing its design (a skipped/failed node) to figma-pending,
// so the next /visual-sync resumes only those (SPEC §9.5).
await agent(
  "Run: '" + tsx + " " + pluginRoot + "/scripts/studio/record-figma.ts pending --out " + outRoot +
    "' and return its JSON.",
  { label: "finalize-pending", phase: "Capture" },
);

log(
  "Recorded " + recorded + " Figma baseline(s) across " + batches.length + " batch(es)" +
    (pending.length ? "; " + pending.length + " node(s) left figma-pending." : "."),
);

phase("Conformance");

// Both sides are now populated — score the advisory Figma↔code parity (P5). This records the
// informational `figma_vs_code` axis + parity badge ONLY; it can never gate CI (the code regression
// axis is owned by /visual-ci). Idempotent: a re-run on an unchanged DS records no new rows.
const conformance = await agent(
  "Score Figma↔code conformance now that both design and code baselines are populated. Run from the " +
    "project root: '" + tsx + " " + pluginRoot + "/scripts/studio.ts conformance --config " +
    configPath + " --out " + outRoot + "' and return its parsed summary JSON " +
    "({ scored, byLevel, skipped }). Advisory only — never a pass/fail gate.",
  { label: "conformance", phase: "Conformance" },
);
if (conformance && typeof conformance.scored === "number") {
  log("Scored conformance for " + conformance.scored + " linked component(s) (advisory parity).");
}

return { code, figmaComponents: components.length, recorded, pending, conformance };
