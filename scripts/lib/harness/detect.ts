/**
 * Framework + scaffoldable-harness detection (pure). When a project has a component library but **no**
 * story explorer (the `component-library` projectKind in `lib/init.ts`), Visual Guard can scaffold one.
 * Which harness fits depends on the UI framework — Ladle for React, Histoire for Vue/Svelte — so this
 * module classifies the framework from the dependency names `scanDesignSystem()` already collects, then
 * maps it to the harness Visual Guard would scaffold.
 *
 * This is intentionally separate from `detectHarness` (lib/init.ts), which answers "is a harness already
 * PRESENT?" (and drives `classifyProjectKind`). This answers "what would we scaffold if none is present?"
 */

export type Framework = "react" | "vue" | "svelte" | "unknown";

/**
 * Classify the UI framework from a project's declared dependency names (deduped, any field). Precedence
 * is react → vue → svelte, so a meta-framework that bundles one (Next.js → react, Nuxt → vue) classifies
 * by its underlying renderer. `react-dom` is treated as React too (some setups list only it). Returns
 * "unknown" when none match — the caller falls back to Storybook (the framework-agnostic harness).
 */
export function detectFramework(deps: string[]): Framework {
  const set = new Set(deps);
  if (set.has("react") || set.has("react-dom")) {
    return "react";
  }
  if (set.has("vue")) {
    return "vue";
  }
  if (set.has("svelte")) {
    return "svelte";
  }
  return "unknown";
}

/** The story explorer Visual Guard would scaffold for a framework if the project has none. */
export type ScaffoldableHarness = "ladle" | "histoire" | "storybook";

/**
 * Pick the harness to scaffold for a framework: React → Ladle (lightest, near-zero-config), Vue/Svelte →
 * Histoire, anything else → Storybook (framework-agnostic). Only `ladle` is wired end-to-end in the MVP;
 * the others are surfaced so the wizard can guide the user (the actual scaffolders land in a later phase).
 */
export function pickHarnessFor(framework: Framework): ScaffoldableHarness {
  switch (framework) {
    case "react":
      return "ladle";
    case "vue":
    case "svelte":
      return "histoire";
    default:
      return "storybook";
  }
}
