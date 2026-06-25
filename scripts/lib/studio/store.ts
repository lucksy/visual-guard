import type { DB } from "./db";
import { diffVariantAxes, type VariantAxisDiff } from "./variant-axes";

/**
 * Component Studio store (SPEC §7): all reads/writes against an **injected** `better-sqlite3` handle,
 * so every function is unit-testable over an in-memory DB. No file I/O, no image decoding — callers
 * (the `studio.ts` CLI / the sync workflow) compute hashes/dims and hand them in.
 *
 * Writer invariants: `appendSnapshot` assigns a per-lane monotonic `version_seq` inside a
 * `BEGIN IMMEDIATE` transaction and appends a row **only when the sha256 differs** from the latest in
 * that lane — so the timeline has one tick per real visual change, never one per re-run. A lane is
 * `(component_id, variant_id, source)`; `variant_id IS NULL` is the default-variant lane.
 */

export type ComponentStatus = "same" | "changed" | "regression" | "new" | "error" | "unknown";
export type SnapshotSource = "figma" | "code" | "current";
export type VariantSource = "figma" | "code";
export type RegressionAxis = "current_vs_baseline" | "figma_vs_code";
export type RegressionStatus = "same" | "changed" | "regression" | "new" | "error";
export type SyncState = "synced" | "figma-pending" | "code-pending" | "error";

/**
 * Advisory presence/drift axis (v5). Orthogonal to {@link SyncState} (resumability) and
 * {@link ComponentStatus} (the CI-relevant code-regression axis): `lifecycle` records whether a
 * component is present on both sides, one side, was just removed, or was just renamed. Derived ONCE at
 * the sync/reindex rollup ({@link deriveLifecycle}); removal/rename are set explicitly. Never gates CI.
 */
export type ComponentLifecycle =
  | "matched"
  | "figma-only"
  | "code-only"
  | "removed"
  | "renamed"
  | "unknown";

export interface ComponentRow {
  id: number;
  key: string;
  name: string;
  description: string | null;
  figma_file_key: string | null;
  figma_node_id: string | null;
  code_instance: string | null;
  code_target: string | null;
  story_id: string | null;
  status: ComponentStatus;
  parity_status: ComponentStatus | null;
  sync_state: string;
  last_attempt_at: string | null;
  updated_at: string;
  /** v5 drift axis (advisory): presence/removed/renamed. */
  lifecycle: ComponentLifecycle;
  /** v5 (F4): JSON of the code side's prop/variant axes. Live-sync-only — NULL after a reindex. */
  code_props_json: string | null;
  /** v5 (F4): JSON of the Figma side's variant-axis labels. Durable via figma_meta.json. */
  figma_axes_json: string | null;
  /** v5 (F5): the Figma node's lastModified (ISO8601) the code side was last reconciled against. */
  figma_last_modified: string | null;
  /** v5 (F5): git sha the code side was last observed at. Live-sync-only — NULL after a reindex. */
  code_last_seen_sha: string | null;
}

export interface VariantRow {
  id: number;
  component_id: number;
  source: VariantSource;
  name: string;
  props_json: string | null;
  figma_node_id: string | null;
  story_id: string | null;
  /** Live harness preview URL this variant was captured from (v3, nullable) — drives the live-preview pane. */
  render_url: string | null;
}

export interface SnapshotRow {
  id: number;
  component_id: number;
  variant_id: number | null;
  source: SnapshotSource;
  image_path: string;
  image_hash: string;
  width: number | null;
  height: number | null;
  viewport: number | null;
  version_seq: number;
  captured_at: string;
  figma_version_id: string | null;
  git_sha: string | null;
  approved: number;
  /** v5 (F5): the Figma node's lastModified at capture (NULL for code/current snapshots). */
  figma_last_modified: string | null;
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

// --- Components -------------------------------------------------------------

export interface UpsertComponentInput {
  key: string;
  name: string;
  description?: string | null;
  figmaFileKey?: string | null;
  figmaNodeId?: string | null;
  codeInstance?: string | null;
  codeTarget?: string | null;
  storyId?: string | null;
  /** v5 (F4): the code side's prop/variant axes as JSON. COALESCE-merged like the other nullable fields. */
  codePropsJson?: string | null;
  /** v5 (F4): the Figma side's variant-axis labels as JSON. COALESCE-merged. */
  figmaAxesJson?: string | null;
  /** v5 (F5): the Figma node's lastModified (ISO8601). COALESCE-merged. */
  figmaLastModified?: string | null;
  /** v5 (F5): git sha the code side was last observed at. COALESCE-merged. */
  codeLastSeenSha?: string | null;
}

/**
 * Insert a component, or merge into the existing row with the same `key`. Linkage fields use COALESCE
 * (excluded → existing) so upserting the code side never wipes a previously-recorded Figma side and
 * vice versa — the basis for P2 matching. `name` is always taken from the latest write. The v5 drift
 * fields (props/axes/lastModified/sha) COALESCE-merge the same way; `lifecycle` is DELIBERATELY excluded
 * — it is derived once at the rollup ({@link setLifecycle}), never written by a per-side upsert, so a
 * figma-side and a code-side upsert can't clobber each other's lifecycle verdict. Returns the id.
 */
export function upsertComponent(db: DB, input: UpsertComponentInput): number {
  const row = db
    .prepare(
      `INSERT INTO components
         (key, name, description, figma_file_key, figma_node_id, code_instance, code_target, story_id,
          code_props_json, figma_axes_json, figma_last_modified, code_last_seen_sha)
       VALUES
         (@key, @name, @description, @figmaFileKey, @figmaNodeId, @codeInstance, @codeTarget, @storyId,
          @codePropsJson, @figmaAxesJson, @figmaLastModified, @codeLastSeenSha)
       ON CONFLICT(key) DO UPDATE SET
         name = excluded.name,
         description = COALESCE(excluded.description, components.description),
         figma_file_key = COALESCE(excluded.figma_file_key, components.figma_file_key),
         figma_node_id = COALESCE(excluded.figma_node_id, components.figma_node_id),
         code_instance = COALESCE(excluded.code_instance, components.code_instance),
         code_target = COALESCE(excluded.code_target, components.code_target),
         story_id = COALESCE(excluded.story_id, components.story_id),
         code_props_json = COALESCE(excluded.code_props_json, components.code_props_json),
         figma_axes_json = COALESCE(excluded.figma_axes_json, components.figma_axes_json),
         figma_last_modified = COALESCE(excluded.figma_last_modified, components.figma_last_modified),
         code_last_seen_sha = COALESCE(excluded.code_last_seen_sha, components.code_last_seen_sha),
         updated_at = ${NOW}
       RETURNING id`,
    )
    .get({
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      figmaFileKey: input.figmaFileKey ?? null,
      figmaNodeId: input.figmaNodeId ?? null,
      codeInstance: input.codeInstance ?? null,
      codeTarget: input.codeTarget ?? null,
      storyId: input.storyId ?? null,
      codePropsJson: input.codePropsJson ?? null,
      figmaAxesJson: input.figmaAxesJson ?? null,
      figmaLastModified: input.figmaLastModified ?? null,
      codeLastSeenSha: input.codeLastSeenSha ?? null,
    }) as { id: number };
  return row.id;
}

export function getComponentByKey(db: DB, key: string): ComponentRow | undefined {
  return db.prepare(`SELECT * FROM components WHERE key = ?`).get(key) as ComponentRow | undefined;
}

export function getComponentById(db: DB, id: number): ComponentRow | undefined {
  return db.prepare(`SELECT * FROM components WHERE id = ?`).get(id) as ComponentRow | undefined;
}

export interface ListFilter {
  status?: ComponentStatus;
  /** Case-insensitive substring matched against key + name + description. */
  q?: string;
  /** Resumable sync state (`synced` | `figma-pending` | `code-pending` | `error`). */
  syncState?: SyncState;
  /** Advisory figma↔code parity status; pass `null` to match rows with NO parity (no Figma link). */
  parity?: ComponentStatus | null;
  /** Require (true) / forbid (false) a Figma linkage. Omit to ignore. */
  hasFigma?: boolean;
  /** Require (true) / forbid (false) a code linkage. Omit to ignore. */
  hasCode?: boolean;
  /** v5 drift axis: `matched` | `figma-only` | `code-only` | `removed` | `renamed` | `unknown`. */
  lifecycle?: ComponentLifecycle;
}

/**
 * Build the shared `WHERE` for a {@link ListFilter} (status + literal name/key/description substring +
 * sync-state, parity, and has-figma/has-code facets, all AND-ed). `prefix` qualifies the columns (`""`
 * for a bare `components` query, `"c."` when components is aliased `c`). Every facet binds a parameter —
 * the search term is escaped to a literal substring, never a wildcard.
 */
function componentFilterSql(
  filter: ListFilter,
  prefix = "",
): { where: string; params: Record<string, unknown>; hasParams: boolean } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.status !== undefined) {
    clauses.push(`${prefix}status = @status`);
    params.status = filter.status;
  }
  if (filter.q !== undefined && filter.q.length > 0) {
    clauses.push(
      `(${prefix}key LIKE @q ESCAPE '\\' OR ${prefix}name LIKE @q ESCAPE '\\'` +
        ` OR ${prefix}description LIKE @q ESCAPE '\\')`,
    );
    // Escape LIKE metacharacters so q is a literal, case-insensitive substring (per this interface),
    // never a wildcard pattern. (The value is still bound, so this is about semantics, not injection.)
    const escaped = filter.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    params.q = `%${escaped}%`;
  }
  if (filter.syncState !== undefined) {
    clauses.push(`${prefix}sync_state = @syncState`);
    params.syncState = filter.syncState;
  }
  if (filter.parity !== undefined) {
    if (filter.parity === null) {
      clauses.push(`${prefix}parity_status IS NULL`);
    } else {
      clauses.push(`${prefix}parity_status = @parity`);
      params.parity = filter.parity;
    }
  }
  if (filter.hasFigma !== undefined) {
    clauses.push(`${prefix}figma_node_id IS ${filter.hasFigma ? "NOT NULL" : "NULL"}`);
  }
  if (filter.hasCode !== undefined) {
    clauses.push(`${prefix}code_target IS ${filter.hasCode ? "NOT NULL" : "NULL"}`);
  }
  if (filter.lifecycle !== undefined) {
    clauses.push(`${prefix}lifecycle = @lifecycle`);
    params.lifecycle = filter.lifecycle;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params, hasParams: clauses.length > 0 };
}

