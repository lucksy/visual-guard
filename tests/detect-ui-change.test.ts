import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * T-18 checkpoint-hook script. It is a plain `.mjs` the PostToolUse/Stop hooks run with a bare
 * `node` (no tsx, no engine deps), so — like install-deps.mjs — its testable logic is imported
 * here via a runtime-variable specifier so `tsc` never tries to type the un-typed `.mjs`.
 */
const specifier = "../scripts/detect-ui-change.mjs";
const mod = (await import(specifier)) as {
  DEFAULT_UI_GLOBS: string[];
  globToRegExp: (glob: string) => RegExp;
  matchesAnyGlob: (file: string, globs: string[]) => boolean;
  toProjectRelative: (filePath: string, cwd: string) => string;
  isInProject: (rel: string) => boolean;
  pendingPathFor: (cwd: string) => string;
  resolveUiGlobs: (
    cwd: string,
    readFileImpl?: unknown,
    existsImpl?: unknown,
    env?: Record<string, string | undefined>,
  ) => string[];
  parsePayload: (raw: string) => { toolName?: string; filePath?: string; cwd?: string } | null;
  readPending: (pendingPath: string) => { version: number; files: string[] };
  mergePending: (
    existing: { files: string[] } | null,
    files: string[],
  ) => { version: number; files: string[] };
  buildNudge: (pending: { files: string[] }) => string | null;
  runDetect: (raw: string) => { version: number; files: string[] } | null;
  runNudge: (raw: string) => string | null;
  runClear: (env?: Record<string, string | undefined>) => string;
};

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "..", "scripts", "detect-ui-change.mjs");

const writePayload = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/proj/src/Button.tsx" },
    cwd: "/proj",
    ...over,
  });

describe("globToRegExp / matchesAnyGlob", () => {
  it("matches UI files (tsx/jsx/vue/svelte/css/scss) and rejects others", () => {
    const g = mod.DEFAULT_UI_GLOBS;
    expect(mod.matchesAnyGlob("src/components/Button.tsx", g)).toBe(true);
    expect(mod.matchesAnyGlob("Button.jsx", g)).toBe(true);
    expect(mod.matchesAnyGlob("a/b/styles.scss", g)).toBe(true);
    expect(mod.matchesAnyGlob("README.md", g)).toBe(false);
    expect(mod.matchesAnyGlob("scripts/build.ts", g)).toBe(false); // .ts is not a UI glob
  });
});

describe("toProjectRelative / isInProject", () => {
  it("makes an in-project absolute path relative + posix", () => {
    expect(mod.toProjectRelative("/proj/src/Button.tsx", "/proj")).toBe("src/Button.tsx");
    expect(mod.isInProject("src/Button.tsx")).toBe(true);
  });

  it("returns an out-of-project path unchanged, and isInProject rejects it", () => {
    const out = mod.toProjectRelative("/elsewhere/x.tsx", "/proj");
    expect(out).toBe("/elsewhere/x.tsx");
    expect(mod.isInProject(out)).toBe(false); // absolute → not in project
    expect(mod.isInProject("../sibling/x.tsx")).toBe(false); // escapes upward → not in project
  });
});

describe("parsePayload", () => {
  it("extracts tool name, file path, and cwd", () => {
    expect(mod.parsePayload(writePayload())).toEqual({
      toolName: "Write",
      filePath: "/proj/src/Button.tsx",
      cwd: "/proj",
    });
  });

  it("returns null on non-JSON / non-object input", () => {
    expect(mod.parsePayload("not json")).toBeNull();
    expect(mod.parsePayload("123")).toBeNull();
  });
});

describe("mergePending / buildNudge", () => {
  it("de-duplicates and sorts the pending set", () => {
    expect(mod.mergePending({ files: ["b.tsx", "a.css"] }, ["a.css", "c.tsx"])).toEqual({
      version: 1,
      files: ["a.css", "b.tsx", "c.tsx"],
    });
  });

  it("nudges with a count when pending, and is silent when empty", () => {
    expect(mod.buildNudge({ files: [] })).toBeNull();
    expect(mod.buildNudge({ files: ["src/Button.tsx"] })).toMatch(/1 UI file edited/);
    expect(mod.buildNudge({ files: ["a.tsx", "b.css"] })).toMatch(/2 UI files edited/);
  });
});

