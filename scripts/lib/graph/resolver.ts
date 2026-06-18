import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import ts from "typescript";
import { extractCssSpecifiers, isCssFile } from "./css-imports";

/** Extensions probed when a specifier resolves to a file the TS resolver can't see (CSS/assets) or
 *  an extensionless path. Ordered TS-first so a real `.ts` wins over a same-named asset. */
const PROBE_EXTENSIONS = [
  ".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".sass", ".less", ".styl", ".pcss",
  ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
];

/** CSS-first probe order for a stylesheet `@import` target (so `@import './x'` prefers x.css). */
const CSS_PROBE_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl", ".pcss"];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a base path to an on-disk FILE the TS module resolver couldn't (a `.css`/asset, or an
 * extensionless path): the exact path if it's a file, else `base + <ext>`, else `base/index.<ext>`.
 * Returns the normalized file path, or null. This is what makes `./Button.css` / `@/styles/theme`
 * real graph edges instead of silent holes.
 */
function probeAsset(base: string, extensions: string[] = PROBE_EXTENSIONS): string | null {
  if (isFile(base)) return normalize(base);
  for (const ext of extensions) {
    if (isFile(base + ext)) return normalize(base + ext);
  }
  for (const ext of extensions) {
    const indexFile = join(base, `index${ext}`);
    if (isFile(indexFile)) return normalize(indexFile);
  }
  return null;
}

/**
 * Per-project module resolver for the change-scoped import graph (Phase 1). Wraps the TypeScript
 * compiler API to, for a single source file, EXTRACT its import specifiers and RESOLVE each to an
 * in-project file — honoring tsconfig `paths`/`baseUrl` — while treating node_modules as the graph
 * boundary (a third-party change is handled by lockfile→full sweep upstream, not by edges).
 *
 * Build ONE resolver per project root and reuse it: the shared `moduleResolutionCache` amortizes
 * node_modules failed-lookup churn (measured ~480ms→~9ms warm on a 24-file project), so a fresh
 * resolver per file would reintroduce that cost and could blow the cold-build budget.
 *
 * Cardinal-invariant care (CS-D2): `unresolvedOrDynamic` is the single signal that a file's import
 * set can't be fully trusted — a computed `import(expr)`/`require(expr)` (which `preProcessFile`
 * SILENTLY drops), a relative specifier that doesn't exist on disk, or an unresolvable alias. A
 * story reachable from such a file is marked graph-incomplete by the graph builder and is then
 * captured in every scoped run. Under-reporting this flag is the one thing that could let a scoped
 * run miss a render, so the dynamic-import AST scan is mandatory, never an optional fast-path.
 */

export interface FileImports {
  /** Absolute, normalized paths of in-project files this file imports (node_modules excluded). */
  resolved: string[];
  /** True when this file has an import the graph can't statically trust (see class doc). */
  unresolvedOrDynamic: boolean;
}

export interface Resolver {
  /** Extract + resolve `absFile`'s imports. Returns `{ resolved, unresolvedOrDynamic }`. */
  extractImports(absFile: string): FileImports;
  /** Whether a tsconfig was found for the project (false → the caller should not trust the graph). */
  tsconfigFound: boolean;
  /** Fingerprint of the resolution-affecting compiler options (tsconfig paths/baseUrl/moduleResolution
   *  + its `extends` chain). Used as the graph cache key — a change here invalidates ALL cached edges. */
  optionsHash: string;
}

/** Does the resolved file live inside a node_modules dir — a true third-party boundary? */
function livesInNodeModules(file: string): boolean {
  return file.split(/[\\/]/).includes("node_modules");
}