/** List components (optionally filtered by status and/or a name/key substring), ordered by key. */
export function listComponents(db: DB, filter: ListFilter = {}): ComponentRow[] {
  const { where, params, hasParams } = componentFilterSql(filter);
  const stmt = db.prepare(`SELECT * FROM components ${where} ORDER BY key`);
  return (hasParams ? stmt.all(params) : stmt.all()) as ComponentRow[];
}

/** Total component count — a cheap `COUNT(*)` for the health badge (never materializes the rows). */
export function countComponents(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM components`).get() as { n: number }).n;
}

/** Component rollup counts for `/api/summary` (SPEC §11.1) — the health dashboard. */
export interface StudioSummary {
  total: number;
  /** Code-regression axis (`components.status`) buckets. */
  byStatus: Record<ComponentStatus, number>;
  /** Resumable sync-state buckets. */
  bySyncState: Record<SyncState, number>;
  /** v5 drift-axis buckets (advisory) — powers the gallery's removed/renamed/figma-only counts. */
  byLifecycle: Record<ComponentLifecycle, number>;
  /** Presence buckets (Figma/code linkage) — the DS owner's at-a-glance parity coverage. */
  presence: { both: number; figmaOnly: number; codeOnly: number; neither: number };
}

/**
 * Bucketed rollups over the indexed `status`/`sync_state` columns + the figma/code linkage — three cheap
 * `GROUP BY`/`COUNT` scans, never materializing rows. This replaces the SPA's "fetch ALL components and
 * bucket client-side" pattern for the header metrics, so a hundreds-of-component library doesn't ship a
 * giant JSON just to draw counts.
 */
export function summaryCounts(db: DB): StudioSummary {
  const byStatus: Record<ComponentStatus, number> = {
    same: 0,
    changed: 0,
    regression: 0,
    new: 0,
    error: 0,
    unknown: 0,
  };
  for (const row of db
    .prepare(`SELECT status, COUNT(*) AS n FROM components GROUP BY status`)
    .all() as { status: ComponentStatus; n: number }[]) {
    if (row.status in byStatus) {
      byStatus[row.status] = row.n;
    }
  }
  const bySyncState: Record<SyncState, number> = {
    synced: 0,
    "figma-pending": 0,
    "code-pending": 0,
    error: 0,
  };
  for (const row of db
    .prepare(`SELECT sync_state, COUNT(*) AS n FROM components GROUP BY sync_state`)
    .all() as { sync_state: SyncState; n: number }[]) {
    if (row.sync_state in bySyncState) {
      bySyncState[row.sync_state] = row.n;
    }
  }
  const byLifecycle: Record<ComponentLifecycle, number> = {
    matched: 0,
    "figma-only": 0,
    "code-only": 0,
    removed: 0,
    renamed: 0,
    unknown: 0,
  };
  for (const row of db
    .prepare(`SELECT lifecycle, COUNT(*) AS n FROM components GROUP BY lifecycle`)
    .all() as { lifecycle: ComponentLifecycle; n: number }[]) {
    if (row.lifecycle in byLifecycle) {
      byLifecycle[row.lifecycle] = row.n;
    }
  }
  const presence = db
    .prepare(
      `SELECT
         SUM(CASE WHEN figma_node_id IS NOT NULL AND code_target IS NOT NULL THEN 1 ELSE 0 END) AS both,
         SUM(CASE WHEN figma_node_id IS NOT NULL AND code_target IS NULL THEN 1 ELSE 0 END) AS figmaOnly,
         SUM(CASE WHEN figma_node_id IS NULL AND code_target IS NOT NULL THEN 1 ELSE 0 END) AS codeOnly,
         SUM(CASE WHEN figma_node_id IS NULL AND code_target IS NULL THEN 1 ELSE 0 END) AS neither
       FROM components`,
    )
    .get() as { both: number | null; figmaOnly: number | null; codeOnly: number | null; neither: number | null };
  return {
    total: countComponents(db),
    byStatus,
    bySyncState,
    byLifecycle,
    presence: {
      both: presence.both ?? 0,
      figmaOnly: presence.figmaOnly ?? 0,
      codeOnly: presence.codeOnly ?? 0,
      neither: presence.neither ?? 0,
    },
  };
}

export interface ComponentWithThumbs extends ComponentRow {
  /** Latest figma snapshot id across variant lanes (the figma thumbnail), or null when none. */
  figma_snapshot_id: number | null;
  /** Code thumbnail id — newest live `current` render, else newest committed `code` baseline, or null. */
  code_snapshot_id: number | null;
  /** Variant count for the card chrome — the max of the figma/code per-source variant counts. */
  variant_count: number;
}

/**
 * List components enriched with everything a gallery card renders — the figma + code thumbnail snapshot
 * ids and the variant count — in ONE query (correlated subqueries), so the SPA never fans out a detail
 * request per card (the P4 thumbnail N+1). Same filter/order as {@link listComponents}. The code thumb
 * mirrors the detail view's "newest `current`, else newest `code`" choice.
 */
export function listComponentsWithThumbs(db: DB, filter: ListFilter = {}): ComponentWithThumbs[] {
  const { where, params, hasParams } = componentFilterSql(filter, "c.");
  const stmt = db.prepare(
    `SELECT c.*,
       (SELECT s.id FROM snapshots s
          WHERE s.component_id = c.id AND s.source = 'figma'
          ORDER BY s.captured_at DESC, s.id DESC LIMIT 1) AS figma_snapshot_id,
       (SELECT s.id FROM snapshots s
          WHERE s.component_id = c.id AND s.source IN ('current','code')
          ORDER BY (s.source = 'current') DESC, s.captured_at DESC, s.id DESC LIMIT 1) AS code_snapshot_id,
       COALESCE((SELECT MAX(cnt) FROM (
          SELECT COUNT(*) AS cnt FROM variants v WHERE v.component_id = c.id GROUP BY v.source
       )), 0) AS variant_count
     FROM components c
     ${where}
     ORDER BY c.key`,
  );
  return (hasParams ? stmt.all(params) : stmt.all()) as ComponentWithThumbs[];
}

// --- Usages (where a component is used) ------------------------------------

export type UsageKind = "code-import" | "figma-instance" | "route" | "story" | "doc";

export interface UsageRow {
  kind: UsageKind;
  used_in: string;
  detail: string | null;
}

export interface RecordUsageInput {
  componentId: number;
  kind: UsageKind;
  usedIn: string;
  detail?: string | null;
}

/**
 * Record where a component is used (the detail "Used in" panel). Idempotent on the natural key
 * `(component_id, kind, used_in)` via `INSERT OR IGNORE`, so a re-sync that re-observes the same usage
 * never duplicates a row. Returns true iff a new row was inserted.
 */
export function recordUsage(db: DB, input: RecordUsageInput): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO component_usages (component_id, kind, used_in, detail)
       VALUES (@componentId, @kind, @usedIn, @detail)`,
    )
    .run({
      componentId: input.componentId,
      kind: input.kind,
      usedIn: input.usedIn,
      detail: input.detail ?? null,
    });
  return info.changes > 0;
}

