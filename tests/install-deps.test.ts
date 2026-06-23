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
interface NativeRuntime {
  abi: string;
  platform: string;
  arch: string;
  libc: string | null;
}
interface InstallState {
  dataDir: string;
  installed: boolean;
  depsPresent: boolean;
  browserPresent: boolean;
  markerMatches: boolean;
  missing: string[];
  engineDeps: Record<string, string>;
  nativeRuntime: NativeRuntime;
  browser: string;
  /** Added to the `--check` CLI output (not computeInstallState): runtime-tree native load-test. */
  healthy?: boolean;
  brokenNatives?: string[];
  systemSupported?: boolean;
  systemIssues?: string[];
  repair?: string;
  reason?: string;
}

const installDepsSpecifier = "../scripts/install-deps.mjs";
const {
  ensureBridgeLink,
  ENGINE_DEPS,
  NATIVE_MODULES,
  NODE_MAJOR_FLOOR,
  computeInstallState,
  desiredManifest,
  nativeRuntime,
  detectLibc,
  systemSupport,
  repairCommand,
  resolveNpm,
  verifyNativeModules,
  acquireInstallLock,
  releaseInstallLock,
  bridgeReachable,
  resolveDataDir,
  runStep,
} = (await import(installDepsSpecifier)) as {
  ensureBridgeLink: (
    rootNodeModules: string,
    depsNodeModules: string,
  ) => "created" | "repaired" | "kept-existing";
  ENGINE_DEPS: Record<string, string>;
  NATIVE_MODULES: string[];
  NODE_MAJOR_FLOOR: number;
  computeInstallState: (dataDir: string) => InstallState;
  desiredManifest: () => string;
  nativeRuntime: (proc?: unknown) => NativeRuntime;
  detectLibc: (proc?: unknown) => string | null;
  systemSupport: (proc?: unknown) => { supported: boolean; issues: string[] };
  repairCommand: () => string;
  resolveNpm: (
    execPath?: string,
    platform?: string,
  ) => { command: string; prefix: string[] };
  verifyNativeModules: (dataDir: string, env: NodeJS.ProcessEnv) => string[];
  acquireInstallLock: (dataDir: string) => string | boolean;
  releaseInstallLock: (lock: string | boolean) => void;
  bridgeReachable: (rootNodeModules: string, depsNodeModules: string) => boolean;
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

  it("declares the runtime native addons that must be load-verified", () => {
    // better-sqlite3 (ABI-keyed) + sharp (platform/arch-keyed) are the addons npm can leave broken
    // after an exit-0 install; the rest of ENGINE_DEPS is pure JS.
    expect([...NATIVE_MODULES].sort()).toEqual(["better-sqlite3", "sharp"]);
    // Every declared native module must itself be a declared engine dep.
    for (const mod of NATIVE_MODULES) {
      expect(ENGINE_DEPS).toHaveProperty(mod);
    }
  });

  it("bakes the native runtime fingerprint (abi/platform/arch/libc) into the install marker", () => {
    // The marker must invalidate on a Node ABI bump, an OS/arch change, OR a glibc↔musl move — not
    // just on a dep change — otherwise a stale prebuilt binary loads and crashes. The manifest carries
    // that fingerprint.
    const marker = JSON.parse(desiredManifest()) as { nativeRuntime: NativeRuntime };
    expect(marker.nativeRuntime).toEqual({
      abi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
      libc: process.platform === "linux" ? expect.stringMatching(/glibc|musl/) : null,
    });
    expect(nativeRuntime()).toEqual(marker.nativeRuntime);
  });

  it("detectLibc distinguishes glibc/musl on Linux and is null off Linux", () => {
    // Dependency-free libc detection via process.report. On non-Linux it must be null (no libc axis);
    // on Linux it must commit to one of the two families sharp ships distinct binaries for.
    const glibc = { platform: "linux", report: { getReport: () => ({ header: { glibcVersionRuntime: "2.39" } }) } };
    const musl = { platform: "linux", report: { getReport: () => ({ header: {} }) } };
    expect(detectLibc(glibc)).toBe("glibc");
    expect(detectLibc(musl)).toBe("musl");
    expect(detectLibc({ platform: "darwin" })).toBeNull();
    expect(detectLibc({ platform: "win32" })).toBeNull();
    // The real host: null off Linux, else glibc|musl.
    const here = detectLibc();
    expect(process.platform === "linux" ? /glibc|musl/.test(String(here)) : here === null).toBe(true);
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

  it("reports not-installed when only the native runtime fingerprint changed (Node ABI bump)", () => {
    // Same deps, same browser — but the stored marker was written under a different Node ABI (the
    // classic "user upgraded Node, prebuilt binary no longer loads" case). The marker must mismatch
    // so the next session rebuilds, instead of trusting deps that were built for the old ABI.
    const current = JSON.parse(desiredManifest()) as { nativeRuntime: NativeRuntime };
    const stale = desiredManifest().replace(
      `"abi": ${JSON.stringify(current.nativeRuntime.abi)}`,
      `"abi": ${JSON.stringify(`${current.nativeRuntime.abi}-OLD`)}`,
    );
    expect(stale).not.toEqual(desiredManifest()); // the replacement actually changed something
    writeMarker(stale);
    makeDeps();
    makeBrowser();

    const state = computeInstallState(dataDir);
    expect(state.installed).toBe(false);
    expect(state.markerMatches).toBe(false);
    expect(state.missing).toEqual(["marker"]);
    // --check still reports the *current* runtime so the consent gate can explain the rebuild.
    expect(state.nativeRuntime).toEqual(current.nativeRuntime);
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

describe("verifyNativeModules — load-test the native addons (catches a silent exit-0 install)", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-native-"));
  });

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns [] when both native addons load (probing the repo's real node_modules)", () => {
    // The repo's own install has working better-sqlite3 + sharp, so probing it must find both healthy.
    expect(verifyNativeModules(repoRoot, process.env)).toEqual([]);
  });

  it("reports every native addon as failed when node_modules has none of them", () => {
    // A bare dir with no node_modules on the walk-up path: every `require()` fails → all reported.
    // This is the shape the verifier sees right after a prebuild silently failed to drop the binary.
    expect([...verifyNativeModules(tmp, process.env)].sort()).toEqual(["better-sqlite3", "sharp"]);
  }, 15_000);
});

describe("resolveNpm — run npm under the engine's own Node (correct native ABI)", () => {
  it("pins npm to process.execPath when npm-cli.js sits next to the running Node", () => {
    const npm = resolveNpm();
    // On a normal install npm-cli.js is found next to node → command is THIS node, prefix is the cli.
    expect(npm.command).toBe(process.execPath);
    expect(npm.prefix).toHaveLength(1);
    expect(npm.prefix[0]).toMatch(/npm-cli\.js$/);
  });

  it("falls back to the bare `npm` shim when no npm-cli.js is found beside the given Node", () => {
    // A bogus exec path with no sibling npm → graceful fallback to PATH `npm` (better than crashing).
    expect(resolveNpm("/nonexistent/dir/node", "linux")).toEqual({ command: "npm", prefix: [] });
  });
});

describe("acquireInstallLock — serialize concurrent SessionStart installs", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-lock-"));
  });
  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("grants the lock once, refuses a second live holder, and re-grants after release", () => {
    const a = acquireInstallLock(tmp);
    expect(typeof a).toBe("string"); // acquired by us
    // A second acquire while we (a live process) still hold it must DEFER.
    expect(acquireInstallLock(tmp)).toBe(false);
    releaseInstallLock(a);
    // After release the lock is free again.
    const b = acquireInstallLock(tmp);
    expect(typeof b).toBe("string");
    releaseInstallLock(b);
  });

  it("reclaims a stale lock (dead holder / ancient timestamp)", () => {
    const lockDir = join(tmp, ".engine-install.lock");
    mkdirSync(lockDir, { recursive: true });
    // pid 999999999 is not a live process AND the timestamp is epoch-0 — stale on both counts.
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 999999999, at: 0 }));
    const got = acquireInstallLock(tmp);
    expect(typeof got).toBe("string"); // reclaimed and granted
    releaseInstallLock(got);
  });

  it("releaseInstallLock is a no-op for the true/false sentinels", () => {
    expect(() => releaseInstallLock(true)).not.toThrow();
    expect(() => releaseInstallLock(false)).not.toThrow();
  });
});