/** Is `file` inside `root`? Only an in-project file's key can be expressed cwd-relative to match git. */
function isUnderRoot(file: string, root: string): boolean {
  return file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Create a resolver for `projectRoot`. `readFile` is injected (matching the engine's seams) so the
 * extractor is testable without touching the real fs for the source text; module RESOLUTION uses
 * `ts.sys` (the real fs) because that is what the bundler/tsc would see.
 */
export function createResolver(
  projectRoot: string,
  readFile: (path: string) => string,
): Resolver {
  const tsconfigPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
  let options: ts.CompilerOptions = {};
  if (tsconfigPath !== undefined) {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    // `extends`, include/exclude, and path normalization are handled by parseJsonConfigFileContent.
    options = ts.parseJsonConfigFileContent(
      configFile.config ?? {},
      ts.sys,
      dirname(tsconfigPath),
    ).options;
  }

  const host: ts.ModuleResolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  const cache = ts.createModuleResolutionCache(projectRoot, (x) => x, options);
  const normalizedRoot = normalize(projectRoot);

  /** Manual `paths`/`baseUrl` substitution for specifiers the TS resolver returns "failed" for (an
   *  aliased `.css`, an extensionless alias). `matched` is true when the spec matched a paths
   *  PATTERN — so it is provably FIRST-PARTY and a miss must mark the importer incomplete, never
   *  external. `file` is the on-disk file (extension-probed), or null. */
  const pathsFallback = (spec: string): { matched: boolean; file: string | null } => {
    const paths = options.paths ?? {};
    const base = options.baseUrl ?? projectRoot;
    let matched = false;
    for (const [pattern, candidates] of Object.entries(paths)) {
      const star = pattern.indexOf("*");
      if (star === -1) {
        if (spec !== pattern) continue;
        matched = true;
        for (const candidate of candidates) {
          const file = probeAsset(resolve(base, candidate));
          if (file !== null) return { matched, file };
        }
        continue;
      }
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length) {
        matched = true;
        const middle = spec.slice(prefix.length, spec.length - suffix.length);
        for (const candidate of candidates) {
          const file = probeAsset(resolve(base, candidate.replace("*", middle)));
          if (file !== null) return { matched, file };
        }
      }
    }
    return { matched, file: null };
  };

  type SpecResult =
    | { kind: "edge"; file: string }
    | { kind: "external" }
    | { kind: "unresolved" };

  const resolveOne = (spec: string, fromFile: string): SpecResult => {
    const resolved = ts.resolveModuleName(spec, fromFile, options, host, cache).resolvedModule;
    if (resolved !== undefined) {
      const file = normalize(resolved.resolvedFileName);
      // A genuine third-party package (lives in node_modules) is the deliberate boundary.
      if (livesInNodeModules(file)) return { kind: "external" };
      // An in-project file is a real edge whose key matches git. A file resolved OUTSIDE the project
      // and NOT in node_modules — a workspace package that TS canonicalized to its real location, or
      // a sibling package — can't be expressed in git's path space, so we can't trust a scoped
      // decision about it: mark the importer incomplete (its story is captured every run), never a
      // silent drop. (Classifying by `isExternalLibraryImport` would wrongly drop such edges.)
      return isUnderRoot(file, normalizedRoot) ? { kind: "edge", file } : { kind: "unresolved" };
    }
    // The TS resolver only knows TS/JS extensions, so it "fails" on a real `./x.css` (and on an
    // extensionless `./theme` → theme.scss) exactly as on a missing `./typo`. Probe the disk: an
    // existing file is a real edge (the JS→CSS/asset edges Phase 1 needs); a miss is a genuine hole.
    if (spec.startsWith(".") || spec.startsWith("/")) {
      const file = probeAsset(resolve(dirname(fromFile), spec));
      return file !== null ? { kind: "edge", file } : { kind: "unresolved" };
    }
    // A bare specifier the TS resolver couldn't place. If it matched a tsconfig `paths` PATTERN it is
    // provably first-party — a hit is an edge, a MISS is a hole (incomplete), never external. If it
    // matched no pattern we STILL can't prove it's node_modules (it may be a bundler alias absent
    // from tsconfig), so be conservative and mark it unresolved → the importer is graph-incomplete →
    // its story is captured every run. Only a spec the TS resolver placed inside node_modules above
    // is treated as a true external boundary.
    const aliased = pathsFallback(spec);
    return aliased.file !== null ? { kind: "edge", file: aliased.file } : { kind: "unresolved" };
  };

  /**
   * Resolve a CSS `@import` / `@use` / `composes-from` specifier. Relative → fs-probe (CSS extensions
   * first, so `@import './x'` prefers x.css over a same-named x.ts); an aliased first-party path →
   * edge, or incomplete on a miss; a bare specifier → an npm/SCSS-builtin stylesheet (boundary).
   * `~pkg` is webpack's node_modules convention.
   */
  const resolveCssSpec = (spec: string, fromFile: string): SpecResult => {
    const value = spec.startsWith("~") ? spec.slice(1) : spec;
    if (value.startsWith(".") || value.startsWith("/")) {
      const file = probeAsset(resolve(dirname(fromFile), value), CSS_PROBE_EXTENSIONS);
      return file !== null ? { kind: "edge", file } : { kind: "unresolved" };
    }
    const aliased = pathsFallback(value);
    if (aliased.file !== null) return { kind: "edge", file: aliased.file };
    if (aliased.matched) return { kind: "unresolved" }; // first-party alias that didn't resolve
    // A non-dotted value: plain CSS / postcss-import resolve it relative to the stylesheet FIRST, so
    // fs-probe a sibling before treating it as a package (matches the JS branch's conservatism). A
    // path-shaped value (has a `/`) that still doesn't resolve is first-party-ish → incomplete, never
    // a silent drop. Only a single bare word (`normalize.css`, `sass:math`) is a real npm/builtin
    // boundary.
    const sibling = probeAsset(resolve(dirname(fromFile), value), CSS_PROBE_EXTENSIONS);
    if (sibling !== null) return { kind: "edge", file: sibling };
    return value.includes("/") ? { kind: "unresolved" } : { kind: "external" };
  };

  /** Extract + resolve a stylesheet's `@import`/`@use`/`@forward`/`composes` edges. */
  const extractCssImports = (absFile: string, text: string): FileImports => {
    const dot = absFile.lastIndexOf(".");
    const ext = dot >= 0 ? absFile.slice(dot) : "";
    const { specifiers, dynamic } = extractCssSpecifiers(text, ext);
    const resolved: string[] = [];
    let unresolvedOrDynamic = dynamic;
    for (const spec of specifiers) {
      const result = resolveCssSpec(spec, absFile);
      if (result.kind === "edge") resolved.push(result.file);
      else if (result.kind === "unresolved") unresolvedOrDynamic = true;
    }
    return { resolved, unresolvedOrDynamic };
  };

  /** A cheap AST visit that flags computed `import(expr)` / `require(expr)` — the cases
   *  preProcessFile silently omits. Gated behind a string pre-check so the ~majority of files
   *  with no dynamic syntax skip the second parse. */
  const hasComputedDynamic = (text: string): boolean => {
    // Pre-check: a dynamic import has `import(`; ANY `require` mention (incl. aliasing it to a
    // variable) is worth an AST look. ESM source without these skips the second parse.
    if (!text.includes("import(") && !text.includes("require")) return false;
    const source = ts.createSourceFile("__vg_probe__.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let dynamic = false;
    const visit = (node: ts.Node): void => {
      if (dynamic) return;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        const isRequireCall = ts.isIdentifier(callee) && callee.text === "require";
        if (isDynamicImport || isRequireCall) {
          const arg = node.arguments[0];
          if (arg === undefined || !ts.isStringLiteralLike(arg)) {
            dynamic = true;
            return;
          }
        }
      } else if (ts.isIdentifier(node) && node.text === "require") {
        // `require` used as a VALUE (`const r = require`, `module.require`, a param) — an indirect
        // require we can't statically follow. Not flagged when it's the direct callee of a
        // `require("literal")` (an edge preProcessFile already captured).
        const parent = node.parent;
        const isDirectCallee =
          parent !== undefined && ts.isCallExpression(parent) && parent.expression === node;
        if (!isDirectCallee) {
          dynamic = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return dynamic;
  };

  const extractImports = (absFile: string): FileImports => {
    let text: string;
    try {
      text = readFile(absFile);
    } catch {
      // Can't read the file (deleted/permission) → can't trust its imports → incomplete.
      return { resolved: [], unresolvedOrDynamic: true };
    }
    // A stylesheet's edges (@import / @use / composes) are invisible to the TS extractor — parse CSS.
    if (isCssFile(absFile)) {
      return extractCssImports(absFile, text);
    }
    const info = ts.preProcessFile(text, /* readImportFiles */ true, /* detectJavaScriptImports */ true);
    const resolved: string[] = [];
    let unresolvedOrDynamic = false;
    for (const ref of info.importedFiles) {
      const result = resolveOne(ref.fileName, absFile);
      if (result.kind === "edge") resolved.push(result.file);
      else if (result.kind === "unresolved") unresolvedOrDynamic = true;
    }
    if (!unresolvedOrDynamic && hasComputedDynamic(text)) unresolvedOrDynamic = true;
    return { resolved, unresolvedOrDynamic };
  };

  // Resolution-affecting config fingerprint (paths/baseUrl/moduleResolution come via parsed options,
  // which already fold in the `extends` chain) — the graph cache key.
  const optionsHash = createHash("sha1").update(JSON.stringify(options)).digest("hex");

  return { extractImports, tsconfigFound: tsconfigPath !== undefined, optionsHash };
}