/**
 * A component's usages, **bounded** to `limit` rows (default 50, hard-capped at 500 so a caller can
 * never request an unbounded scan), ordered kind then used_in. Served by the UNIQUE(component_id,…)
 * index's component_id prefix.
 */
export function componentUsages(db: DB, componentId: number, limit = 50): UsageRow[] {
  const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  return db
    .prepare(
      `SELECT kind, used_in, detail FROM component_usages
       WHERE component_id = @componentId ORDER BY kind, used_in LIMIT @limit`,
    )
    .all({ componentId, limit: capped }) as UsageRow[];
}

/**
 * Reconcile a component's `story` usages to exactly `keepStates` — deletes any story usage whose
 * `used_in` is no longer rendered. Mirrors how the status rollup drops non-rendered lanes
 * ({@link recomputeStatus}'s `renderedLanes`), so a renamed/removed story doesn't leave a permanently
 * stale "Used in" entry. Only the `story` kind is touched. Returns how many stale rows were removed.
 */
export function pruneStoryUsages(db: DB, componentId: number, keepStates: string[]): number {
  if (keepStates.length === 0) {
    return db
      .prepare(`DELETE FROM component_usages WHERE component_id = ? AND kind = 'story'`)
      .run(componentId).changes;
  }
  const placeholders = keepStates.map(() => "?").join(", ");
  return db
    .prepare(
      `DELETE FROM component_usages WHERE component_id = ? AND kind = 'story'
         AND used_in NOT IN (${placeholders})`,
    )
    .run(componentId, ...keepStates).changes;
}

// --- Variants --------------------------------------------------------------

export interface UpsertVariantInput {
  componentId: number;
  source: VariantSource;
  name: string;
  propsJson?: string | null;
  figmaNodeId?: string | null;
  storyId?: string | null;
  /** Live harness preview URL (v3); COALESCE-merged like the other nullable fields. */
  renderUrl?: string | null;
}

/** Insert or merge a variant (unique per component+source+name). Returns the variant id. */
export function upsertVariant(db: DB, input: UpsertVariantInput): number {
  const row = db
    .prepare(
      `INSERT INTO variants (component_id, source, name, props_json, figma_node_id, story_id, render_url)
       VALUES (@componentId, @source, @name, @propsJson, @figmaNodeId, @storyId, @renderUrl)
       ON CONFLICT(component_id, source, name) DO UPDATE SET
         props_json = COALESCE(excluded.props_json, variants.props_json),
         figma_node_id = COALESCE(excluded.figma_node_id, variants.figma_node_id),
         story_id = COALESCE(excluded.story_id, variants.story_id),
         render_url = COALESCE(excluded.render_url, variants.render_url)
       RETURNING id`,
    )
    .get({
      componentId: input.componentId,
      source: input.source,
      name: input.name,
      propsJson: input.propsJson ?? null,
      figmaNodeId: input.figmaNodeId ?? null,
      storyId: input.storyId ?? null,
      renderUrl: input.renderUrl ?? null,
    }) as { id: number };
  return row.id;
}

/** A single variant by id (for mapping a snapshot back to its lane), or undefined if absent. */
export function getVariantById(db: DB, id: number): VariantRow | undefined {
  return db.prepare(`SELECT * FROM variants WHERE id = ?`).get(id) as VariantRow | undefined;
}

