#!/usr/bin/env node
/**
 * JS-eval sandbox runner (T-16e). Runs in a **child process** (under tsx, so `.ts` is supported) to
 * evaluate a project's `tailwind.config.{js,ts}` or a JS/TS theme module and print the theme as JSON
 * on stdout. It executes project code, which is why the feature is opt-in (`tokens.allowJsEval`) and
 * isolated here rather than imported into the engine process. argv: <targetFile> <mode>.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [, , target, mode] = process.argv;

/** Drop functions (Tailwind/theme values are sometimes closures) — they can't be serialized. */
function replacer(_key, value) {
  return typeof value === "function" ? undefined : value;
}

async function resolveTailwindTheme(config) {
  const base = (config && typeof config === "object" && config.theme) || {};
  try {
    const requireFromTarget = createRequire(pathToFileURL(target));
    const resolveConfigPath = requireFromTarget.resolve("tailwindcss/resolveConfig");
    const { default: resolveConfig } = await import(pathToFileURL(resolveConfigPath).href);
    const resolved = resolveConfig(config);
    if (resolved && resolved.theme) {
      return resolved.theme;
    }
  } catch {
    // tailwindcss not resolvable from the project — merge theme + theme.extend ourselves.
  }
  const { extend, ...rest } = base;
  return { ...rest, ...(extend && typeof extend === "object" ? extend : {}) };
}

async function main() {
  const mod = await import(pathToFileURL(target).href);
  const value = mod.default ?? mod.theme ?? mod;
  const result = mode === "tailwind-config" ? await resolveTailwindTheme(value) : value;
  process.stdout.write(JSON.stringify(result, replacer) ?? "null");
}

main().catch((err) => {
  process.stderr.write(err && err.message ? err.message : String(err));
  process.exit(1);
});
