/**
 * Component-level Figma↔code matching (Component Studio P2, SPEC §9.2 / D7). Pure — no I/O. The
 * priority is: an explicit override map wins → an unambiguous normalized-name match → everything else
 * is surfaced (never silently dropped, never fuzzily guessed) as `figma-only` / `code-only`. An honest
 * "unmatched" beats a wrong silent pair in a design-system tool; the user fixes the rest via the
 * override map.
 */

export interface CodeRef {
  /** Stable component key (`<instance>/<name>`). */
  key: string;
  name: string;
}

export interface FigmaRef {
  nodeId: string;
  name: string;
  fileKey: string;
}

export interface MatchResult {
  matched: { code: CodeRef; figma: FigmaRef }[];
  codeOnly: CodeRef[];
  figmaOnly: FigmaRef[];
}

/** Fold a display name to a comparison key: lowercase, drop everything but [a-z0-9]. */
export function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Match `figma` components to `code` components. `overrides` maps a Figma component name to a code
 * component name (`config.figma.componentMap`). A normalized-name match is only taken when EXACTLY ONE
 * unused code component shares that normalized name (the false-positive guard: ambiguity is surfaced,
 * not guessed). Each code component is matched at most once. Output arrays are deterministically
 * ordered (figma by node id, code by key).
 */
export function matchComponents(
  code: CodeRef[],
  figma: FigmaRef[],
  overrides: Record<string, string> = {},
): MatchResult {
  const byExactName = new Map<string, CodeRef>();
  const byNorm = new Map<string, CodeRef[]>();
  for (const ref of code) {
    if (!byExactName.has(ref.name)) {
      byExactName.set(ref.name, ref);
    }
    const norm = normalize(ref.name);
    if (norm.length > 0) {
      const list = byNorm.get(norm);
      if (list) {
        list.push(ref);
      } else {
        byNorm.set(norm, [ref]);
      }
    }
  }

  const used = new Set<string>();
  const matched: { code: CodeRef; figma: FigmaRef }[] = [];
  const figmaOnly: FigmaRef[] = [];

  // Stable iteration so the result is deterministic regardless of input order.
  const figmaSorted = [...figma].sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  // TWO passes so override ALWAYS beats normalized-name (D7): a normalized match must never consume a
  // code component that an override needs. Pass 1 claims every override target; pass 2 normalized-matches
  // only the figma nodes that had no override.
  const withoutOverride: FigmaRef[] = [];
  for (const fig of figmaSorted) {
    const overrideTarget = overrides[fig.name];
    if (overrideTarget === undefined) {
      withoutOverride.push(fig);
      continue;
    }
    const exact = byExactName.get(overrideTarget);
    const claim = exact && !used.has(exact.key) ? exact : uniqueUnused(byNorm.get(normalize(overrideTarget)), used);
    if (claim) {
      used.add(claim.key);
      matched.push({ code: claim, figma: fig });
    } else {
      figmaOnly.push(fig); // an override pointing at nothing matchable is honest-unmatched, not fuzzy
    }
  }
  for (const fig of withoutOverride) {
    const claim = uniqueUnused(byNorm.get(normalize(fig.name)), used);
    if (claim) {
      used.add(claim.key);
      matched.push({ code: claim, figma: fig });
    } else {
      figmaOnly.push(fig);
    }
  }

  matched.sort((a, b) => a.figma.nodeId.localeCompare(b.figma.nodeId));
  figmaOnly.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const codeOnly = [...code]
    .filter((ref) => !used.has(ref.key))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { matched, codeOnly, figmaOnly };
}

/** The single unused candidate in `list`, or undefined if there are zero or more-than-one (ambiguous). */
function uniqueUnused(list: CodeRef[] | undefined, used: Set<string>): CodeRef | undefined {
  if (!list) {
    return undefined;
  }
  const available = list.filter((ref) => !used.has(ref.key));
  return available.length === 1 ? available[0] : undefined;
}