/** Variants for a component (optionally one source), ordered source then name. */
export function componentVariants(db: DB, componentId: number, source?: VariantSource): VariantRow[] {
  if (source !== undefined) {
    return db
      .prepare(
        `SELECT * FROM variants WHERE component_id = @componentId AND source = @source
         ORDER BY source, name`,
      )
      .all({ componentId, source }) as VariantRow[];
  }
  return db
    .prepare(`SELECT * FROM variants WHERE component_id = @componentId ORDER BY source, name`)
    .all({ componentId }) as VariantRow[];
}

// --- Snapshots (the timeline) ----------------------------------------------

export interface AppendSnapshotInput {
  componentId: number;
  /** NULL/undefined = the default-variant lane. */
  variantId?: number | null;
  source: SnapshotSource;
  imagePath: string;
  imageHash: string;
  width?: number | null;
  height?: number | null;
  viewport?: number | null;
  figmaVersionId?: string | null;
  gitSha?: string | null;
  approved?: boolean;
  /** v5 (F5): the Figma node's lastModified at capture (figma snapshots only). */
  figmaLastModified?: string | null;
}

export interface AppendSnapshotResult {
  id: number;
  versionSeq: number;
  /** false = the bytes were identical to the latest in the lane, so no new history row was added. */
  inserted: boolean;
}

