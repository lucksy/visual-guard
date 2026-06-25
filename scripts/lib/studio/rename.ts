/**
 * Code-side rename/move detection (Component Studio v5 / F2). Pure — no I/O. Code identity is purely
 * name-derived (`<instance>/<name>` — there is no stable code id), so a rename looks like a delete + add.
 * This module re-pairs a "lost" key with a "gained" key ONLY behind a stable anchor:
 *   - the INSTANCE: within one code instance, exactly one key disappeared and exactly one appeared →
 *     an unambiguous rename (confidence 1.0). The instance is the anchor; 1↔1 is the uniqueness rule
 *     (mirroring match.ts's "a normalized match is only taken when EXACTLY ONE candidate is unused").
 *   - a NAME move across instances: a lost key and a single gained key with the SAME normalized name in
 *     a different instance → an ADVISORY "moved" candidate (confidence 0.5), surfaced, NEVER auto-applied.
 * Everything else is honest add/remove — a wrong silent pair is worse than an unmatched pair (F2/D7).
 */

import { normalize } from "./match";

export interface CodeKeyRef {
  /** Stable component key (`<instance>/<name>`). */
  key: string;
  instance: string;
  name: string;
}

export interface RenamePair {
  fromKey: string;
  toKey: string;
  fromName: string;
  toName: string;
  /** The instance of the `to` side (for a same-instance rename, both sides share it). */
  instance: string;
  /** 1.0 for an instance-anchored rename; 0.5 for an advisory cross-instance move. */
  confidence: number;
  anchor: "code-instance" | "fuzzy";
}

export interface CodeMappingDiff {
  /** Unambiguous, instance-anchored renames — safe to auto-apply (re-point the key, keep the id). */
  renames: RenamePair[];
  /** Advisory cross-instance "moved" candidates — surfaced for review, never auto-applied. */
  fuzzyCandidates: RenamePair[];
  /** Keys that genuinely appeared (no rename pairing). */
  added: string[];
  /** Keys that genuinely disappeared (no rename pairing). */
  removed: string[];
}

/**
 * Diff a prior code-key population against this run's fresh population, classifying each change as a
 * rename (instance-anchored, applied), an advisory move (cross-instance same-name, surfaced), or a plain
 * add/remove. Pure + deterministic (sorted outputs). The caller MUST only run this on a FULL sync — on a
 * `--target` subset the fresh set is partial, so every untouched key would falsely read as "removed".
 */
export function diffCodeMapping(
  prior: readonly CodeKeyRef[],
  fresh: readonly CodeKeyRef[],
): CodeMappingDiff {
  const freshKeys = new Set(fresh.map((f) => f.key));
  const priorKeys = new Set(prior.map((p) => p.key));
  const lost = prior.filter((p) => !freshKeys.has(p.key)); // existed before, gone now
  const gained = fresh.filter((f) => !priorKeys.has(f.key)); // newly appeared this run

  const renames: RenamePair[] = [];
  const usedLost = new Set<string>();
  const usedGained = new Set<string>();

  // 1) Same-instance, unambiguous 1↔1 → an applied rename (the instance is the stable anchor).
  const instances = [...new Set([...lost, ...gained].map((r) => r.instance))].sort();
  for (const inst of instances) {
    const lostI = lost.filter((r) => r.instance === inst);
    const gainedI = gained.filter((r) => r.instance === inst);
    if (lostI.length === 1 && gainedI.length === 1) {
      const from = lostI[0];
      const to = gainedI[0];
      if (from === undefined || to === undefined) continue;
      usedLost.add(from.key);
      usedGained.add(to.key);
      renames.push({
        fromKey: from.key,
        toKey: to.key,
        fromName: from.name,
        toName: to.name,
        instance: inst,
        confidence: 1,
        anchor: "code-instance",
      });
    }
  }

  // 2) Cross-instance same-name → an advisory "moved" candidate (unique pairing only, never applied).
  const fuzzyCandidates: RenamePair[] = [];
  for (const from of lost) {
    if (usedLost.has(from.key)) continue;
    const norm = normalize(from.name);
    const matches = gained.filter(
      (g) => !usedGained.has(g.key) && g.instance !== from.instance && normalize(g.name) === norm,
    );
    if (matches.length === 1) {
      const to = matches[0];
      if (to === undefined) continue;
      usedLost.add(from.key);
      usedGained.add(to.key);
      fuzzyCandidates.push({
        fromKey: from.key,
        toKey: to.key,
        fromName: from.name,
        toName: to.name,
        instance: to.instance,
        confidence: 0.5,
        anchor: "fuzzy",
      });
    }
  }

  const removed = lost
    .filter((r) => !usedLost.has(r.key))
    .map((r) => r.key)
    .sort();
  const added = gained
    .filter((r) => !usedGained.has(r.key))
    .map((r) => r.key)
    .sort();
  return { renames, fuzzyCandidates, added, removed };
}
