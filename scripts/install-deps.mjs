#!/usr/bin/env node
/**
 * Visual Guard — SessionStart dependency bootstrap + engine-invocation bridge.
 *
 * Installs the engine's *runtime* dependencies and a pinned Chromium into the plugin's
 * persistent data dir (${CLAUDE_PLUGIN_DATA}) exactly once, then bridges those deps back to
 * the plugin root so the bundled `.ts` engine is actually runnable by the slash commands.
 * Heavy native deps must not be committed, so they land in the data dir on first session and
 * are reused thereafter.
 *
 * Idempotency follows the documented plugin "diff package.json" pattern, adapted because
 * our bundled package.json mixes the dev toolchain with runtime deps: we synthesize an
 * engine-only manifest, write it into the data dir, and treat it as the marker. If the
 * stored marker already matches AND node_modules + the browser are present, we no-op (but
 * still re-assert the bridge link). A FAILED install removes the marker, so the next session
 * retries (never a half-done "installed" state). isInstalled() also requires the browser dir,
 * so a partial install (deps but no Chromium) is likewise treated as not-installed.
 *
 * The bridge (T-12): the `/visual-check` & `/visual-baseline` commands run the engine via
 * `${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/tsx scripts/<x>.ts`. Those scripts import bare
 * specifiers (`playwright`, `sharp`, `pngjs`, `pixelmatch`, and the Studio DB's native
 * `better-sqlite3`) which ESM resolves by walking up
 * from the script to the nearest `node_modules` — and NODE_PATH does NOT apply to ESM. So the
 * installed deps in the data dir are unreachable from `scripts/` unless a `node_modules` sits
 * adjacent to them. `ensureBridgeLink` symlinks `${pluginRoot}/node_modules` → the data-dir
 * deps in a real install; in local dev the root already has a real `node_modules` (the full
 * toolchain), which is left untouched. `tsx` is part of ENGINE_DEPS so the runner resolves too.
 *
 * ENGINE_DEPS is kept in sync with `dependencies` in ../package.json, plus `tsx` (the runner).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The plugin root is this script's parent's parent (…/scripts/install-deps.mjs) — derived from
// the file location, not an env var, so it is correct under the hook runner and under tests.
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Runtime-only engine deps. Keep the diff-engine versions in lockstep with package.json
// `dependencies`; `tsx` (the command runner) and `typescript` (the token scanner's JSX/Tailwind
// AST + the JS-eval child process) come from devDependencies and live here too (not committed).
export const ENGINE_DEPS = {
  "better-sqlite3": "12.10.1",
  culori: "4.0.2",
  pixelmatch: "5.3.0",
  playwright: "1.49.1",
  pngjs: "7.0.0",
  postcss: "8.5.15",
  "postcss-less": "6.0.0",
  "postcss-scss": "4.0.9",
  sharp: "0.33.5",
  tsx: "4.19.2",
  typescript: "5.7.3",
};

/**
 * The engine's *native* addons — the ones whose binaries are platform/ABI-specific and can fail to
 * install even when `npm install` exits 0:
 *   - `better-sqlite3`: a node-gyp/NAN addon. Its prebuilt binary is keyed by Node's **ABI**
 *     (`process.versions.modules`) + platform + arch; `prebuild-install` silently no-ops if the
 *     matching binary can't be fetched, leaving the addon unloadable.
 *   - `sharp`: ships per-platform `@img/sharp-{platform}-{arch}` packages selected by npm at install
 *     time (N-API, so ABI-independent, but still platform/arch-specific).
 * These two are the runtime addons the engine `require()`s; everything else in ENGINE_DEPS is pure
 * JS. `tsx`/`vite`/`@rollup`/`fsevents` carry native bits too but are the dev/runner toolchain, not
 * something the diff/studio engine loads.
 */
export const NATIVE_MODULES = ["better-sqlite3", "sharp"];

/** Addons we can rebuild *from source* as a last resort (sharp-from-source needs libvips → no). */
const SOURCE_BUILDABLE = new Set(["better-sqlite3"]);

/**
 * Linux libc family — glibc vs musl. sharp ships DISTINCT prebuilt packages per libc
 * (`@img/sharp-linux-*` for glibc vs `@img/sharp-linuxmusl-*` for musl), and better-sqlite3's compiled
 * binary is libc-specific too — yet both report platform `linux` with the same arch, so `{abi,
 * platform, arch}` alone cannot tell a Debian build from an Alpine one. Detected dependency-free via
 * `process.report` (glibc systems expose `header.glibcVersionRuntime`; musl does not). Non-Linux ⇒ null.
 */
export function detectLibc(proc = process) {
  if (proc.platform !== "linux") {
    return null;
  }
  try {
    const header = proc.report?.getReport?.()?.header;
    return header && header.glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    // report unavailable (e.g. disabled) → assume the common case rather than force a needless rebuild.
    return "glibc";
  }
}

/** The Node major the engine requires (SPEC §Runtime + package.json `engines`). */
export const NODE_MAJOR_FLOOR = 20;