export interface AppendSnapshotOptions {
  /** Max attempts on a cross-process UNIQUE(version_seq) collision (default 5). */
  maxRetries?: number;
  /**
   * Test seam (fault injection): invoked just before each INSERT attempt. Throwing a
   * SQLITE_CONSTRAINT_UNIQUE-shaped error here simulates a racing writer that grabbed the same
   * `version_seq`, so the retry path can be covered deterministically. Production callers omit it.
   */
  onBeforeInsert?: (attempt: number) => void;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

interface LatestRow {
  id: number;
  versionSeq: number;
  imageHash: string;
}

/**
 * Append a snapshot to its `(component, variant, source)` lane, content-hash deduped: if the latest
 * row in the lane already has this `imageHash`, no row is added and the existing one is returned
 * (`inserted: false`). Otherwise a new row is appended with `version_seq = max(lane)+1`, assigned
 * inside a `BEGIN IMMEDIATE` transaction so the read-then-insert is atomic against other writers.
 * A cross-process UNIQUE(version_seq) collision is retried (re-reading max) up to `maxRetries`.
 */
export function appendSnapshot(
  db: DB,
  input: AppendSnapshotInput,
  options: AppendSnapshotOptions = {},
): AppendSnapshotResult {
  const maxRetries = options.maxRetries ?? 5;
  const lane = {
    componentId: input.componentId,
    variantId: input.variantId ?? null,
    source: input.source,
  };

  const selectLatest = db.prepare(
    `SELECT id, version_seq AS versionSeq, image_hash AS imageHash FROM snapshots
     WHERE component_id = @componentId AND variant_id IS @variantId AND source = @source
     ORDER BY version_seq DESC LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO snapshots
       (component_id, variant_id, source, image_path, image_hash, width, height, viewport,
        version_seq, figma_version_id, git_sha, approved, figma_last_modified)
     VALUES
       (@componentId, @variantId, @source, @imagePath, @imageHash, @width, @height, @viewport,
        @versionSeq, @figmaVersionId, @gitSha, @approved, @figmaLastModified)`,
  );

  const attempt = db.transaction((attemptNo: number): AppendSnapshotResult => {
    const latest = selectLatest.get(lane) as LatestRow | undefined;
    if (latest && latest.imageHash === input.imageHash) {
      return { id: latest.id, versionSeq: latest.versionSeq, inserted: false };
    }
    const versionSeq = (latest?.versionSeq ?? 0) + 1;
    options.onBeforeInsert?.(attemptNo);
    const info = insert.run({
      componentId: input.componentId,
      variantId: input.variantId ?? null,
      source: input.source,
      imagePath: input.imagePath,
      imageHash: input.imageHash,
      width: input.width ?? null,
      height: input.height ?? null,
      viewport: input.viewport ?? null,
      versionSeq,
      figmaVersionId: input.figmaVersionId ?? null,
      gitSha: input.gitSha ?? null,
      approved: input.approved ? 1 : 0,
      figmaLastModified: input.figmaLastModified ?? null,
    });
    return { id: Number(info.lastInsertRowid), versionSeq, inserted: true };
  });

  let lastErr: unknown;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      return attempt.immediate(i);
    } catch (err) {
      if (isUniqueViolation(err)) {
        lastErr = err;
        continue; // a racing writer took this version_seq — re-read max and retry
      }
      throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("appendSnapshot: exhausted retries assigning version_seq");
}

/** A single snapshot by id (for `/api/snapshots/:id` + its image stream), or undefined if absent. */
export function getSnapshotById(db: DB, id: number): SnapshotRow | undefined {
  return db.prepare(`SELECT * FROM snapshots WHERE id = ?`).get(id) as SnapshotRow | undefined;
}

/** The latest snapshot in a lane (newest `version_seq`), or undefined if the lane is empty. */
export function latestSnapshot(
  db: DB,
  componentId: number,
  source: SnapshotSource,
  variantId: number | null = null,
): SnapshotRow | undefined {
  return db
    .prepare(
      `SELECT * FROM snapshots
       WHERE component_id = @componentId AND source = @source AND variant_id IS @variantId
       ORDER BY version_seq DESC LIMIT 1`,
    )
    .get({ componentId, source, variantId }) as SnapshotRow | undefined;
}

/**
 * The most recently captured snapshot of one source for a component, **across all variant lanes** (the
 * representative thumbnail for the detail view / parity card). Ordered by `captured_at` then `id` so the
 * newest append wins regardless of which variant lane it landed in (`version_seq` is per-lane, so it is
 * not a cross-lane recency key). Returns undefined when the component has no snapshot of that source.
 */
export function latestSnapshotForSource(
  db: DB,
  componentId: number,
  source: SnapshotSource,
): SnapshotRow | undefined {
  return db
    .prepare(
      `SELECT * FROM snapshots WHERE component_id = @componentId AND source = @source
       ORDER BY captured_at DESC, id DESC LIMIT 1`,
    )
    .get({ componentId, source }) as SnapshotRow | undefined;
}

/** A component's timeline, newest-first. Optionally restricted to one source. */
export function componentTimeline(
  db: DB,
  componentId: number,
  source?: SnapshotSource,
): SnapshotRow[] {
  if (source !== undefined) {
    return db
      .prepare(
        `SELECT * FROM snapshots WHERE component_id = @componentId AND source = @source
         ORDER BY version_seq DESC`,
      )
      .all({ componentId, source }) as SnapshotRow[];
  }
  return db
    .prepare(
      `SELECT * FROM snapshots WHERE component_id = @componentId ORDER BY source, version_seq DESC`,
    )
    .all({ componentId }) as SnapshotRow[];
}

export function countSnapshots(db: DB, source?: SnapshotSource): number {
  if (source !== undefined) {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM snapshots WHERE source = ?`).get(source) as { n: number }
    ).n;
  }
  return (db.prepare(`SELECT COUNT(*) AS n FROM snapshots`).get() as { n: number }).n;
}

// --- Comparisons + status rollup -------------------------------------------

export interface RecordComparisonInput {
  componentId: number;
  axis: RegressionAxis;
  fromSnapshot: number;
  toSnapshot: number;
  diffRatio?: number | null;
  /** Advisory conformance breakdown (figma_vs_code only): relative size delta 0..1. */
  dimensionDelta?: number | null;
  /** Advisory conformance breakdown (figma_vs_code only): perceptual color delta 0..1. */
  paletteDelta?: number | null;
  status: RegressionStatus;
}

/** Append a comparison (regression/conformance) row. Returns its id. */
export function recordComparison(db: DB, input: RecordComparisonInput): number {
  const info = db
    .prepare(
      `INSERT INTO regressions
         (component_id, axis, from_snapshot, to_snapshot, diff_ratio, dimension_delta, palette_delta, status)
       VALUES
         (@componentId, @axis, @fromSnapshot, @toSnapshot, @diffRatio, @dimensionDelta, @paletteDelta, @status)`,
    )
    .run({
      componentId: input.componentId,
      axis: input.axis,
      fromSnapshot: input.fromSnapshot,
      toSnapshot: input.toSnapshot,
      diffRatio: input.diffRatio ?? null,
      dimensionDelta: input.dimensionDelta ?? null,
      paletteDelta: input.paletteDelta ?? null,
      status: input.status,
    });
  return Number(info.lastInsertRowid);
}

/**
 * A comparison row enriched with the variant lane of its `to` snapshot (so the detail view can match a
 * regression to the variant tab the user is on). `dimension_delta`/`palette_delta` are non-null only on
 * the advisory `figma_vs_code` axis (v4).
 */
export interface RegressionRow {
  id: number;
  component_id: number;
  axis: RegressionAxis;
  from_snapshot: number;
  to_snapshot: number;
  diff_ratio: number | null;
  dimension_delta: number | null;
  palette_delta: number | null;
  status: RegressionStatus;
  computed_at: string;
  /** Variant lane of the `to` snapshot (NULL = default lane). */
  variant_id: number | null;
}

const REGRESSION_SELECT = `SELECT r.id, r.component_id, r.axis, r.from_snapshot, r.to_snapshot,
       r.diff_ratio, r.dimension_delta, r.palette_delta, r.status, r.computed_at,
       s.variant_id AS variant_id
     FROM regressions r JOIN snapshots s ON s.id = r.to_snapshot`;

/**
 * The most recent comparison on one axis for a component (newest by `computed_at`, then `id`), or
 * undefined when none recorded. Served by `idx_regressions_component_axis`. This is the row the detail
 * view reads to show the pixel-diff magnitude (`current_vs_baseline`) or the conformance breakdown
 * (`figma_vs_code`) — data the engine already computes but the UI never surfaced before v4.
 */
export function latestRegression(
  db: DB,
  componentId: number,
  axis: RegressionAxis,
): RegressionRow | undefined {
  return db
    .prepare(
      `${REGRESSION_SELECT}
       WHERE r.component_id = @componentId AND r.axis = @axis
       ORDER BY r.computed_at DESC, r.id DESC LIMIT 1`,
    )
    .get({ componentId, axis }) as RegressionRow | undefined;
}

/**
 * A component's comparison history on one axis, newest-first, **bounded** to `limit` rows (default 100,
 * hard-capped at 500). Powers the drift sparkline — the append-only `regressions` table already records a
 * `diff_ratio` per real change, so this is a pure read over the existing index. The caller reverses to
 * oldest→newest for the chart.
 */
export function componentRegressions(
  db: DB,
  componentId: number,
  axis: RegressionAxis,
  limit = 100,
): RegressionRow[] {
  const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  return db
    .prepare(
      `${REGRESSION_SELECT}
       WHERE r.component_id = @componentId AND r.axis = @axis
       ORDER BY r.computed_at DESC, r.id DESC LIMIT @limit`,
    )
    .all({ componentId, axis, limit: capped }) as RegressionRow[];
}

function latestRegressionStatus(
  db: DB,
  componentId: number,
  axis: RegressionAxis,
): RegressionStatus | undefined {
  const row = db
    .prepare(
      `SELECT status FROM regressions WHERE component_id = @componentId AND axis = @axis
       ORDER BY computed_at DESC, id DESC LIMIT 1`,
    )
    .get({ componentId, axis }) as { status: RegressionStatus } | undefined;
  return row?.status;
}

/** Worst-first precedence for rolling per-lane statuses into one component status. */
const STATUS_RANK: Record<RegressionStatus, number> = {
  regression: 5,
  error: 4,
  changed: 3,
  new: 2,
  same: 1,
};

/**
 * Recompute and persist a component's denormalized rollup. `status` (the code regression axis) is the
 * **worst** of the LATEST `current_vs_baseline` result per variant lane — so a component with any
 * regressed variant reads `regression`, not whichever variant was compared last. With no comparison
 * yet (e.g. straight after a reindex, which records baselines but runs no diff) it is `unknown`, the
 * honest schema default — we deliberately do NOT reuse `new` ("no baseline") for an indexed component.
 * `parity_status` (advisory) is the latest `figma_vs_code` result, or NULL when there is none. P4
 * derives the user-facing In-sync/Changed/Figma-only/Code-only/New badges from presence + this column.
 *
 * `renderedLanes` (the variant ids a sync just (re)captured) scopes the rollup to LIVE lanes: a lane
 * for a variant that no longer renders (e.g. a deleted story) is excluded, so its stale verdict can't
 * pin the component at `regression` forever. Omit it (reindex / figma record) to roll up every lane.
 */
export function recomputeStatus(
  db: DB,
  componentId: number,
  renderedLanes?: ReadonlySet<number | null>,
): ComponentStatus {
  // The latest current_vs_baseline comparison per lane (variant of the compared `to` snapshot).
  const rows = db
    .prepare(
      `SELECT s.variant_id AS variantId, r.status AS status, r.id AS id
       FROM regressions r JOIN snapshots s ON s.id = r.to_snapshot
       WHERE r.component_id = @componentId AND r.axis = 'current_vs_baseline'`,
    )
    .all({ componentId }) as { variantId: number | null; status: RegressionStatus; id: number }[];

  const latestPerLane = new Map<number | null, { status: RegressionStatus; id: number }>();
  for (const row of rows) {
    if (renderedLanes !== undefined && !renderedLanes.has(row.variantId)) {
      continue; // a lane that wasn't rendered this cycle is stale — don't let it pin the status
    }
    const prev = latestPerLane.get(row.variantId);
    if (prev === undefined || row.id > prev.id) {
      latestPerLane.set(row.variantId, { status: row.status, id: row.id });
    }
  }

  let status: ComponentStatus = "unknown";
  let bestRank = 0;
  for (const { status: laneStatus } of latestPerLane.values()) {
    const rank = STATUS_RANK[laneStatus];
    if (rank > bestRank) {
      bestRank = rank;
      status = laneStatus;
    }
  }

  const parity = latestRegressionStatus(db, componentId, "figma_vs_code") ?? null;

  db.prepare(
    `UPDATE components SET status = @status, parity_status = @parity, updated_at = ${NOW}
     WHERE id = @id`,
  ).run({ status, parity, id: componentId });
  return status;
}

/**
 * Recompute ONLY the advisory `parity_status` (the latest `figma_vs_code` verdict), leaving the code
 * axis `components.status` untouched. This is what the conformance pass uses (SPEC §14): scoring
 * Figma↔code parity must never move the CI-relevant code axis. Unlike {@link recomputeStatus}, it does
 * NOT re-derive `status` from `current_vs_baseline` lanes — so a stale, non-rendered code lane can't be
 * resurrected by a conformance run. Returns the new parity status (or null when none recorded).
 */
export function recomputeParity(db: DB, componentId: number): ComponentStatus | null {
  const parity = latestRegressionStatus(db, componentId, "figma_vs_code") ?? null;
  db.prepare(`UPDATE components SET parity_status = @parity, updated_at = ${NOW} WHERE id = @id`).run({
    parity,
    id: componentId,
  });
  return parity;
}

/**
 * Set a component's resumable {@link SyncState} (SPEC §9.5) and stamp `last_attempt_at`. A re-run of
 * `/visual-sync` retries only the non-`synced` rows — e.g. a figma-linked component left
 * `figma-pending` because the Figma desktop app was closed mid-run is resumed next time.
 */
export function setSyncState(db: DB, componentId: number, state: SyncState): void {
  db.prepare(
    `UPDATE components SET sync_state = @state, last_attempt_at = ${NOW}, updated_at = ${NOW}
     WHERE id = @id`,
  ).run({ state, id: componentId });
}

/** Link a component (by key) to a Figma node without touching its name/code fields. No-op if absent. */
export function setFigmaLink(db: DB, componentKey: string, fileKey: string, nodeId: string): void {
  db.prepare(
    `UPDATE components SET figma_file_key = @fileKey, figma_node_id = @nodeId, updated_at = ${NOW}
     WHERE key = @key`,
  ).run({ key: componentKey, fileKey, nodeId });
}

/**
 * Mark every figma-LINKED component that has no Figma snapshot as `figma-pending` (SPEC §9.5) — the
 * resumable state for "the design is expected but wasn't captured" (Figma app closed mid-run, or a
 * node's screenshot failed). Idempotent; returns how many rows were flipped. A subsequent sync with
 * Figma open captures the design and a re-run flips them back to `synced`.
 */
export function markFigmaPending(db: DB): number {
  const info = db
    .prepare(
      `UPDATE components SET sync_state = 'figma-pending', updated_at = ${NOW}
       WHERE figma_file_key IS NOT NULL
         AND id NOT IN (SELECT DISTINCT component_id FROM snapshots WHERE source = 'figma')
         AND sync_state != 'figma-pending'`,
    )
    .run();
  return info.changes;
}

/** The status of the latest current_vs_baseline comparison in a lane, or undefined if none. */
export function latestLaneStatus(
  db: DB,
  componentId: number,
  variantId: number | null,
): RegressionStatus | undefined {
  const row = db
    .prepare(
      `SELECT r.status AS status FROM regressions r JOIN snapshots s ON s.id = r.to_snapshot
       WHERE r.component_id = @componentId AND r.axis = 'current_vs_baseline'
         AND s.variant_id IS @variantId
       ORDER BY r.id DESC LIMIT 1`,
    )
    .get({ componentId, variantId }) as { status: RegressionStatus } | undefined;
  return row?.status;
}

// --- Drift / maintenance layer (v5; ALL advisory — never moves components.status / the CI gate) -------

/**
 * Derive the presence-based {@link ComponentLifecycle} from a row's Figma/code linkage. This is the ONLY
 * place lifecycle is computed from presence; `removed` is set explicitly by {@link markRemovedCode} and
 * is intentionally NOT produced here (so a rollup over a returned component resurrects it to its real
 * presence state). Pure.
 */
export function deriveLifecycle(row: {
  figma_node_id: string | null;
  code_target: string | null;
}): ComponentLifecycle {
  const hasFigma = row.figma_node_id !== null;
  const hasCode = row.code_target !== null;
  if (hasFigma && hasCode) return "matched";
  if (hasFigma) return "figma-only";
  if (hasCode) return "code-only";
  return "unknown";
}

/** Set a component's advisory {@link ComponentLifecycle}. */
export function setLifecycle(db: DB, componentId: number, lifecycle: ComponentLifecycle): void {
  db.prepare(`UPDATE components SET lifecycle = @lifecycle, updated_at = ${NOW} WHERE id = @id`).run({
    lifecycle,
    id: componentId,
  });
}

/**
 * Recompute and persist a component's lifecycle from its current presence ({@link deriveLifecycle}). The
 * single centralized rollup point — called for each TOUCHED component during sync/reindex so no per-side
 * upsert ever writes lifecycle. Resurrects a previously-`removed` component that has reappeared. Returns
 * the new lifecycle (or `unknown` if the component is gone).
 */
export function rollupLifecycle(db: DB, componentId: number): ComponentLifecycle {
  const row = getComponentById(db, componentId);
  if (row === undefined) return "unknown";
  const lifecycle = deriveLifecycle(row);
  setLifecycle(db, componentId, lifecycle);
  return lifecycle;
}

/** Stamp the Figma node lastModified the code side was last reconciled against (F5 staleness input). */
export function setFigmaLastModified(db: DB, componentId: number, iso: string | null): void {
  db.prepare(
    `UPDATE components SET figma_last_modified = @iso, updated_at = ${NOW} WHERE id = @id`,
  ).run({ iso, id: componentId });
}

/** Stamp the git sha the code side was last observed at (F5; live-sync-only). */
export function setCodeLastSeenSha(db: DB, componentId: number, sha: string | null): void {
  db.prepare(
    `UPDATE components SET code_last_seen_sha = @sha, updated_at = ${NOW} WHERE id = @id`,
  ).run({ sha, id: componentId });
}

// --- F1: durable figma-node <-> code-component link mirror ----------------------------------------

export interface FigmaCodeLinkRow {
  id: number;
  figma_file_key: string;
  figma_node_id: string;
  component_key: string;
  source: "override" | "auto" | "manual";
  linked_at: string;
}

export interface RecordFigmaCodeLinkInput {
  figmaFileKey: string;
  figmaNodeId: string;
  componentKey: string;
  /** How the link was established (default `auto`, i.e. name-matched). */
  source?: "override" | "auto" | "manual";
}

/**
 * Record (or re-point) the explicit edge from a Figma node to a code component key. Upserts on the
 * node's natural key `(figma_file_key, figma_node_id)`, so re-linking a node to a different component
 * replaces the edge rather than duplicating it. A durable mirror of the mapping that primarily lives in
 * `figma_meta.json`'s `codeKey` (F1).
 */
export function recordFigmaCodeLink(db: DB, input: RecordFigmaCodeLinkInput): void {
  db.prepare(
    `INSERT INTO figma_code_links (figma_file_key, figma_node_id, component_key, source)
     VALUES (@figmaFileKey, @figmaNodeId, @componentKey, @source)
     ON CONFLICT(figma_file_key, figma_node_id) DO UPDATE SET
       component_key = excluded.component_key,
       source = excluded.source,
       linked_at = ${NOW}`,
  ).run({
    figmaFileKey: input.figmaFileKey,
    figmaNodeId: input.figmaNodeId,
    componentKey: input.componentKey,
    source: input.source ?? "auto",
  });
}

/** The code component a Figma node is linked to, or undefined when the node has no recorded edge. */
export function linkForFigmaNode(
  db: DB,
  fileKey: string,
  nodeId: string,
): FigmaCodeLinkRow | undefined {
  return db
    .prepare(`SELECT * FROM figma_code_links WHERE figma_file_key = ? AND figma_node_id = ?`)
    .get(fileKey, nodeId) as FigmaCodeLinkRow | undefined;
}

// --- F5: per-sync population snapshots + "new since last sync" delta -------------------------------

export interface PopulationSnapshotRow {
  id: number;
  captured_at: string;
  total: number;
  figma_count: number;
  code_count: number;
  both_count: number;
  /** JSON array of component keys present on the Figma side at capture. */
  figma_keys: string;
  /** JSON array of component keys present on the code side at capture. */
  code_keys: string;
}

/**
 * Record the current component population (the key sets present on each side) as one append-only
 * snapshot, so a later sync can set-diff the two newest rows into "N new since last sync". Returns the
 * new snapshot id. History — does not survive a reindex (which records one fresh baseline point).
 */
export function recordPopulationSnapshot(db: DB): number {
  const figmaKeys = (
    db
      .prepare(`SELECT key FROM components WHERE figma_node_id IS NOT NULL ORDER BY key`)
      .all() as { key: string }[]
  ).map((r) => r.key);
  const codeKeys = (
    db
      .prepare(`SELECT key FROM components WHERE code_target IS NOT NULL ORDER BY key`)
      .all() as { key: string }[]
  ).map((r) => r.key);
  const both = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM components WHERE figma_node_id IS NOT NULL AND code_target IS NOT NULL`,
      )
      .get() as { n: number }
  ).n;
  const info = db
    .prepare(
      `INSERT INTO population_snapshots (total, figma_count, code_count, both_count, figma_keys, code_keys)
       VALUES (@total, @figma, @code, @both, @figmaKeys, @codeKeys)`,
    )
    .run({
      total: countComponents(db),
      figma: figmaKeys.length,
      code: codeKeys.length,
      both,
      figmaKeys: JSON.stringify(figmaKeys),
      codeKeys: JSON.stringify(codeKeys),
    });
  return Number(info.lastInsertRowid);
}

