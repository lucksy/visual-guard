import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  componentNameFromFile,
  extractComponentExports,
  type ComponentExport,
} from "../scripts/lib/harness/component-scan";
import { planLadleScaffold } from "../scripts/lib/harness/scaffold-plan";
import {
  assertScaffoldTarget,
  detectPackageManager,
  runHarness,
  scanComponentFiles,
} from "../scripts/harness";

// --- component-scan (pure) ------------------------------------------------

describe("extractComponentExports", () => {
  it("detects a default function component with no required props", () => {
    const r = extractComponentExports("src/Button.tsx", "export default function Button() { return null; }");
    expect(r).toEqual([
      { file: "src/Button.tsx", name: "Button", kind: "default", likelyNeedsProps: false },
    ]);
  });

  it("detects a named arrow component and flags required destructured props", () => {
    const src = `export const Card = ({ title, subtitle = "" }) => <div>{title}</div>;`;
    expect(extractComponentExports("src/Card.tsx", src)[0]).toMatchObject({
      name: "Card",
      kind: "named",
      likelyNeedsProps: true,
    });
  });

  it("treats fully-defaulted destructured props as not needing props", () => {
    const src = `export const Tag = ({ label = "x" }) => <span>{label}</span>;`;
    expect(extractComponentExports("src/Tag.tsx", src)[0]!.likelyNeedsProps).toBe(false);
  });

  it("ignores non-PascalCase exports (hooks / utilities)", () => {
    const src = `export const useThing = () => 1;\nexport function helper() {}`;
    expect(extractComponentExports("src/x.tsx", src)).toEqual([]);
  });

  it("names an anonymous default export from the file (index → parent dir)", () => {
    expect(extractComponentExports("src/Button/index.tsx", "export default () => null;")[0]).toMatchObject({
      name: "Button",
      kind: "default",
    });
  });

  it("detects `export default Identifier`", () => {
    const src = "const Button = () => null;\nexport default Button;";
    expect(extractComponentExports("src/Button.tsx", src)).toEqual([
      { file: "src/Button.tsx", name: "Button", kind: "default", likelyNeedsProps: false },
    ]);
  });

  it("componentNameFromFile PascalCases the basename / parent for index", () => {
    expect(componentNameFromFile("src/my-card.tsx")).toBe("MyCard");
    expect(componentNameFromFile("src/Modal/index.tsx")).toBe("Modal");
  });
});

// --- scaffold-plan (pure) -------------------------------------------------

const comps: ComponentExport[] = [
  { file: "src/Button.tsx", name: "Button", kind: "default", likelyNeedsProps: false },
  { file: "src/Modal.tsx", name: "Modal", kind: "named", likelyNeedsProps: true },
];

describe("planLadleScaffold", () => {
  it("plans a config + one story per component, with the dev dep + props warnings", () => {
    const plan = planLadleScaffold({ components: comps, fileExists: () => false, componentRoot: "src" });
    expect(plan.files.map((f) => f.path).sort()).toEqual([
      ".ladle/config.mjs",
      "src/Button.stories.tsx",
      "src/Modal.stories.tsx",
    ]);
    expect(plan.devDependency.name).toBe("@ladle/react");
    const button = plan.files.find((f) => f.path === "src/Button.stories.tsx")!;
    expect(button.contents).toContain('import Button from "./Button";');
    expect(button.contents).toContain("export const Default = () => <Button />;");
    const modal = plan.files.find((f) => f.path === "src/Modal.stories.tsx")!;
    expect(modal.contents).toContain('import { Modal } from "./Modal";');
    expect(modal.contents).toContain("TODO(visual-guard)");
    expect(plan.needsPropsWarnings).toEqual([
      { component: "Modal", file: "src/Modal.tsx", story: "src/Modal.stories.tsx" },
    ]);
    expect(plan.files.find((f) => f.path === ".ladle/config.mjs")!.contents).toContain(
      "src/**/*.stories.{tsx,jsx}",
    );
  });

  it("is idempotent — skips files that already exist, never re-plans them", () => {
    const existing = new Set([".ladle/config.mjs", "src/Button.stories.tsx"]);
    const plan = planLadleScaffold({ components: comps, fileExists: (p) => existing.has(p) });
    expect(plan.files.map((f) => f.path)).toEqual(["src/Modal.stories.tsx"]);
    expect(plan.skipped.sort()).toEqual([".ladle/config.mjs", "src/Button.stories.tsx"]);
  });

  it("picks the default export as the primary over secondary named exports in the same file", () => {
    const multi: ComponentExport[] = [
      { file: "src/Group.tsx", name: "GroupItem", kind: "named", likelyNeedsProps: false },
      { file: "src/Group.tsx", name: "Group", kind: "default", likelyNeedsProps: false },
    ];
    const plan = planLadleScaffold({ components: multi, fileExists: () => false });
    const story = plan.files.find((f) => f.role === "story")!;
    expect(story.contents).toContain("export const Default = () => <Group />;");
  });
});

