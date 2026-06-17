/**
 * Type declarations for the browser-loadable `view-model.js` (P4). Consumed by the `.ts` unit tests
 * (and any tooling); the browser loads the `.js` directly and ignores this file. Kept in lockstep with
 * `view-model.js`.
 */

export type BadgeKey = "in-sync" | "changed" | "figma-only" | "code-only" | "new";
export type BadgeTone = "green" | "amber" | "blue" | "gray" | "indigo";

export interface Badge {
  key: BadgeKey;
  label: string;
  tone: BadgeTone;
}

/** The subset of a `components` row the view-model reads (mirrors store.ts `ComponentRow`). */
export interface ComponentLike {
  name: string;
  key: string;
  figma_file_key?: string | null;
  figma_node_id?: string | null;
  code_instance?: string | null;
  code_target?: string | null;
  status?: string | null;
  parity_status?: string | null;
  updated_at?: string | null;
}

export interface VariantLike {
  source: "figma" | "code";
  name: string;
}

export interface VariantUnionEntry {
  name: string;
  inFigma: boolean;
  inCode: boolean;
  origin: "both" | "figma-only" | "code-only";
}

export interface SnapshotLike {
  id: number;
  version_seq: number;
  captured_at: string;
  git_sha?: string | null;
  figma_version_id?: string | null;
}

export interface TimelineTick {
  id: number;
  versionSeq: number;
  capturedAt: string;
  gitSha: string | null;
  figmaVersionId: string | null;
  isCurrent: boolean;
}

export interface BadgeCounts {
  all: number;
  "in-sync": number;
  changed: number;
  "figma-only": number;
  "code-only": number;
  new: number;
}

export function deriveBadge(component: ComponentLike): Badge;
export function isCodeRegressed(component: ComponentLike): boolean;
export function countByBadge(components: ComponentLike[]): BadgeCounts;
export function filterComponents(
  components: ComponentLike[],
  options?: { q?: string; badge?: string },
): ComponentLike[];
export function sortComponents(
  components: ComponentLike[],
  mode?: "urgency" | "name" | "recent",
): ComponentLike[];
export function variantUnion(variants: VariantLike[]): VariantUnionEntry[];
export function timelineTicks(snapshots: SnapshotLike[]): TimelineTick[];
export function freshness(iso: string | null | undefined, nowMs: number): string;
export function cardAriaLabel(component: ComponentLike, variantCount?: number): string;
export function figmaDeepLink(
  fileKey: string | null | undefined,
  nodeId: string | null | undefined,
): string | null;
export function storyLink(
  baseUrl: string | null | undefined,
  storyId: string | null | undefined,
): string | null;
export function livePreviewUrl(renderUrl: string | null | undefined): string | null;