describe("resolveUiGlobs", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-detect-"));
  });
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  it("reads uiGlobs from the project's visual.config.json", () => {
    writeFileSync(join(tmp, "visual.config.json"), JSON.stringify({ uiGlobs: ["**/*.foo"] }));
    expect(mod.resolveUiGlobs(tmp)).toEqual(["**/*.foo"]);
  });

  it("falls back to the defaults when no config is present", () => {
    expect(mod.resolveUiGlobs(tmp)).toEqual(mod.DEFAULT_UI_GLOBS);
  });

  it("consults the bundled ${CLAUDE_PLUGIN_ROOT}/config when the project has none", () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), "vg-plugin-"));
    try {
      mkdirSync(join(pluginRoot, "config"), { recursive: true });
      writeFileSync(
        join(pluginRoot, "config", "visual.config.json"),
        JSON.stringify({ uiGlobs: ["**/*.bundled"] }),
      );
      // project tmp has no config → fall through to the bundled plugin default
      expect(
        mod.resolveUiGlobs(tmp, undefined, undefined, { CLAUDE_PLUGIN_ROOT: pluginRoot }),
      ).toEqual(["**/*.bundled"]);
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });
});

describe("runDetect (records into pending.json)", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-detect-"));
  });
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  it("records an edited UI file as a project-relative path", () => {
    const result = mod.runDetect(
      writePayload({ cwd: tmp, tool_input: { file_path: join(tmp, "src", "Button.tsx") } }),
    );
    expect(result).toEqual({ version: 1, files: ["src/Button.tsx"] });
    const onDisk = mod.readPending(mod.pendingPathFor(tmp));
    expect(onDisk.files).toEqual(["src/Button.tsx"]);
  });

  it("ignores a non-UI edit (no pending.json entry)", () => {
    const result = mod.runDetect(
      writePayload({ cwd: tmp, tool_input: { file_path: join(tmp, "README.md") } }),
    );
    expect(result).toBeNull();
    expect(existsSync(mod.pendingPathFor(tmp))).toBe(false);
  });

  it("accumulates + de-duplicates across multiple edits", () => {
    mod.runDetect(
      writePayload({ cwd: tmp, tool_input: { file_path: join(tmp, "src/Button.tsx") } }),
    );
    mod.runDetect(writePayload({ cwd: tmp, tool_input: { file_path: join(tmp, "src/Card.css") } }));
    mod.runDetect(
      writePayload({ cwd: tmp, tool_input: { file_path: join(tmp, "src/Button.tsx") } }),
    );
    expect(mod.readPending(mod.pendingPathFor(tmp)).files).toEqual([
      "src/Button.tsx",
      "src/Card.css",
    ]);
  });

  it("ignores a tool call with no file_path (e.g. a non-edit tool)", () => {
    expect(mod.runDetect(JSON.stringify({ tool_name: "Bash", cwd: tmp }))).toBeNull();
    expect(existsSync(mod.pendingPathFor(tmp))).toBe(false);
  });

  it("ignores an edit OUTSIDE the project root (not a pending change for this project)", () => {
    // A UI file edited elsewhere would still match a `**` glob, but it isn't this project's
    // concern — it must not be recorded in this project's pending.json.
    const result = mod.runDetect(
      writePayload({ cwd: tmp, tool_input: { file_path: "/elsewhere/Evil.tsx" } }),
    );
    expect(result).toBeNull();
    expect(existsSync(mod.pendingPathFor(tmp))).toBe(false);
  });
});