/**
 * Up-front "is this system supported?" check — the high-confidence, USER-ACTIONABLE preconditions that
 * a fresh install/repair cannot fix on its own. Right now that's the Node version floor: the native
 * addons (better-sqlite3, sharp) ship prebuilt binaries only for supported Node majors, so on Node < 20
 * a rebuild can't help — the user must upgrade Node. Returns `{ supported, issues[] }`.
 *
 * Deliberately conservative: platform/arch/libc support is NOT hard-checked here (the actual load-test
 * in {@link verifyNativeModules} is the real arbiter, and false-blocking a working-but-uncommon arch
 * would be worse than letting the load-test decide). Those surface in the repair-failure diagnosis.
 */
export function systemSupport(proc = process) {
  const issues = [];
  const major = Number(String(proc.versions.node).split(".")[0]);
  if (Number.isFinite(major) && major < NODE_MAJOR_FLOOR) {
    issues.push(
      `Node ${proc.versions.node} is below the required Node ${NODE_MAJOR_FLOOR}+. The engine's native ` +
        `bindings have no prebuilt for this Node — upgrade to Node ${NODE_MAJOR_FLOOR}+ and start a fresh session.`,
    );
  }
  return { supported: issues.length === 0, issues };
}

/**
 * The ONE sanctioned self-heal command. When a native binding is broken, agents must run THIS (which
 * repairs the RUNTIME tree — `${pluginRoot}/node_modules` — in place) rather than improvise a raw
 * `npm rebuild` in a guessed directory: rebuilding the wrong tree (data dir vs the bridged/real plugin
 * tree the scripts actually load) is precisely what produced the split-brain. Emitted in `--check`
 * output as `repair` so every consumer is handed the correct command.
 */
export function repairCommand() {
  return `node ${JSON.stringify(join(pluginRoot, "scripts", "install-deps.mjs"))}`;
}

/**
 * Fingerprint of the runtime the native addons must match. better-sqlite3's prebuilt binary is keyed
 * by Node's ABI (`process.versions.modules`); both addons select platform/arch/libc-specific binaries
 * at install time. Encoding this in the install marker (below) means a **Node upgrade** (ABI bump) or
 * a **moved/copied data dir** (different OS/arch, or glibc↔musl) invalidates the install, so the next
 * session rebuilds for the current runtime instead of loading a stale binary that crashes with
 * `ERR_DLOPEN_FAILED`/`NODE_MODULE_VERSION`.
 */
export function nativeRuntime(proc = process) {
  return {
    abi: proc.versions.modules,
    platform: proc.platform,
    arch: proc.arch,
    libc: detectLibc(proc),
  };
}

/**
 * The engine-only manifest written into the data dir; also the install marker. `nativeRuntime` is
 * part of the marker (not just `dependencies`) so the same deps built for a different Node ABI or a
 * different platform/arch/libc are correctly treated as "needs reinstall". `npm install` ignores the
 * extra field; only our marker comparison reads it.
 */