/** The newest population snapshot, or undefined when none recorded. */
export function latestPopulationSnapshot(db: DB): PopulationSnapshotRow | undefined {
  return db
    .prepare(`SELECT * FROM population_snapshots ORDER BY captured_at DESC, id DESC LIMIT 1`)
    .get() as PopulationSnapshotRow | undefined;
}

/** The second-newest population snapshot (the baseline for a delta), or undefined when <2 exist. */
export function previousPopulationSnapshot(db: DB): PopulationSnapshotRow | undefined {
  return db
    .prepare(`SELECT * FROM population_snapshots ORDER BY captured_at DESC, id DESC LIMIT 1 OFFSET 1`)
    .get() as PopulationSnapshotRow | undefined;
}

export interface PopulationDelta {
  /** Component keys newly present on the Figma side since the previous snapshot. */
  newFigma: string[];
  /** Component keys newly present on the code side since the previous snapshot. */
  newCode: string[];
  /** Component keys no longer present on the Figma side since the previous snapshot. */
  removedFigma: string[];
  /** Component keys no longer present on the code side since the previous snapshot. */
  removedCode: string[];
}

const EMPTY_DELTA: PopulationDelta = { newFigma: [], newCode: [], removedFigma: [], removedCode: [] };

function parseKeySet(json: string): Set<string> {
  try {
    const parsed = JSON.parse(json);
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    return new Set();
  }
}

