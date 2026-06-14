import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bridge verification for the engine-invocation bridge (T-12). `install-deps.mjs` is a plain
 * `.mjs` the SessionStart hook runs with `node` (no tsx), so its testable logic is imported
 * here. The specifier is held in a variable so `tsc` does not try to resolve the un-typed
 * `.mjs` (which would break `npm run typecheck`); vitest resolves it at runtime.
 */
const installDepsSpecifier = "../scripts/install-deps.mjs";
const { ensureBridgeLink, ENGINE_DEPS } = (await import(installDepsSpecifier)) as {
  ensureBridgeLink: (
    rootNodeModules: string,
    depsNodeModules: string,
  ) => "created" | "repaired" | "kept-existing";
  ENGINE_DEPS: Record<string, string>;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
// The repo's own node_modules — a real install we borrow `pngjs` and the `tsx` runner from.
const repoNodeModules = join(repoRoot, "node_modules");

describe("install-deps engine bridge", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-bridge-"));
  });

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("declares tsx (the runner), the pixel-engine deps, and the token-parser deps", () => {
    expect(Object.keys(ENGINE_DEPS).sort()).toEqual([
      "culori",
      "pixelmatch",
      "playwright",
      "pngjs",
      "postcss",
      "postcss-less",
      "postcss-scss",
      "sharp",
      "tsx",
      "typescript",
    ]);
  });

  it("stays in lockstep with package.json (drift would desync the install marker)", () => {
    // The doc comment + the idempotency marker both assume ENGINE_DEPS == the runtime
    // dependencies (same versions) plus the tsx runner and the typescript scanner. This converts
    // that invariant into a guard so adding a dep or bumping one side silently can't ship a stale engine.
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(ENGINE_DEPS).toEqual({
      ...pkg.dependencies,
      tsx: pkg.devDependencies.tsx,
      typescript: pkg.devDependencies.typescript,
    });
  });

  it("creates the bridge symlink when the plugin root has no node_modules (production)", () => {
    const deps = join(tmp, "data", "node_modules");
    mkdirSync(deps, { recursive: true });
    const root = join(tmp, "plugin", "node_modules");
    mkdirSync(dirname(root), { recursive: true });

    expect(ensureBridgeLink(root, deps)).toBe("created");

    const stat = lstatSync(root);
    expect(stat.isSymbolicLink()).toBe(true);
    // The link resolves to the data-dir deps.
    expect(realpathSync(root)).toBe(realpathSync(deps));
    expect(readlinkSync(root)).toBe(deps);
  });

  it("leaves a real node_modules directory untouched (local dev)", () => {
    const deps = join(tmp, "data", "node_modules");
    mkdirSync(deps, { recursive: true });
    const root = join(tmp, "plugin", "node_modules");
    mkdirSync(root, { recursive: true });
    // A real file inside the real dir must survive — we never clobber the dev toolchain.
    writeFileSync(join(root, "marker.txt"), "real");

    expect(ensureBridgeLink(root, deps)).toBe("kept-existing");

    expect(lstatSync(root).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(root, "marker.txt")).isFile()).toBe(true);
  });

  it("keeps a healthy existing bridge link as-is", () => {
    const deps = join(tmp, "data", "node_modules");
    mkdirSync(deps, { recursive: true });
    const root = join(tmp, "plugin", "node_modules");
    mkdirSync(dirname(root), { recursive: true });
    symlinkSync(deps, root, "dir");

    expect(ensureBridgeLink(root, deps)).toBe("kept-existing");
    expect(realpathSync(root)).toBe(realpathSync(deps));
  });

  it("repairs a broken bridge link (data dir was wiped/relocated)", () => {
    const goneDeps = join(tmp, "data-old", "node_modules");
    const root = join(tmp, "plugin", "node_modules");
    mkdirSync(dirname(root), { recursive: true });
    symlinkSync(goneDeps, root, "dir"); // points at a non-existent target → broken link

    const newDeps = join(tmp, "data-new", "node_modules");
    mkdirSync(newDeps, { recursive: true });

    expect(ensureBridgeLink(root, newDeps)).toBe("repaired");
    expect(lstatSync(root).isSymbolicLink()).toBe(true);
    expect(realpathSync(root)).toBe(realpathSync(newDeps));
  });

  it("repairs a stale link that resolves to a wrong-but-existing data dir (relocation)", () => {
    // The data dir was relocated but the OLD one still exists on disk: the link is healthy
    // (not broken) yet points at stale deps. It must be re-pointed at the current deps.
    const oldDeps = join(tmp, "data-old", "node_modules");
    mkdirSync(oldDeps, { recursive: true });
    const newDeps = join(tmp, "data-new", "node_modules");
    mkdirSync(newDeps, { recursive: true });
    const root = join(tmp, "plugin", "node_modules");
    mkdirSync(dirname(root), { recursive: true });
    symlinkSync(oldDeps, root, "dir"); // healthy link, but to the wrong (old) deps

    expect(ensureBridgeLink(root, newDeps)).toBe("repaired");
    expect(realpathSync(root)).toBe(realpathSync(newDeps));
  });

  it("the bridge link makes a bare ESM import resolve via tsx (and NOT without it)", () => {
    // Simulate a production layout: the engine script lives under a plugin root that has NO
    // node_modules of its own; the deps (here, the repo's real node_modules with pngjs + tsx)
    // live in a separate data dir.
    const root = join(tmp, "plugin");
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    const probe = join(root, "scripts", "probe.ts");
    writeFileSync(
      probe,
      'import { PNG } from "pngjs";\nconsole.log("OK", new PNG({ width: 1, height: 1 }).width);\n',
    );

    // NEGATIVE precondition: with no bridge (and tmpdir has no node_modules on the walk-up
    // path), the bare `pngjs` import is unresolvable — proving the bridge is what makes it work.
    const repoTsx = join(repoNodeModules, ".bin", "tsx");
    let stderr = "";
    let threw = false;
    try {
      execFileSync(repoTsx, [probe], { cwd: tmpdir(), encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      threw = true;
      const e = err as { stderr?: string; message?: string };
      stderr = e.stderr ?? e.message ?? "";
    }
    expect(threw).toBe(true);
    expect(stderr).toMatch(/Cannot find package 'pngjs'|ERR_MODULE_NOT_FOUND/);

    // POSITIVE: create the bridge, then the same import resolves through the bridged tsx.
    const rootNodeModules = join(root, "node_modules");
    expect(ensureBridgeLink(rootNodeModules, repoNodeModules)).toBe("created");
    const tsx = join(rootNodeModules, ".bin", "tsx"); // resolves through the bridge link
    // Run from an unrelated cwd to prove resolution is driven by the script location + bridge,
    // not by where the process happens to start.
    const out = execFileSync(tsx, [probe], { cwd: tmpdir(), encoding: "utf8" });
    expect(out.trim()).toBe("OK 1");
  }, 30_000);
});