describe("bridgeReachable — the engine's deps actually resolve from the plugin root", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vg-reach-"));
  });
  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("true for a real dev node_modules directory", () => {
    const root = join(tmp, "node_modules");
    mkdirSync(root, { recursive: true });
    expect(bridgeReachable(root, join(tmp, "deps", "node_modules"))).toBe(true);
  });

  it("true for a symlink that resolves to the deps", () => {
    const deps = join(tmp, "deps", "node_modules");
    mkdirSync(deps, { recursive: true });
    const root = join(tmp, "plugin", "node_modules");
    mkdirSync(dirname(root), { recursive: true });
    symlinkSync(deps, root, "dir");
    expect(bridgeReachable(root, deps)).toBe(true);
  });

  it("false for a broken symlink and for a missing entry (a symlink-less filesystem)", () => {
    const deps = join(tmp, "deps", "node_modules");
    mkdirSync(deps, { recursive: true });
    const broken = join(tmp, "plugin", "node_modules");
    mkdirSync(dirname(broken), { recursive: true });
    symlinkSync(join(tmp, "gone"), broken, "dir"); // target does not exist → broken link
    expect(bridgeReachable(broken, deps)).toBe(false);
    expect(bridgeReachable(join(tmp, "absent"), deps)).toBe(false);
  });
});

