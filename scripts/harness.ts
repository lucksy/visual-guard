import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { extractComponentExports, type ComponentExport } from "./lib/harness/component-scan";
import { planLadleScaffold, type ScaffoldPlan } from "./lib/harness/scaffold-plan";
import { installCommand, type PackageManager } from "./lib/harness/serve-plan";

/**
 * `/visual-init`'s harness scaffolder — the impure shell around the pure `lib/harness/*` planners. When a
 * project has React components but no story explorer, this writes a minimal Ladle harness (config + one
 * story per component) INTO THE USER'S REPO so Visual Guard can capture each component in isolation.
 *
 * This is the one Visual Guard operation that writes outside `visual.config.json` + `.visual-*` (SPEC's
 * "Ask first" boundary), so it is **consent-gated by the command** (a `--dry-run` preview the user approves
 * before `--apply`) and **path-guarded** here (never outside the project root, never into a protected dir).
 * Idempotent: a file that already exists is skipped, never clobbered.
 */

const PREFIX = "Visual Guard harness";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

const toPosix = (path: string): string => path.split(sep).join("/");

// Never scanned for components, never written into (mirrors init.ts's SKIP_DIRS).
const PROTECTED_DIRS = new Set([
  "node_modules",
  ".git",
  ".visual-guard",
  ".visual-baselines",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
]);

const COMPONENT_EXT = /\.(tsx|jsx)$/;
const NON_COMPONENT = /\.(stories|test|spec)\./; // stories/tests aren't components to scaffold for

/**
 * Bounded, lstat-safe walk for component files under `startRel` (project-relative POSIX paths). Skips
 * heavy/generated/dot dirs, symlinks, and `*.stories|test|spec.*` files. Mirrors init.ts's scanners.
 */
