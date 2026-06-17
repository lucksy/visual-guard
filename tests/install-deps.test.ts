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
interface InstallState {
  dataDir: string;
  installed: boolean;
  depsPresent: boolean;
  browserPresent: boolean;
  markerMatches: boolean;
  missing: string[];
  engineDeps: Record<string, string>;
  browser: string;
}

const installDepsSpecifier = "../scripts/install-deps.mjs";
const { ensureBridgeLink, ENGINE_DEPS, computeInstallState, desiredManifest, resolveDataDir, runStep } =
  (await import(installDepsSpecifier)) as {
    ensureBridgeLink: (
      rootNodeModules: string,
      depsNodeModules: string,
    ) => "created" | "repaired" | "kept-existing";
    ENGINE_DEPS: Record<string, string>;
    computeInstallState: (dataDir: string) => InstallState;
    desiredManifest: () => string;
    resolveDataDir: (env?: Record<string, string | undefined>) => string | null;
    runStep: (
      label: string,
      command: string,
      args: string[],
      opts: { cwd: string; env: NodeJS.ProcessEnv },
    ) => Promise<void>;
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
      "better-sqlite3",
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

describe("computeInstallState (--check inspection)", () => {
  let tmp = "";
  let dataDir = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-state-"));
    dataDir = join(tmp, "data");
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  /** Build a (possibly partial) fake install in `dataDir`. */
  const writeMarker = (contents: string) =>
    writeFileSync(join(dataDir, "package.json"), contents);
  const makeDeps = () => mkdirSync(join(dataDir, "node_modules"), { recursive: true });
  const makeBrowser = () => mkdirSync(join(dataDir, "browsers"), { recursive: true });

  it("reports installed:true with no missing for a fully-installed data dir", () => {
    writeMarker(desiredManifest()); // exact byte-for-byte marker match
    makeDeps();
    makeBrowser();

    const state = computeInstallState(dataDir);
    expect(state.installed).toBe(true);
    expect(state.depsPresent).toBe(true);
    expect(state.browserPresent).toBe(true);
    expect(state.markerMatches).toBe(true);
    expect(state.missing).toEqual([]);
    // It surfaces the plan inputs the consent gate explains to the user.
    expect(state.engineDeps).toEqual(ENGINE_DEPS);
    expect(state.browser).toMatch(/Chromium/);
    expect(state.dataDir).toBe(resolve(dataDir));
  });

  it("reports browser missing when deps + marker are present but Chromium isn't", () => {
    writeMarker(desiredManifest());
    makeDeps();
    // no browsers dir

    const state = computeInstallState(dataDir);
    expect(state.installed).toBe(false);
    expect(state.depsPresent).toBe(true);
    expect(state.markerMatches).toBe(true);
    expect(state.browserPresent).toBe(false);
    expect(state.missing).toContain("browser");
    expect(state.missing).not.toContain("deps");
    expect(state.missing).not.toContain("marker");
  });

  it("reports not-installed when the marker mismatches (e.g. a version bump)", () => {
    writeMarker(desiredManifest().replace("visual-guard-engine", "stale-engine"));
    makeDeps();
    makeBrowser();

    const state = computeInstallState(dataDir);
    expect(state.installed).toBe(false);
    expect(state.depsPresent).toBe(true);
    expect(state.browserPresent).toBe(true);
    expect(state.markerMatches).toBe(false);
    expect(state.missing).toEqual(["marker"]);
  });

  it("reports not-installed with both deps and browser missing for an empty data dir", () => {
    // nothing created beyond the empty dataDir
    const state = computeInstallState(dataDir);
    expect(state.installed).toBe(false);
    expect(state.depsPresent).toBe(false);
    expect(state.browserPresent).toBe(false);
    expect(state.markerMatches).toBe(false);
    expect(state.missing).toContain("deps");
    expect(state.missing).toContain("browser");
    expect(state.missing).toContain("marker");
  });
});

describe("runStep — streamed install phase with heartbeat", () => {
  const opts = { cwd: process.cwd(), env: process.env };

  it("resolves when the child exits 0", async () => {
    await expect(
      runStep("test step", process.execPath, ["-e", "process.exit(0)"], opts),
    ).resolves.toBeUndefined();
  });

  it("rejects with the exit code when the child exits non-zero", async () => {
    await expect(
      runStep("test step", process.execPath, ["-e", "process.exit(3)"], opts),
    ).rejects.toThrow(/code 3/);
  });

  it("rejects when the command cannot be spawned", async () => {
    await expect(
      runStep("test step", "definitely-not-a-real-binary-xyz", [], opts),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("resolveDataDir — mid-session fallback (no CLAUDE_PLUGIN_DATA needed)", () => {
  it("prefers CLAUDE_PLUGIN_DATA when set, normalized to absolute", () => {
    expect(resolveDataDir({ CLAUDE_PLUGIN_DATA: "/abs/data" })).toBe("/abs/data");
    expect(resolveDataDir({ CLAUDE_PLUGIN_DATA: "/abs/data/../data" })).toBe("/abs/data");
  });

  it("falls back to <config>/plugins/data/<plugin>-<marketplace> when the env var is absent", () => {
    // Derived from the repo's own bundled manifests (plugin "visual-guard", marketplace "lucksy").
    expect(resolveDataDir({ CLAUDE_CONFIG_DIR: "/tmp/cfg" })).toBe(
      join("/tmp/cfg", "plugins", "data", "visual-guard-lucksy"),
    );
  });

  it("`--check` exits 0 and reports not-installed even when CLAUDE_PLUGIN_DATA is unset", () => {
    // The bug: --check used to exit 1 with a scary error when the env var wasn't set (a command's
    // Bash mid-session). A read-only status check must never crash — it reports state and exits 0.
    const script = join(repoRoot, "scripts", "install-deps.mjs");
    const cfg = mkdtempSync(join(tmpdir(), "vg-cfg-"));
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_DATA;
    env.CLAUDE_CONFIG_DIR = cfg;
    try {
      // execFileSync throws on a non-zero exit, so a clean return already proves exit 0.
      const out = execFileSync("node", [script, "--check"], { env, encoding: "utf8" });
      const state = JSON.parse(out) as InstallState;
      expect(state.installed).toBe(false);
      expect(state.dataDir).toContain(join("plugins", "data", "visual-guard-lucksy"));
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});