// --- harness shell (filesystem; in-process against a tempdir) -------------

describe("harness shell (runHarness)", () => {
  let tmp = "";
  const put = (rel: string, body: string): void => {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-harness-"));
  });
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("dry-run previews the plan without writing anything", () => {
    put("src/Button.tsx", "export default function Button(){ return null; }");
    put("package.json", JSON.stringify({ name: "x" }, null, 2));
    const r = runHarness({ cwd: tmp, dir: "src", apply: false });
    expect(r.applied).toBe(false);
    expect(r.files.map((f) => f.path)).toContain("src/Button.stories.tsx");
    expect(existsSync(join(tmp, "src/Button.stories.tsx"))).toBe(false);
    expect(existsSync(join(tmp, ".ladle/config.mjs"))).toBe(false);
  });

  it("apply writes the harness + stories, patches package.json, and is idempotent on re-run", () => {
    put("src/Button.tsx", "export default function Button(){ return null; }");
    put("src/Modal.tsx", "export const Modal = ({ open }) => (open ? <div/> : null);");
    put("package.json", JSON.stringify({ name: "x" }, null, 2));

    const r = runHarness({ cwd: tmp, dir: "src", apply: true });
    expect(r.applied).toBe(true);
    expect(existsSync(join(tmp, ".ladle/config.mjs"))).toBe(true);
    expect(readFileSync(join(tmp, "src/Button.stories.tsx"), "utf8")).toContain("<Button />");
    const pkg = JSON.parse(readFileSync(join(tmp, "package.json"), "utf8"));
    expect(pkg.devDependencies["@ladle/react"]).toBeDefined();
    expect(r.installCommand).toBe("npm install");
    expect(r.needsPropsWarnings.map((w) => w.component)).toContain("Modal");

    // Re-run: everything exists → nothing planned, both stories skipped.
    const r2 = runHarness({ cwd: tmp, dir: "src", apply: true });
    expect(r2.files).toEqual([]);
    expect(r2.skipped).toContain("src/Button.stories.tsx");
  });

  it("does not overwrite a user-edited story (idempotency at write time)", () => {
    put("src/Button.tsx", "export default function Button(){ return null; }");
    put("src/Button.stories.tsx", "// my own story\nexport const Default = () => null;");
    put("package.json", JSON.stringify({ name: "x" }, null, 2));
    runHarness({ cwd: tmp, dir: "src", apply: true });
    expect(readFileSync(join(tmp, "src/Button.stories.tsx"), "utf8")).toContain("// my own story");
  });

  it("detectPackageManager reads the lockfile", () => {
    put("pnpm-lock.yaml", "");
    expect(detectPackageManager(tmp)).toBe("pnpm");
  });

  it("scanComponentFiles excludes story/test files and dot/heavy dirs", () => {
    put("src/Button.tsx", "");
    put("src/Button.stories.tsx", "");
    put("src/Button.test.tsx", "");
    put("node_modules/pkg/Comp.tsx", "");
    expect(scanComponentFiles(tmp, "src")).toEqual(["src/Button.tsx"]);
  });

  it("assertScaffoldTarget refuses traversal, protected dirs, and escaping the root", () => {
    expect(() => assertScaffoldTarget("../evil.tsx", tmp)).toThrow(/traversal|outside/);
    expect(() => assertScaffoldTarget("node_modules/x.tsx", tmp)).toThrow(/protected/);
    expect(() => assertScaffoldTarget(".visual-guard/x", tmp)).toThrow(/protected/);
    expect(assertScaffoldTarget("src/Button.stories.tsx", tmp)).toContain("Button.stories.tsx");
  });
});