/**
 * The "since last sync" delta: set-diff the two newest population snapshots. Returns all-empty when
 * fewer than two snapshots exist (no prior point to compare against — the honest "no delta yet").
 */
export function populationDelta(db: DB): PopulationDelta {
  const cur = latestPopulationSnapshot(db);
  const prev = previousPopulationSnapshot(db);
  if (cur === undefined || prev === undefined) return { ...EMPTY_DELTA };
  const curF = parseKeySet(cur.figma_keys);
  const prevF = parseKeySet(prev.figma_keys);
  const curC = parseKeySet(cur.code_keys);
  const prevC = parseKeySet(prev.code_keys);
  const diff = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => !b.has(x)).sort();
  return {
    newFigma: diff(curF, prevF),
    newCode: diff(curC, prevC),
    removedFigma: diff(prevF, curF),
    removedCode: diff(prevC, curC),
  };
}

// --- F2: rename / move events ---------------------------------------------------------------------

export type RenameSide = "figma" | "code";
export type RenameAnchor = "figma-node-id" | "code-instance" | "fuzzy";
export type RenameResolution = "applied" | "surfaced";

export interface RenameEventInput {
  side: RenameSide;
  componentId?: number | null;
  figmaFileKey?: string | null;
  figmaNodeId?: string | null;
  fromKey?: string | null;
  toKey?: string | null;
  fromName: string;
  toName: string;
  anchor: RenameAnchor;
  /** 1.0 for an anchored (node-id / code-instance) rename; <1.0 for an advisory fuzzy candidate. */
  confidence: number;
  resolution: RenameResolution;
}

export interface RenameRow {
  id: number;
  side: RenameSide;
  component_id: number | null;
  figma_file_key: string | null;
  figma_node_id: string | null;
  from_key: string | null;
  to_key: string | null;
  from_name: string;
  to_name: string;
  anchor: RenameAnchor;
  confidence: number;
  resolution: RenameResolution;
  computed_at: string;
}

/** Append a rename/move event to the audit trail. Returns its id. */
export function recordRenameEvent(db: DB, input: RenameEventInput): number {
  const info = db
    .prepare(
      `INSERT INTO rename_events
         (side, component_id, figma_file_key, figma_node_id, from_key, to_key, from_name, to_name,
          anchor, confidence, resolution)
       VALUES
         (@side, @componentId, @figmaFileKey, @figmaNodeId, @fromKey, @toKey, @fromName, @toName,
          @anchor, @confidence, @resolution)`,
    )
    .run({
      side: input.side,
      componentId: input.componentId ?? null,
      figmaFileKey: input.figmaFileKey ?? null,
      figmaNodeId: input.figmaNodeId ?? null,
      fromKey: input.fromKey ?? null,
      toKey: input.toKey ?? null,
      fromName: input.fromName,
      toName: input.toName,
      anchor: input.anchor,
      confidence: input.confidence,
      resolution: input.resolution,
    });
  return Number(info.lastInsertRowid);
}