describe("systemSupport — up-front unsupported-system detection", () => {
  const mk = (node: string) => ({ versions: { node, modules: "127" }, platform: "darwin", arch: "x64" });

  it("supports the current runtime (the test runs on a supported Node)", () => {
    expect(systemSupport()).toEqual({ supported: true, issues: [] });
  });

  it(`flags Node below the floor (${"<"} ${"NODE_MAJOR_FLOOR"}) with an upgrade instruction`, () => {
    const r = systemSupport(mk(`${NODE_MAJOR_FLOOR - 2}.0.0`));
    expect(r.supported).toBe(false);
    expect(r.issues[0]).toMatch(new RegExp(`Node ${NODE_MAJOR_FLOOR}\\+`));
    expect(r.issues[0]).toMatch(/upgrade/i);
  });

  it("supports exactly the floor and above", () => {
    expect(systemSupport(mk(`${NODE_MAJOR_FLOOR}.0.0`)).supported).toBe(true);
    expect(systemSupport(mk(`${NODE_MAJOR_FLOOR + 4}.1.0`)).supported).toBe(true);
  });

  it("repairCommand is the sanctioned install-deps.mjs self-heal (not a raw npm rebuild)", () => {
    const cmd = repairCommand();
    expect(cmd).toMatch(/install-deps\.mjs/);
    expect(cmd).toMatch(/^node /);
    expect(cmd).not.toMatch(/npm rebuild/);
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
      // Defect B: --check now surfaces runtime-tree native health, not just fs-existence.
      expect(state.healthy).toBe(false); // not installed ⇒ not healthy
      expect(state.brokenNatives).toEqual([]); // no load-test attempted when not installed
      // System-support + sanctioned repair command are always present so an agent never improvises.
      expect(state.systemSupported).toBe(true); // CI/test runs on a supported Node
      expect(state.systemIssues).toEqual([]);
      expect(state.repair).toMatch(/install-deps\.mjs/);
      expect(state.repair).not.toMatch(/npm rebuild/);
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});