describe("runClear (resets the pending markers)", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-detect-"));
  });
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  it("removes pending.json so the nudge resets, and is a no-op when already absent", () => {
    mod.runDetect(
      writePayload({ cwd: tmp, tool_input: { file_path: join(tmp, "src/Button.tsx") } }),
    );
    expect(existsSync(mod.pendingPathFor(tmp))).toBe(true);

    mod.runClear({ CLAUDE_PROJECT_DIR: tmp });
    expect(existsSync(mod.pendingPathFor(tmp))).toBe(false);
    // After clearing, the Stop nudge falls silent.
    expect(mod.runNudge(JSON.stringify({ cwd: tmp }))).toBeNull();

    // Idempotent: clearing again when nothing is pending doesn't throw.
    expect(() => mod.runClear({ CLAUDE_PROJECT_DIR: tmp })).not.toThrow();
  });
});

describe("runNudge (Stop)", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-detect-"));
  });
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  it("returns a nudge when pending is non-empty, null when empty/absent", () => {
    expect(mod.runNudge(JSON.stringify({ cwd: tmp }))).toBeNull(); // nothing pending yet
    mod.runDetect(
      writePayload({ cwd: tmp, tool_input: { file_path: join(tmp, "src/Button.tsx") } }),
    );
    expect(mod.runNudge(JSON.stringify({ cwd: tmp }))).toMatch(/run \/visual-check/);
  });
});

describe("end-to-end via a bare `node` invocation (no engine deps)", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-detect-"));
  });
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  it("PostToolUse: a piped Write payload writes pending.json", () => {
    execFileSync("node", [scriptPath], {
      input: writePayload({ cwd: tmp, tool_input: { file_path: join(tmp, "src/Button.tsx") } }),
      encoding: "utf8",
    });
    const onDisk = JSON.parse(readFileSync(mod.pendingPathFor(tmp), "utf8")) as { files: string[] };
    expect(onDisk.files).toEqual(["src/Button.tsx"]);
  });

  it("Stop --nudge: emits a systemMessage JSON when something is pending", () => {
    mod.runDetect(
      writePayload({ cwd: tmp, tool_input: { file_path: join(tmp, "src/Button.tsx") } }),
    );
    const out = execFileSync("node", [scriptPath, "--nudge"], {
      input: JSON.stringify({ hook_event_name: "Stop", cwd: tmp }),
      encoding: "utf8",
    });
    const parsed = JSON.parse(out) as { systemMessage: string };
    expect(parsed.systemMessage).toMatch(/run \/visual-check/);
  });

  it("Stop --nudge: emits nothing when pending is empty", () => {
    const out = execFileSync("node", [scriptPath, "--nudge"], {
      input: JSON.stringify({ hook_event_name: "Stop", cwd: tmp }),
      encoding: "utf8",
    });
    expect(out.trim()).toBe("");
  });

  it("--clear: removes pending.json end-to-end", () => {
    mod.runDetect(
      writePayload({ cwd: tmp, tool_input: { file_path: join(tmp, "src/Button.tsx") } }),
    );
    expect(existsSync(mod.pendingPathFor(tmp))).toBe(true);
    execFileSync("node", [scriptPath, "--clear"], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
    });
    expect(existsSync(mod.pendingPathFor(tmp))).toBe(false);
  });

  // The load-bearing guarantee (SPEC "Never do": don't break the user's turn): malformed,
  // empty, or binary stdin must still exit 0 (execFileSync throws on a non-zero exit) and must
  // not write anything. This guards main()'s try/catch + unconditional exit(0) against regression.
  it("never crashes the turn on garbage/empty/binary stdin (exits 0, writes nothing)", () => {
    const run = (input: string | Buffer, args: string[] = []) =>
      execFileSync("node", [scriptPath, ...args], {
        input,
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      });
    expect(() => run("not json {[")).not.toThrow(); // malformed (default/detect mode)
    expect(() => run("")).not.toThrow(); // empty
    expect(() => run(Buffer.from([0xff, 0xfe, 0x00, 0x01]))).not.toThrow(); // binary
    expect(() => run("not json", ["--nudge"])).not.toThrow(); // malformed (nudge mode)
    expect(existsSync(mod.pendingPathFor(tmp))).toBe(false); // nothing recorded from junk input
  });
});
