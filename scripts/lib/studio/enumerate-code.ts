import type { RenderTarget } from "../targets";
import { codeComponentKey } from "./keys";

/**
 * Group the engine's flat `RenderTarget[]` (one per story/route × state × viewport) into Studio code
 * components (Component Studio P2, SPEC §9.1). Pure — no I/O — so it is unit-tested with fixtures; the
 * sync CLI feeds it `resolveTargets(config)`. A component is `(instance, name)`; each distinct
 * `(state, viewport)` is one of its variants. The `key` matches `reindex`'s code key derivation, so a
 * sync writes to the same component rows a reindex would.
 */

export interface CodeVariant {
  state: string;
  viewport: number;
}

export interface CodeComponent {
  /** Stable component key — `codeComponentKey(instance, name)`, matching reindex. */
  key: string;
  instance: string;
  name: string;
  variants: CodeVariant[];
}

/** Group renders into components, deterministically ordered (by key; variants by state then viewport). */
export function groupCodeComponents(targets: RenderTarget[]): CodeComponent[] {
  const byKey = new Map<string, CodeComponent>();
  for (const target of targets) {
    const key = codeComponentKey(target.instance, target.name);
    let component = byKey.get(key);
    if (component === undefined) {
      component = { key, instance: target.instance, name: target.name, variants: [] };
      byKey.set(key, component);
    }
    const seen = component.variants.some(
      (v) => v.state === target.state && v.viewport === target.viewport,
    );
    if (!seen) {
      component.variants.push({ state: target.state, viewport: target.viewport });
    }
  }
  const components = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const component of components) {
    component.variants.sort((a, b) => a.state.localeCompare(b.state) || a.viewport - b.viewport);
  }
  return components;
}