export function desiredManifest() {
  return (
    JSON.stringify(
      {
        name: "visual-guard-engine",
        private: true,
        dependencies: ENGINE_DEPS,
        nativeRuntime: nativeRuntime(),
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Resolve an npm invocation that runs under the SAME Node as the engine (`process.execPath`). This is
 * critical: node-gyp/prebuild-install build/fetch a native binary for the ABI of *whatever Node runs
 * npm* — and the `npm` first on PATH frequently belongs to a DIFFERENT Node than the engine's under
 * nvm/volta/asdf/fnm or a GUI-launched app. Pinning npm to `process.execPath npm-cli.js` guarantees
 * the binary matches the ABI the engine (and {@link verifyNativeModules}) load under. Falls back to
 * the bare `npm` shim only when npm's CLI can't be located next to the running Node.
 *
 * @param {string} execPath
 * @param {NodeJS.Platform} platform
 * @returns {{ command: string, prefix: string[] }}
 */
export function resolveNpm(execPath = process.execPath, platform = process.platform) {
  const nodeDir = dirname(execPath);
  const candidates =
    platform === "win32"
      ? [join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")]
      : [
          join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
          join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
        ];
  for (const cli of candidates) {
    if (existsSync(cli)) {
      return { command: execPath, prefix: [cli] };
    }
  }
  return { command: "npm", prefix: [] };
}

/**
 * Build the child-process probe for one native addon. Requires the addon by its ABSOLUTE package dir
 * under `treeDir/node_modules` — NOT a bare specifier — so resolution is pinned to the EXACT tree we
 * mean to test and can never be satisfied by a stray `node_modules` higher up (which would mask a
 * broken install, or, in tests, resolve the repo's own copy). `require()` triggers the `.node` dlopen,
 * the actual failure point; better-sqlite3 also gets a tiny exercise to be sure the binding is usable.
 */
function probeFor(mod, treeDir) {
  const dir = JSON.stringify(join(treeDir, "node_modules", mod));
  if (mod === "better-sqlite3") {
    return `const D=require(${dir});const db=new D(':memory:');db.prepare('select 1 as x').get();db.close();`;
  }
  return `require(${dir});`;
}

/**
 * Load-test the native addons in a child Node process — `process.execPath`, so the probe runs under
 * the SAME Node (hence ABI) the engine will. Resolution is pinned to `treeDir/node_modules` (see
 * {@link probeFor}). Returns the addons that FAILED to load (empty ⇒ all healthy). Never throws.
 *
 * IMPORTANT: pass the tree the SCRIPTS ACTUALLY LOAD FROM — `${pluginRoot}/node_modules` (a real dir
 * OR the bridge symlink) — not the data dir. Probing the data-dir copy while the scripts resolve a
 * separate, broken plugin-root copy is the "split-brain" bug that let a missing `.node` slip through.
 *
 * @param {string} treeDir  Dir whose `node_modules` to probe (the runtime tree at the call sites).
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function verifyNativeModules(treeDir, env) {
  const failures = [];
  for (const mod of NATIVE_MODULES) {
    const result = spawnSync(process.execPath, ["-e", probeFor(mod, treeDir)], {
      cwd: treeDir,
      env,
      stdio: "ignore",
    });
    // status === null ⇒ spawn failed / killed by signal → also a failure.
    if (result.status !== 0) {
      failures.push(mod);
    }
  }
  return failures;
}

/**
 * Repair ONE native addon in place, using the strategy that actually works for it:
 *   - `sharp`: its binary lives in the `@img/sharp-{platform}-{arch}[-musl]` OPTIONAL dependency, not
 *     in a build step, so `npm rebuild sharp` (which only re-runs sharp's no-op install script) can't
 *     fix a missing binary. Re-INSTALL sharp WITH optionals so npm re-resolves and fetches the right
 *     `@img` package. `--no-save` keeps the marker `package.json` byte-stable.
 *   - node-gyp/prebuild addons (`better-sqlite3`): `npm rebuild` re-fetches the prebuilt binary for
 *     the current ABI (or compiles, with `--build-from-source`).
 * npm is pinned to the engine's Node via {@link resolveNpm} so the binary targets the right ABI.
 */
async function repairNative(mod, treeDir, env, npm) {
  const present = existsSync(join(treeDir, "node_modules", mod, "package.json"));
  // `npm rebuild` re-runs a package's build/fetch step but is a NO-OP for a package that is ABSENT from
  // node_modules (a shipped/copied tree can drop the whole `node_modules/<mod>` dir, not just the
  // binary). And sharp's binary lives in an OPTIONAL `@img/sharp-*` subpackage that rebuild can't
  // re-resolve. So use `npm install <pkg>@<ver> --include=optional` (fetches the package AND its native
  // binary) for sharp OR any addon that's missing entirely; reserve `npm rebuild` for the
  // present-but-binaryless node-gyp case (e.g. better-sqlite3 shipped without its `.node`).
  if (mod === "sharp" || !present) {
    await runStep(
      `▸ Repairing ${mod} (${present ? "reinstall platform package" : "install missing package"})…`,
      npm.command,
      [
        ...npm.prefix,
        "install",
        `${mod}@${ENGINE_DEPS[mod]}`,
        "--include=optional",
        "--no-save",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: treeDir, env },
    );
    return;
  }
  await runStep(
    `▸ Repairing ${mod} (re-fetch prebuilt binary)…`,
    npm.command,
    [...npm.prefix, "rebuild", mod],
    { cwd: treeDir, env },
  );
}

/** Last resort for a source-buildable addon: compile from source via node-gyp (pinned npm/Node). */
async function rebuildFromSource(mod, treeDir, env, npm) {
  await runStep(
    `▸ Repairing ${mod} (compile from source)…`,
    npm.command,
    [...npm.prefix, "rebuild", mod, "--build-from-source"],
    { cwd: treeDir, env },
  );
}

/** Per-addon guidance when repair couldn't make a binding load (sharp ≠ a compiler problem). */
function nativeFailureMessage(failed) {
  const parts = [`Native bindings failed to load after repair: ${failed.join(", ")}.`];
  // Lead with the high-confidence, user-actionable cause when the SYSTEM itself is unsupported (e.g.
  // Node too old) — no rebuild can fix that, so say so before suggesting a compiler/network check.
  const sys = systemSupport();
  if (!sys.supported) {
    parts.push(...sys.issues);
  }
  if (failed.includes("sharp")) {
    parts.push(
      "sharp's platform package (@img/sharp-…) could not be installed — check network access, that " +
        "your OS/arch is supported by sharp, and that npm is not omitting optional dependencies " +
        "(`npm config get omit`).",
    );
  }
  if (failed.some((m) => SOURCE_BUILDABLE.has(m))) {
    parts.push(
      "A C/C++ build toolchain may be missing (macOS: `xcode-select --install`; Debian/Ubuntu: " +
        "`sudo apt-get install -y build-essential python3`; Windows: the Visual Studio Build Tools).",
    );
  }
  parts.push("Start a fresh session to retry.");
  return parts.join(" ");
}

/**
 * Ensure every native addon in `treeDir` actually loads — repairing IN PLACE if not. npm exits 0 even
 * when a prebuilt binary silently fails to download (and a shipped plugin-root tree may carry the JS
 * package with NO `.node` at all), so a tree can look "installed" yet be unloadable — the root cause of
 * the studio's `ERR_DLOPEN_FAILED`. Escalation: per-addon repair ({@link repairNative}, `npm` run with
 * `cwd: treeDir` so it repairs THIS tree) → compile-from-source for source-buildable addons → throw
 * with tailored guidance if still broken (the caller removes the marker so the next session retries).
 *
 * Call with the RUNTIME tree (`${pluginRoot}/node_modules`, real or symlinked) so the tree that's
 * repaired is the tree the scripts load.
 *
 * @param {string} treeDir
 * @param {NodeJS.ProcessEnv} env
 */
async function ensureNativeModules(treeDir, env) {
  let failed = verifyNativeModules(treeDir, env);
  if (failed.length === 0) {
    return;
  }
  const npm = resolveNpm();
  process.stderr.write(
    `[visual-guard] Native bindings did not load (${failed.join(", ")}) — repairing…\n`,
  );
  for (const mod of failed) {
    await repairNative(mod, treeDir, env, npm);
  }
  failed = verifyNativeModules(treeDir, env);
  if (failed.length === 0) {
    return;
  }

  // Still broken after the re-fetch/reinstall: compile from source for addons that support it.
  for (const mod of failed.filter((m) => SOURCE_BUILDABLE.has(m))) {
    await rebuildFromSource(mod, treeDir, env, npm);
  }
  failed = verifyNativeModules(treeDir, env);
  if (failed.length === 0) {
    return;
  }

  throw new Error(nativeFailureMessage(failed));
}

/** True iff `linkPath` is a symlink that resolves to the same real dir as `depsNodeModules`. */
function pointsAtDeps(linkPath, depsNodeModules) {
  try {
    // realpathSync throws on a broken link (target gone) → caught → not pointing at deps.
    return realpathSync(linkPath) === realpathSync(depsNodeModules);
  } catch {
    return false;
  }
}

/**
 * Make the installed engine deps reachable from `${pluginRoot}/scripts/` by ensuring
 * `rootNodeModules` resolves to `depsNodeModules`. ESM resolution walks up from the importing
 * file to the nearest `node_modules` (NODE_PATH does not apply to ESM), so this adjacent link
 * is the only mechanism that lets the bundled scripts resolve their bare imports and the tsx
 * runner in a real plugin install.
 *
 * - No entry at the root → create the symlink (the production case).
 * - A real directory at the root → leave it (local dev: the full toolchain is already there).
 * - A symlink that does NOT resolve to the current deps (broken, OR a stale link to a wiped/
 *   relocated data dir) → repair it so the engine never resolves stale deps.
 *
 * Tolerant of a concurrent SessionStart racing the same link: a symlink that already exists by
 * the time we create it (EEXIST) is treated as success, so a benign race never crashes the hook.
 * Returns "created" | "repaired" | "kept-existing". Never clobbers a real directory.
 */
export function ensureBridgeLink(rootNodeModules, depsNodeModules) {
  const link = () => {
    try {
      symlinkSync(depsNodeModules, rootNodeModules, "dir");
    } catch (err) {
      // Another session created the link between our check and here — that is the desired
      // end state, so treat it as done rather than throwing.
      if (!(err && err.code === "EEXIST")) {
        throw err;
      }
    }
  };

  let stat = null;
  try {
    stat = lstatSync(rootNodeModules);
  } catch {
    stat = null; // nothing there
  }

  if (stat === null) {
    link();
    return "created";
  }

  if (stat.isSymbolicLink()) {
    // Repair a link that no longer points at the current deps (broken target, or a stale link
    // to a previous data-dir location). A link already pointing at the deps is left as-is.
    if (!pointsAtDeps(rootNodeModules, depsNodeModules)) {
      rmSync(rootNodeModules, { force: true });
      link();
      return "repaired";
    }
    return "kept-existing";
  }

  // A real directory (dev install) — never replace it.
  return "kept-existing";
}

/** Human-readable label for the pinned browser the installer fetches via Playwright. */
const BROWSER_LABEL = "Chromium (pinned, via Playwright)";

/**
 * Inspect the install state of a data dir WITHOUT touching it — fs reads only, no install, no
 * `process.exit`, no bridge mutation. Mirrors `main()`'s path math and the `isInstalled()`
 * criteria exactly so `--check` and the actual install agree on what "installed" means:
 *   installed ⟺ marker (package.json) matches desiredManifest() AND node_modules present AND
 *   the browsers dir present.
 *
 * `dataDir` is resolved() internally so a relative path still inspects the right place (the
 * installer needs an absolute path for the symlink target, but inspection only reads). Returns a
 * structured, JSON-serializable state object; the consent gate (`/visual-setup`) reads it.
 *
 * @param {string} dataDir
 * @returns {{
 *   dataDir: string,
 *   installed: boolean,
 *   depsPresent: boolean,
 *   browserPresent: boolean,
 *   markerMatches: boolean,
 *   missing: string[],
 *   engineDeps: typeof ENGINE_DEPS,
 *   browser: string,
 * }}
 */
export function computeInstallState(dataDir) {
  const resolvedDataDir = resolve(dataDir);
  const browsersDir = join(resolvedDataDir, "browsers");
  const markerPath = join(resolvedDataDir, "package.json"); // the diff marker
  const nodeModulesDir = join(resolvedDataDir, "node_modules");
  const manifest = desiredManifest();

  const depsPresent = existsSync(nodeModulesDir);
  const browserPresent = existsSync(browsersDir);

  let markerMatches = false;
  if (existsSync(markerPath)) {
    try {
      markerMatches = readFileSync(markerPath, "utf8") === manifest;
    } catch {
      markerMatches = false; // unreadable marker → treat as not matching
    }
  }

  // Same gate as isInstalled(): all three must hold.
  const installed = markerMatches && depsPresent && browserPresent;

  const missing = [];
  if (!depsPresent) {
    missing.push("deps");
  }
  if (!browserPresent) {
    missing.push("browser");
  }
  if (!markerMatches) {
    missing.push("marker");
  }

  return {
    dataDir: resolvedDataDir,
    installed,
    depsPresent,
    browserPresent,
    markerMatches,
    missing,
    engineDeps: ENGINE_DEPS,
    nativeRuntime: nativeRuntime(),
    browser: BROWSER_LABEL,
  };
}

/** The plugin's own name, from the bundled plugin.json (fallback to the known name). */
function readPluginName() {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
    if (typeof pkg.name === "string" && pkg.name.length > 0) {
      return pkg.name;
    }
  } catch {
    /* manifest missing/unreadable — fall through */
  }
  return "visual-guard";
}

/** The marketplace name, from the bundled marketplace.json, or null when it isn't present. */
function readMarketplaceName() {
  try {
    const mkt = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    if (typeof mkt.name === "string" && mkt.name.length > 0) {
      return mkt.name;
    }
  } catch {
    /* not bundled — fall through to discovery */
  }
  return null;
}

/**
 * Resolve the plugin's data dir (where the engine deps + Chromium live). Prefers CLAUDE_PLUGIN_DATA,
 * which the SessionStart hook injects. When it is absent — a slash command's Bash runs mid-session, or
 * the plugin was *added* mid-session so the hook never ran — fall back to Claude Code's conventional
 * location so a `--check` (and a consent-gated install) still works WITHOUT a session restart:
 *
 *   <CLAUDE_CONFIG_DIR | ~/.claude>/plugins/data/<plugin>-<marketplace>
 *
 * <plugin>/<marketplace> come from the bundled manifests; if marketplace.json isn't bundled we discover
 * a single existing `<plugin>-*` data dir instead. Returns an absolute path, or null when it genuinely
 * cannot be determined (then `--check` reports "not installed / unknown" rather than erroring).
 */
export function resolveDataDir(env = process.env) {
  if (env.CLAUDE_PLUGIN_DATA) {
    // Normalize to absolute: the bridge symlink's target must be absolute (a symlink resolves
    // relative to the link's own directory, not cwd).
    return resolve(env.CLAUDE_PLUGIN_DATA);
  }
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const dataBase = join(configDir, "plugins", "data");
  const plugin = readPluginName();

  const marketplace = readMarketplaceName();
  if (marketplace) {
    // The convention Claude Code uses to name a plugin's data dir.
    return join(dataBase, `${plugin}-${marketplace}`);
  }
  // marketplace.json wasn't bundled — fall back to a single existing <plugin>-* data dir.
  try {
    const matches = readdirSync(dataBase).filter((d) => d.startsWith(`${plugin}-`));
    if (matches.length === 1) {
      return join(dataBase, matches[0]);
    }
  } catch {
    /* data base doesn't exist yet */
  }
  return null;
}

/**
 * Run a child process to completion, streaming its output to our inherited stdout/stderr while
 * emitting a periodic heartbeat so a long, quiet phase never *looks* frozen. Used for the two slow
 * install phases (npm + Chromium) so the user can see the engine setup is alive and progressing.
 *
 * Why plain lines and not a `\r` spinner: under the SessionStart hook and under a slash command's
 * Bash, stdout is NOT a TTY, so a carriage-return progress bar wouldn't render — appended lines read
 * as progress in every context (and the child's own npm/Playwright progress streams in between).
 *
 * The heartbeat timer is `unref`'d so it never keeps the process alive on its own; the awaited child
 * handle is what holds the event loop open until "close".
 *
 * @param {string} label    Phase label, e.g. "▸ 2/2 Downloading Chromium (~150 MB)…"
 * @param {string} command  Executable to run.
 * @param {string[]} args   Arguments.
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} opts
 * @returns {Promise<void>} resolves on exit 0, rejects on spawn error or non-zero exit.
 */
export function runStep(label, command, args, opts) {
  return new Promise((resolveStep, rejectStep) => {
    const startedAt = Date.now();
    const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
    process.stderr.write(`[visual-guard] ${label}\n`);

    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: "inherit" });

    const heartbeat = setInterval(() => {
      process.stderr.write(`[visual-guard]   … still working (${elapsed()}s)\n`);
    }, 6000);
    if (typeof heartbeat.unref === "function") {
      heartbeat.unref();
    }

    const finish = (fn, arg) => {
      clearInterval(heartbeat);
      fn(arg);
    };

    child.on("error", (err) => finish(rejectStep, err));
    child.on("close", (code) => {
      if (code === 0) {
        process.stderr.write(`[visual-guard]   done (${elapsed()}s)\n`);
        finish(resolveStep, undefined);
      } else {
        finish(rejectStep, new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

const INSTALL_LOCK_NAME = ".engine-install.lock";
// Longer than any realistic install (npm + ~150 MB Chromium + native repair) so a live install is
// never mistaken for stale, but bounded so a crashed holder's lock is eventually reclaimable.
const INSTALL_LOCK_STALE_MS = 30 * 60 * 1000;

/** True if a process with `pid` is alive (EPERM ⇒ alive but not ours; ESRCH ⇒ gone). */
function isHolderAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

/**
 * Serialize the install/repair critical section against a concurrent SessionStart (two windows, a
 * resume racing a new session) — running `npm install` twice into the same `node_modules` is a known
 * corruption source (interleaved rename/unlink → a truncated `.node` or half-extracted package). Uses
 * an atomic `mkdir` lock (atomic on POSIX and Windows). Returns:
 *   - the lock dir path (string) → acquired by us; release with {@link releaseInstallLock} when done,
 *   - `false`                    → a LIVE, fresh holder owns it; this session should defer,
 *   - `true`                     → proceed WITHOUT a lock (fail-open: an unexpected fs error must
 *                                  never block installs, so we degrade to lock-free rather than wedge).
 * A stale lock (dead holder, or older than {@link INSTALL_LOCK_STALE_MS}) is reclaimed.
 */
export function acquireInstallLock(dataDir) {
  const lockDir = join(dataDir, INSTALL_LOCK_NAME);
  const ownerPath = join(lockDir, "owner.json");
  const claim = () => {
    mkdirSync(lockDir); // atomic; throws EEXIST if it already exists
    try {
      writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch {
      /* owner metadata is best-effort; the dir's existence IS the lock */
    }
    return lockDir;
  };
  try {
    return claim();
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      return true; // unexpected fs error → fail-open
    }
  }
  // Held: reclaim only if stale (dead holder, or older than the timeout).
  let owner = null;
  try {
    owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  } catch {
    owner = null; // no/unreadable owner metadata → treat as stale
  }
  const ageMs = owner && typeof owner.at === "number" ? Date.now() - owner.at : Infinity;
  const stale = !owner || ageMs > INSTALL_LOCK_STALE_MS || !isHolderAlive(owner.pid);
  if (!stale) {
    return false; // a fresh, live holder — defer to it
  }
  try {
    rmSync(lockDir, { recursive: true, force: true });
    return claim();
  } catch (err) {
    // Another session reclaimed/created it between our rm and claim → defer; any other error → fail-open.
    return Boolean(err && err.code === "EEXIST") ? false : true;
  }
}

/** Release a lock acquired by {@link acquireInstallLock} (no-op for the `true`/`false` sentinels). */
export function releaseInstallLock(lock) {
  if (typeof lock === "string") {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * True iff the engine's bare imports will resolve from `${pluginRoot}/scripts/` — i.e. the bridge is
 * either a real dev `node_modules` directory or a symlink that resolves to the data-dir deps. Lets an
 * install FAIL on a filesystem that can't create symlinks (some network/FAT/Docker mounts, Windows
 * without the privilege) instead of marking a permanently-unrunnable engine as "installed".
 */
export function bridgeReachable(rootNodeModules, depsNodeModules) {
  let stat;
  try {
    stat = lstatSync(rootNodeModules);
  } catch {
    return false; // nothing there — the bridge was never created
  }
  if (stat.isSymbolicLink()) {
    return pointsAtDeps(rootNodeModules, depsNodeModules);
  }
  return stat.isDirectory(); // a real dev node_modules — bare imports resolve here
}

async function main() {
  // `--check`: read-only install-state inspection for the /visual-setup consent gate. Prints the
  // computeInstallState() JSON to STDOUT and exits 0 — ALWAYS, even when the data dir can't be
  // resolved — so a mid-session Bash invocation never shows a hard error. Installs nothing.
  const checkOnly = process.argv.includes("--check");

  // Normally CLAUDE_PLUGIN_DATA; resolveDataDir falls back to the conventional path when it's absent
  // (command Bash mid-session, or the plugin was added mid-session so the SessionStart hook never ran).
  const dataDir = resolveDataDir();

  if (checkOnly) {
    // STDOUT (not stderr): the consent gate parses this. No install, no bridge, no fs writes.
    const sys = systemSupport();
    const repair = repairCommand();
    if (dataDir === null) {
      process.stdout.write(
        JSON.stringify({
          dataDir: null,
          installed: false,
          healthy: false,
          brokenNatives: [],
          systemSupported: sys.supported,
          systemIssues: sys.issues,
          repair,
          depsPresent: false,
          browserPresent: false,
          markerMatches: false,
          missing: ["deps", "browser", "marker"],
          engineDeps: ENGINE_DEPS,
          nativeRuntime: nativeRuntime(),
          browser: BROWSER_LABEL,
          reason:
            "CLAUDE_PLUGIN_DATA is not set and the data dir could not be resolved — treat as not installed.",
        }) + "\n",
      );
      process.exit(0);
    }
    const state = computeInstallState(dataDir);
    // computeInstallState is pure fs-existence; on its own it reported installed:true while the engine
    // was actually unloadable. Additionally LOAD-TEST the runtime tree (`${pluginRoot}/node_modules` —
    // what the scripts resolve) and surface `healthy` / `brokenNatives`, plus `systemSupported` and the
    // exact `repair` command, so a command's preflight can self-repair (run `repair`) or fail with a
    // user-actionable reason instead of crashing mid-run or improvising a wrong-tree `npm rebuild`.
    const brokenNatives = state.installed ? verifyNativeModules(pluginRoot, process.env) : [];
    const healthy = state.installed && brokenNatives.length === 0;
    // A single human-readable reason the agent can relay: system-unsupported wins (no rebuild fixes it),
    // else the broken-native explanation pointing at the repair command.
    let reason;
    if (!sys.supported) {
      reason = sys.issues.join(" ");
    } else if (state.installed && !healthy) {
      reason =
        `The engine's native bindings (${brokenNatives.join(", ")}) did not load for this runtime ` +
        `(Node ${process.version}, ${process.platform}/${process.arch}). Run \`${repair}\` to rebuild ` +
        `them in place (it repairs the tree the scripts load — do NOT npm rebuild a guessed directory).`;
    }
    process.stdout.write(
      JSON.stringify({
        ...state,
        healthy,
        brokenNatives,
        systemSupported: sys.supported,
        systemIssues: sys.issues,
        repair,
        ...(reason ? { reason } : {}),
      }) + "\n",
    );
    process.exit(0);
  }

  if (dataDir === null) {
    // A real install needs a target dir. If none could be resolved, guide the user rather than crash
    // with a raw error — a fresh session lets the SessionStart hook set CLAUDE_PLUGIN_DATA and install.
    console.error(
      "[visual-guard] Could not resolve the plugin data dir (CLAUDE_PLUGIN_DATA is not set). " +
        "Start a fresh session so the SessionStart hook can install the engine, or set CLAUDE_PLUGIN_DATA.",
    );
    process.exit(1);
  }

  const browsersDir = join(dataDir, "browsers");
  const markerPath = join(dataDir, "package.json"); // the diff marker
  const nodeModulesDir = join(dataDir, "node_modules");
  const playwrightBin = join(nodeModulesDir, ".bin", "playwright");
  const rootNodeModules = join(pluginRoot, "node_modules");
  const manifest = desiredManifest();

  // Re-assert the bridge link, but never let a benign link race / fs hiccup fail the hook: the
  // deps are installed and the commands' own preflight will report if the runner is unreachable.
  const refreshBridge = () => {
    try {
      ensureBridgeLink(rootNodeModules, nodeModulesDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[visual-guard] Could not link the engine into the plugin root: ${message}. ` +
          "If a command reports the runner is unreachable, retry in a fresh session.",
      );
    }
  };

  const isInstalled = () => {
    if (!existsSync(markerPath) || !existsSync(nodeModulesDir) || !existsSync(browsersDir)) {
      return false;
    }
    try {
      return readFileSync(markerPath, "utf8") === manifest;
    } catch {
      return false;
    }
  };

  // Chromium must resolve to the same path at install time and at capture time.
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir };

  // Fast path: already bootstrapped AND the native bindings load FROM THE TREE THE SCRIPTS USE. The
  // engine's `scripts/*.ts` resolve their imports from `${pluginRoot}/node_modules` (a real dir OR the
  // bridge symlink) — so THAT, not the data dir, is the tree we must load-test. Verifying the data dir
  // was the split-brain bug: a healthy data-dir copy let SessionStart no-op while the plugin-root copy
  // the scripts actually loaded was missing its `.node` (→ ERR_DLOPEN_FAILED, and a restart didn't fix
  // it). The marker's nativeRuntime fingerprint catches a Node/OS/arch/libc change; this re-verify
  // additionally catches a missing/corrupt/wrong-tree binary. Clean → re-assert the link and no-op.
  if (isInstalled()) {
    if (verifyNativeModules(pluginRoot, env).length === 0) {
      refreshBridge(); // self-heals a wiped/relocated link
      process.exit(0); // already bootstrapped — silent no-op
    }
    process.stderr.write(
      "[visual-guard] Engine is installed but its native bindings did not load — repairing…\n",
    );
  }

  // Serialize install/repair against a concurrent SessionStart so two hooks never `npm install` into
  // the same node_modules at once. Acquired AFTER the fast path so a healthy session never contends.
  const lock = acquireInstallLock(dataDir);
  if (lock === false) {
    process.stderr.write(
      "[visual-guard] Another session is setting up the engine — it will be ready shortly. " +
        "If a command reports the engine is missing, retry in a fresh session.\n",
    );
    process.exit(0);
  }

  const npm = resolveNpm();
  let exitCode = 0;
  // Track whether THIS run wrote the data-dir marker (a fresh install). A plugin-root-only repair
  // failure must NOT wipe a HEALTHY data-dir marker — doing so makes the next session redo a useless
  // full data-dir install and then hit the same plugin-root repair failure, looping every session.
  let markerWritten = false;
  try {
    // Re-check under the lock against the RUNTIME tree (`${pluginRoot}/node_modules` — what the
    // scripts load), not the data dir.
    if (isInstalled() && verifyNativeModules(pluginRoot, env).length === 0) {
      // Fully healthy — a holder we waited behind may have just finished. Just re-assert the link.
      refreshBridge();
    } else if (isInstalled()) {
      // Deps + browser ARE installed (marker matches) but the runtime tree's native bindings don't
      // load — the split-brain case: a REAL plugin-root `node_modules` whose better-sqlite3/sharp
      // binary is missing (shipped without its `.node`), or a bridged tree whose binary was deleted.
      // Repair the tree the scripts load from IN PLACE; no need to redo the npm install / Chromium.
      process.stderr.write("[visual-guard] Repairing the engine's native bindings in the plugin tree…\n");
      refreshBridge();
      await ensureNativeModules(pluginRoot, env);
    } else {
      mkdirSync(dataDir, { recursive: true });
      // The marker must exist for `npm install` to read it, but must NOT survive a failure of THIS
      // fresh install (tracked so the catch only wipes a marker this run created).
      writeFileSync(markerPath, manifest);
      markerWritten = true;

      process.stderr.write(
        "[visual-guard] Setting up the engine (one-time): runtime deps + a pinned Chromium " +
          `(~150 MB) → ${dataDir}\n`,
      );

      // `--include=optional` so sharp's `@img/sharp-*` platform package is never silently omitted (a
      // user/global npmrc `omit=optional` would otherwise drop it → a broken sharp). npm is pinned to
      // THIS Node (resolveNpm) so native addons build for the engine's ABI, not a different `npm`'s.
      await runStep(
        "▸ 1/2 Installing engine packages (npm)…",
        npm.command,
        [
          ...npm.prefix,
          "install",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          "--include=optional",
        ],
        { cwd: dataDir, env },
      );
      await runStep("▸ 2/2 Downloading Chromium (~150 MB)…", playwrightBin, ["install", "chromium"], {
        cwd: dataDir,
        env,
      });

      // Wire the deps to the plugin root FIRST, then load-test/repair the tree the scripts actually
      // resolve from (`${pluginRoot}/node_modules` — the bridge symlink OR a real dir). Verifying the
      // RUNTIME tree (not the data dir) is what closes the split-brain: npm can exit 0 with a binary
      // silently missing, and a real plugin-root copy may ship without its `.node` at all. Throws
      // (→ marker removed → retry) if unfixable.
      refreshBridge();
      if (!bridgeReachable(rootNodeModules, nodeModulesDir)) {
        throw new Error(
          "Could not link the engine into the plugin root (the data-dir filesystem may not support " +
            "symlinks). The bundled engine scripts cannot resolve their dependencies without this link.",
        );
      }
      await ensureNativeModules(pluginRoot, env);

      process.stderr.write("[visual-guard] Engine ready — deps + Chromium installed.\n");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (markerWritten) {
      // A fresh install failed — leave NO marker so the next session retries from a clean slate.
      rmSync(markerPath, { force: true });
      console.error(`[visual-guard] Dependency bootstrap failed: ${message}`);
      console.error("[visual-guard] Will retry on the next session.");
    } else {
      // A plugin-root native repair failed but the data-dir install is intact — KEEP its marker (so the
      // next session doesn't redo a useless full install) and just retry the in-place repair. This is
      // the unrepairable-plugin-tree case (offline + no prebuilt + no compiler, or a shipped tree
      // missing the package entirely): guide the user to reinstall the plugin rather than loop silently.
      console.error(`[visual-guard] Could not repair the engine's native bindings: ${message}`);
      console.error(
        "[visual-guard] If this persists, reinstall/update the plugin (`/plugin` → update visual-guard) " +
          "so its bundled tree is rebuilt for this machine.",
      );
    }
    exitCode = 1;
  } finally {
    releaseInstallLock(lock);
  }
  process.exit(exitCode);
}

// Run only when invoked directly (`node install-deps.mjs`), so the module can be imported by
// tests without triggering an install or a process.exit.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[visual-guard] Dependency bootstrap failed: ${message}`);
    process.exit(1);
  });
}
