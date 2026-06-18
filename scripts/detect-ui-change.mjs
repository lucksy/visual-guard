#!/usr/bin/env node
/**
 * Visual Guard — checkpoint hooks (T-18). One no-dep, non-blocking script with three modes:
 *
 *   • PostToolUse (matcher `Write|Edit`, default mode): read the tool-call payload on stdin,
 *     and if the edited file matches the project's `uiGlobs`, record it in
 *     `<project>/.visual-guard/pending.json`. **Detection only** — it never captures, never
 *     launches a browser, never imports the engine, and never blocks the user's turn (SPEC
 *     "Never do": no capture inside a PostToolUse hook). Full capture happens later, at the
 *     `/visual-check` checkpoint.
 *
 *   • Stop (`--nudge` mode): if `pending.json` is non-empty, emit a one-line `systemMessage`
 *     nudging the user to run `/visual-check`. It does NOT set `decision`/`continue`, so it
 *     never forces the agent to keep running or loop — a pure, ignorable nudge.
 *
 *   • `--clear` mode: empty the pending markers. The `/visual-check` command runs this after a
 *     successful checkpoint so the nudge resets — otherwise it would re-fire on every turn-end.
 *
 * Plain ESM with only Node builtins so it runs under a bare `node` with no install step (the
 * engine deps may not be bootstrapped yet, and a hook must be fast). The pure helpers and the
 * orchestrators are exported so they are unit-testable; `main` runs only when invoked directly.
 * Any unexpected error is swallowed and the process exits 0 — a detection hook must never break
 * the user's flow.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Fallback when no config resolves. MUST stay in lockstep with `DEFAULTS.uiGlobs` in
 * scripts/lib/config.ts — this hook runs no-dep under a bare `node` and cannot import the TS
 * config loader, so the value is duplicated by necessity. (resolveUiGlobs prefers a real config.)
 */
export const DEFAULT_UI_GLOBS = ["**/*.{tsx,jsx,vue,svelte}", "**/*.{css,scss,sass,less,styl,pcss}"];
const PENDING_VERSION = 1;
const NUDGE_FLAG = "--nudge";
const CLEAR_FLAG = "--clear";

// --- Glob matching (no-dep; mirrors report.ts globToRegExp) ---------------

function escapeLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** Convert a minimal glob (`**`, `*`, `?`, `{a,b}`) to an anchored RegExp. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += "[^]*"; // ** matches anything, including "/"
        i++;
        if (glob[i + 1] === "/") {
          i++; // consume the slash after **
        }
      } else {
        re += "[^/]*"; // * matches anything but "/"
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        continue;
      }
      re += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map(escapeLiteral)
        .join("|")})`;
      i = end;
    } else {
      re += escapeLiteral(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

/** Does `file` (a posix project-relative path) match any of the UI globs? */
export function matchesAnyGlob(file, globs) {
  const matchers = globs.map(globToRegExp);
  return matchers.some((matcher) => matcher.test(file));
}

// --- Path + config helpers ------------------------------------------------

/**
 * Make an edited file path project-relative + posix, for stable matching and storage. An
 * in-project file becomes a clean relative path (`src/Button.tsx`); a path outside the project
 * (or a non-string) is returned posix-normalized but otherwise unchanged — i.e. still absolute
 * or `../`-prefixed, which {@link isInProject} uses to recognize and skip it (an out-of-project
 * edit isn't a pending change for THIS project, and `**` globs would otherwise still match it).
 */
export function toProjectRelative(filePath, cwd) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return filePath;
  }
  const toPosix = (p) => p.split("\\").join("/");
  if (typeof cwd !== "string" || cwd.length === 0) {
    return toPosix(filePath);
  }
  const rel = relative(cwd, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return toPosix(filePath); // outside the project — keep as-is
  }
  return toPosix(rel);
}

/**
 * Is a {@link toProjectRelative} result inside the project? An in-project file is a clean
 * relative posix path; an out-of-project edit comes back absolute or `../`-prefixed.
 */
export function isInProject(rel) {
  return typeof rel === "string" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** The pending-markers file for a project root. */
export function pendingPathFor(cwd) {
  return join(cwd, ".visual-guard", "pending.json");
}

/**
 * Resolve the project's `uiGlobs`, using the SAME precedence as the `/visual-check` command
 * (visual-check.md): project `visual.config.json`, then `config/visual.config.json`, then the
 * bundled `${CLAUDE_PLUGIN_ROOT}/config/visual.config.json` — falling back to
 * {@link DEFAULT_UI_GLOBS} only when none resolves. Best-effort and never throws (a config read
 * failure must not break the hook). Kept in lockstep with the command so the detection hook
 * never tracks a different file set than the checkpoint it nudges toward.
 */
export function resolveUiGlobs(
  cwd,
  readFileImpl = readFileSync,
  existsImpl = existsSync,
  env = process.env,
) {
  const candidates = [join(cwd, "visual.config.json"), join(cwd, "config", "visual.config.json")];
  if (env && typeof env.CLAUDE_PLUGIN_ROOT === "string" && env.CLAUDE_PLUGIN_ROOT.length > 0) {
    candidates.push(join(env.CLAUDE_PLUGIN_ROOT, "config", "visual.config.json"));
  }
  for (const path of candidates) {
    try {
      if (!existsImpl(path)) {
        continue;
      }
      const parsed = JSON.parse(readFileImpl(path, "utf8"));
      const globs = parsed && parsed.uiGlobs;
      if (Array.isArray(globs) && globs.length > 0 && globs.every((g) => typeof g === "string")) {
        return globs;
      }
    } catch {
      // ignore — try the next candidate, then the defaults
    }
  }
  return DEFAULT_UI_GLOBS;
}

// --- Payload + pending-set logic (pure) -----------------------------------

/**
 * Parse a hook stdin payload into `{ toolName, filePath, cwd }`. Best-effort: returns null on
 * non-JSON / non-object input, and leaves any missing field undefined.
 */
export function parsePayload(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") {
    return null;
  }
  const input = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
  return {
    toolName: typeof data.tool_name === "string" ? data.tool_name : undefined,
    filePath: typeof input.file_path === "string" ? input.file_path : undefined,
    cwd: typeof data.cwd === "string" && data.cwd.length > 0 ? data.cwd : undefined,
  };
}

/** Read the pending set for a project (or an empty set when absent / malformed). */
export function readPending(
  pendingPath,
  { existsImpl = existsSync, readFileImpl = readFileSync } = {},
) {
  try {
    if (!existsImpl(pendingPath)) {
      return { version: PENDING_VERSION, files: [] };
    }
    const parsed = JSON.parse(readFileImpl(pendingPath, "utf8"));
    const files = Array.isArray(parsed && parsed.files)
      ? parsed.files.filter((f) => typeof f === "string")
      : [];
    return { version: PENDING_VERSION, files };
  } catch {
    return { version: PENDING_VERSION, files: [] };
  }
}

/** Merge new files into an existing pending set, de-duplicated and sorted (pure, deterministic). */
export function mergePending(existing, files) {
  const prior = Array.isArray(existing && existing.files)
    ? existing.files.filter((f) => typeof f === "string")
    : [];
  const merged = new Set([...prior, ...files]);
  return { version: PENDING_VERSION, files: [...merged].sort() };
}

/** The Stop-hook nudge message for a pending set, or null when nothing is pending. */
export function buildNudge(pending) {
  const files = Array.isArray(pending && pending.files) ? pending.files : [];
  if (files.length === 0) {
    return null;
  }
  const n = files.length;
  return (
    `Visual Guard: ${n} UI file${n === 1 ? "" : "s"} edited but not visually checked — ` +
    `run /visual-check before finishing.`
  );
}

// --- Orchestrators --------------------------------------------------------

/**
 * PostToolUse: record an edited UI file into the project's `pending.json`. Returns the updated
 * pending set, or null if the payload was junk / non-file / non-UI (nothing recorded). Detection
 * only — no capture, never blocks. fs ops are injectable for testing; defaults hit the real fs.
 */
export function runDetect(raw, env = process.env, io = {}) {
  const {
    readFileImpl = readFileSync,
    writeFileImpl = writeFileSync,
    mkdirImpl = mkdirSync,
    existsImpl = existsSync,
  } = io;

  const payload = parsePayload(raw);
  if (payload === null || !payload.filePath) {
    return null; // not a file-bearing tool call (the Write|Edit matcher already gates this)
  }
  const cwd = payload.cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const rel = toProjectRelative(payload.filePath, cwd);
  if (!isInProject(rel)) {
    return null; // an out-of-project edit isn't a pending change for THIS project
  }
  const globs = resolveUiGlobs(cwd, readFileImpl, existsImpl, env);
  if (!matchesAnyGlob(rel, globs)) {
    return null; // edited file isn't a tracked UI file
  }

  const pendingPath = pendingPathFor(cwd);
  const merged = mergePending(readPending(pendingPath, { existsImpl, readFileImpl }), [rel]);
  mkdirImpl(dirname(pendingPath), { recursive: true });
  writeFileImpl(pendingPath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/**
 * Stop: compute the nudge message for the project's pending set, or null when nothing's pending.
 * Reads `cwd` from the Stop payload (falling back to env / process.cwd). Read-only — it does not
 * itself clear pending.json; the `--clear` mode does that (the `/visual-check` checkpoint runs it
 * on success), so the nudge resets once the user actually runs a check.
 */
export function runNudge(raw, env = process.env, io = {}) {
  const { existsImpl = existsSync, readFileImpl = readFileSync } = io;
  let cwd;
  try {
    const data = JSON.parse(raw);
    if (data && typeof data.cwd === "string" && data.cwd.length > 0) {
      cwd = data.cwd;
    }
  } catch {
    // no usable payload — fall back below
  }
  cwd = cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return buildNudge(readPending(pendingPathFor(cwd), { existsImpl, readFileImpl }));
}

/**
 * Clear the project's pending markers — invoked by `/visual-check` after a successful checkpoint
 * so the Stop nudge resets (without it, the nudge would re-fire on every turn-end forever). No
 * stdin payload in this mode, so `cwd` comes from env / process.cwd. Best-effort: a missing file
 * is a no-op; never throws. Returns the path it targeted.
 */
export function runClear(env = process.env, io = {}) {
  const { existsImpl = existsSync, rmImpl = rmSync } = io;
  const cwd = env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const pendingPath = pendingPathFor(cwd);
  if (existsImpl(pendingPath)) {
    rmImpl(pendingPath, { force: true });
  }
  return pendingPath;
}

// --- CLI ------------------------------------------------------------------

/** Read all of stdin synchronously (fd 0); returns "" if stdin is unavailable. */
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function main(argv) {
  try {
    if (argv.includes(CLEAR_FLAG)) {
      runClear(); // /visual-check checkpoint: reset the pending markers (no stdin needed)
    } else if (argv.includes(NUDGE_FLAG)) {
      const message = runNudge(readStdin());
      if (message !== null) {
        // A top-level `systemMessage` surfaces to the user without blocking the stop or looping
        // the agent. Emitted on stdout with exit 0 — the documented non-intrusive nudge.
        process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
      }
    } else {
      runDetect(readStdin());
    }
  } catch {
    // A detection/nudge/clear hook must NEVER break the user's turn — swallow and exit clean.
  }
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2));
}