/** Rename events newest-first, **bounded** to `limit` rows (default 100, hard-capped at 500). */
export function listRenameEvents(db: DB, limit = 100): RenameRow[] {
  const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  return db
    .prepare(`SELECT * FROM rename_events ORDER BY computed_at DESC, id DESC LIMIT @limit`)
    .all({ limit: capped }) as RenameRow[];
}

/**
 * Re-point a component's stable `key` from `fromKey` to `toKey`, preserving its `id` so every snapshot,
 * variant, and regression (all keyed by `component_id`) survives the rename intact. No-op returning
 * `false` when `fromKey` is absent or `toKey` is already taken (a real collision — the caller should
 * SURFACE that rather than silently merge two components). Returns `true` when the key was re-pointed.
 */
export function applyCodeRename(db: DB, fromKey: string, toKey: string): boolean {
  if (fromKey === toKey) return false;
  const from = getComponentByKey(db, fromKey);
  if (from === undefined) return false;
  if (getComponentByKey(db, toKey) !== undefined) return false; // target exists — surface, don't merge
  db.prepare(`UPDATE components SET key = @toKey, updated_at = ${NOW} WHERE id = @id`).run({
    toKey,
    id: from.id,
  });
  return true;
}

// --- F3: orphan / removal soft-marking ------------------------------------------------------------

/**
 * Soft-mark every CODE component (code_target IS NOT NULL) whose key is NOT in `keepKeys` as
 * `lifecycle = 'removed'` — the reversible "this code component disappeared" state. Figma-only rows (no
 * code) are never touched; already-`removed` rows are skipped (idempotent). The keep set is staged in a
 * TEMP table so `keepKeys` is unbounded (no 999-variable `IN()` limit). Returns how many rows flipped.
 * The caller restricts this to a FULL sync (never a `--target` subset), so an untouched component in a
 * partial run is never mistaken for removed.
 */
export function markRemovedCode(db: DB, keepKeys: readonly string[]): number {
  const run = db.transaction((keys: readonly string[]): number => {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS _keep_keys (key TEXT PRIMARY KEY)`);
    db.exec(`DELETE FROM _keep_keys`);
    const ins = db.prepare(`INSERT OR IGNORE INTO _keep_keys (key) VALUES (?)`);
    for (const k of keys) ins.run(k);
    const info = db
      .prepare(
        `UPDATE components SET lifecycle = 'removed', updated_at = ${NOW}
          WHERE code_target IS NOT NULL AND lifecycle != 'removed'
            AND key NOT IN (SELECT key FROM _keep_keys)`,
      )
      .run();
    return info.changes;
  });
  return run(keepKeys);
}

/**
 * Resurrect a returned component: if it is currently `removed`, re-derive its lifecycle from presence
 * ({@link deriveLifecycle}). No-op when the component is absent or not `removed`.
 */
export function clearRemovedState(db: DB, componentId: number): void {
  const row = getComponentById(db, componentId);
  if (row === undefined || row.lifecycle !== "removed") return;
  setLifecycle(db, componentId, deriveLifecycle(row));
}

// --- F4: variant-axis set-diff --------------------------------------------------------------------

function parseAxesJson(json: string | null): Record<string, string> {
  if (json === null || json.length === 0) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Advisory Figma↔code variant-axis diff for a component: parse each variant's `props_json` axis map and
 * set-diff the axis names ({@link diffVariantAxes}). Tolerates NULL/garbage `props_json` (→ `{}`), never
 * throws. Reads `parity_status`/variants only — never touches `components.status` (the CI axis).
 */
export function variantAxisDiff(db: DB, componentId: number): VariantAxisDiff {
  const figma = componentVariants(db, componentId, "figma").map((v) => parseAxesJson(v.props_json));
  const code = componentVariants(db, componentId, "code").map((v) => parseAxesJson(v.props_json));
  return diffVariantAxes(figma, code);
}

// --- F5: staleness + aggregate drift report -------------------------------------------------------

/**
 * Is a matched component's mapping STALE — i.e. the Figma design moved ahead of the code side? True when
 * the latest Figma snapshot's `figma_last_modified` (the design's own mtime; falling back to OUR figma
 * capture time when absent) is strictly AFTER the latest code snapshot's `captured_at`. Only matched
 * components can be stale: a figma-only/code-only/unlinked component returns false (nothing to be stale
 * between), and equal timestamps are NOT stale. Reads timestamps only — never `components.status`.
 */
export function isMappingStale(db: DB, componentId: number): boolean {
  const row = getComponentById(db, componentId);
  if (row === undefined || row.figma_node_id === null || row.code_target === null) return false;
  const figma = latestSnapshotForSource(db, componentId, "figma");
  const code =
    latestSnapshotForSource(db, componentId, "code") ??
    latestSnapshotForSource(db, componentId, "current");
  if (figma === undefined || code === undefined) return false;
  // Compare INSTANTS, not strings: `code.captured_at` is always millisecond-precision strftime
  // (`...45.123Z`) but a real Figma `lastModified` is often second-precision (`...45Z`), and `Z` > `.`
  // lexically — so a raw string `>` would falsely flag stale within the same second. Date.parse
  // normalizes both. An unparseable timestamp must NOT fabricate staleness → treat as fresh.
  const figmaMs = Date.parse(figma.figma_last_modified ?? figma.captured_at);
  const codeMs = Date.parse(code.captured_at);
  if (Number.isNaN(figmaMs) || Number.isNaN(codeMs)) return false;
  return figmaMs > codeMs; // strictly after → stale; equal/earlier → fresh
}

export interface DriftReport {
  /** Components new/removed on each side since the previous population snapshot. */
  delta: PopulationDelta;
  /** Keys of code components soft-marked `removed` (F3). */
  removed: string[];
  /** Keys of matched components whose mapping is stale (design ahead of code). */
  stale: string[];
  /** Total rename/move events on record (F2). */
  renamed: number;
  /** Presence rollups (the at-a-glance parity coverage). */
  figmaOnly: number;
  codeOnly: number;
  matched: number;
}

/**
 * Aggregate the advisory drift signals into one report (the `/visual-drift` surface): population delta,
 * removed components, stale mappings, rename count, and presence rollups. ADVISORY ONLY — it reads
 * `lifecycle`/presence/timestamps and NEVER `components.status` (the CI-relevant code-regression axis),
 * so it can never move the gate. Pure read.
 */
export function computeDrift(db: DB): DriftReport {
  const components = listComponents(db);
  const removed = components
    .filter((c) => c.lifecycle === "removed")
    .map((c) => c.key)
    .sort();
  const stale = components
    .filter((c) => isMappingStale(db, c.id))
    .map((c) => c.key)
    .sort();
  const presence = summaryCounts(db).presence;
  return {
    delta: populationDelta(db),
    removed,
    stale,
    renamed: listRenameEvents(db, 500).length,
    figmaOnly: presence.figmaOnly,
    codeOnly: presence.codeOnly,
    matched: presence.both,
  };
}