export function scanComponentFiles(rootAbs: string, startRel: string, maxDepth = 8): string[] {
  const out: string[] = [];
  const walk = (relDir: string, depth: number): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(rootAbs, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || PROTECTED_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const rel = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(rel, depth + 1);
      } else if (entry.isFile() && COMPONENT_EXT.test(entry.name) && !NON_COMPONENT.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  walk(startRel.replace(/\/+$/, ""), 0);
  return out.sort();
}

/** Read each component file and collect its component exports (pure scan; reads are the only I/O). */
export function collectComponents(rootAbs: string, files: string[]): ComponentExport[] {
  const components: ComponentExport[] = [];
  for (const rel of files) {
    let source: string;
    try {
      source = readFileSync(join(rootAbs, rel), "utf8");
    } catch {
      continue;
    }
    components.push(...extractComponentExports(rel, source));
  }
  return components;
}

/**
 * Path guard for a scaffold write: the destination must resolve inside the project root and never into a
 * protected directory or via `..`. This is the deliberate, narrow exception to init.ts's config-only
 * `assertUnder` — it permits the source tree but still hard-blocks node_modules, .git, the .visual-*
 * dirs, dist, build, etc.
 */
export function assertScaffoldTarget(relPath: string, rootAbs: string): string {
  const segments = toPosix(relPath).split("/");
  if (segments.some((s) => s === "..")) {
    fail(`refusing to write ${relPath}: path traversal is not allowed.`);
  }
  if (segments.some((s) => PROTECTED_DIRS.has(s))) {
    fail(`refusing to write ${relPath}: into a protected directory.`);
  }
  const abs = resolve(rootAbs, relPath);
  const root = resolve(rootAbs);
  if (abs !== root && !abs.startsWith(root + sep)) {
    fail(`refusing to write ${relPath} outside the project root ${rootAbs}.`);
  }
  return abs;
}

/** Detect the package manager by lockfile so the recommended install command matches the user's setup. */
export function detectPackageManager(rootAbs: string): PackageManager {
  if (existsSync(join(rootAbs, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(rootAbs, "yarn.lock"))) return "yarn";
  if (existsSync(join(rootAbs, "bun.lockb"))) return "bun";
  return "npm";
}

/**
 * Add the harness dev dependency to the user's package.json (only when absent in deps OR devDeps). Returns
 * whether it patched. Uses JSON.parse/stringify (the user opted into scaffolding); preserves 2-space indent.
 */
export function patchPackageJson(
  rootAbs: string,
  dep: { name: string; version: string },
): { patched: boolean; hadPackageJson: boolean } {
  const pkgPath = join(rootAbs, "package.json");
  if (!existsSync(pkgPath)) {
    return { patched: false, hadPackageJson: false };
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  if (deps[dep.name] !== undefined || devDeps[dep.name] !== undefined) {
    return { patched: true, hadPackageJson: true }; // already present — treat as satisfied
  }
  devDeps[dep.name] = dep.version;
  pkg.devDependencies = devDeps;
  // Atomic write (temp + rename) so an interrupted write can never truncate the user's package.json.
  const tmpPath = `${pkgPath}.vg-tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(pkg, null, 2)}\n`);
  renameSync(tmpPath, pkgPath);
  return { patched: true, hadPackageJson: true };
}

export interface HarnessCliArgs {
  cwd: string;
  /** Component root dir to scan (project-relative); also the Ladle stories-glob root. */
  dir: string;
  apply: boolean;
}

export function parseArgs(argv: string[]): HarnessCliArgs {
  let cwd = process.cwd();
  let dir = "src";
  let apply = false;

  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined) fail(`missing value for ${flag}.`);
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--cwd":
        cwd = value(++i, "--cwd");
        break;
      case "--dir":
        dir = value(++i, "--dir");
        break;
      case "--apply":
        apply = true;
        break;
      case "--dry-run":
        apply = false;
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  return { cwd, dir, apply };
}

export interface HarnessResult {
  applied: boolean;
  harness: "ladle";
  /** Files written (or that would be written on --apply). */
  files: { path: string; role: string }[];
  skipped: string[];
  needsPropsWarnings: ScaffoldPlan["needsPropsWarnings"];
  componentCount: number;
  devDependency: ScaffoldPlan["devDependency"];
  packageManager: PackageManager;
  /** The command the caller should run to install the dev dependency. */
  installCommand: string;
  /** True only when --apply patched (or confirmed) the dev dependency in package.json. */
  packageJsonPatched?: boolean;
}

/** Build the scaffold plan for a project (pure-ish: filesystem reads only). */
export function buildPlan(cwd: string, dir: string): ScaffoldPlan {
  const rootAbs = resolve(cwd);
  const files = scanComponentFiles(rootAbs, dir);
  const components = collectComponents(rootAbs, files);
  return planLadleScaffold({
    components,
    componentRoot: dir,
    fileExists: (rel) => existsSync(join(rootAbs, rel)),
  });
}

export function runHarness(args: HarnessCliArgs): HarnessResult {
  const rootAbs = resolve(args.cwd);
  const plan = buildPlan(args.cwd, args.dir);
  const packageManager = detectPackageManager(rootAbs);

  const base: HarnessResult = {
    applied: args.apply,
    harness: plan.harness,
    files: plan.files.map((f) => ({ path: f.path, role: f.role })),
    skipped: plan.skipped,
    needsPropsWarnings: plan.needsPropsWarnings,
    componentCount: plan.componentCount,
    devDependency: plan.devDependency,
    packageManager,
    installCommand: installCommand(packageManager),
  };

  if (!args.apply) {
    return base; // dry-run: preview only, nothing written
  }

  for (const file of plan.files) {
    const abs = assertScaffoldTarget(file.path, rootAbs);
    // TOCTOU-safe: re-check existence at write time so a concurrently-created file is never clobbered.
    if (existsSync(abs)) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.contents);
  }
  const { patched } = patchPackageJson(rootAbs, plan.devDependency);
  return { ...base, packageJsonPatched: patched };
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const result = runHarness(args);
  console.log(JSON.stringify(result));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
