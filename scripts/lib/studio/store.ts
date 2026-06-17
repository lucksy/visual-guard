import type { DB } from "./db";

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
}

/**
 * Insert a component, or merge into the existing row with the same `key`. Linkage fields use COALESCE
 * (excluded → existing) so upserting the code side never wipes a previously-recorded Figma side and
 * vice versa — the basis for P2 matching. `name` is always taken from the latest write. Returns the id.
 */
export function upsertComponent(db: DB, input: UpsertComponentInput): number {
  const row = db
    .prepare(
      `INSERT INTO components
         (key, name, description, figma_file_key, figma_node_id, code_instance, code_target, story_id)
       VALUES
         (@key, @name, @description, @figmaFileKey, @figmaNodeId, @codeInstance, @codeTarget, @storyId)
       ON CONFLICT(key) DO UPDATE SET
         name = excluded.name,
         description = COALESCE(excluded.description, components.description),
         figma_file_key = COALESCE(excluded.figma_file_key, components.figma_file_key),
         figma_node_id = COALESCE(excluded.figma_node_id, components.figma_node_id),
         code_instance = COALESCE(excluded.code_instance, components.code_instance),
         code_target = COALESCE(excluded.code_target, components.code_target),
         story_id = COALESCE(excluded.story_id, components.story_id),
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
  /** Case-insensitive substring matched against key + name. */
  q?: string;
}

/**
 * Build the shared `WHERE` for a {@link ListFilter} (status + literal name/key substring). `prefix`
 * qualifies the columns (`""` for a bare `components` query, `"c."` when components is aliased `c`).
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
    clauses.push(`(${prefix}key LIKE @q ESCAPE '\\' OR ${prefix}name LIKE @q ESCAPE '\\')`);
    // Escape LIKE metacharacters so q is a literal, case-insensitive substring (per this interface),
    // never a wildcard pattern. (The value is still bound, so this is about semantics, not injection.)
    const escaped = filter.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    params.q = `%${escaped}%`;
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
        version_seq, figma_version_id, git_sha, approved)
     VALUES
       (@componentId, @variantId, @source, @imagePath, @imageHash, @width, @height, @viewport,
        @versionSeq, @figmaVersionId, @gitSha, @approved)`,
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
  status: RegressionStatus;
}

/** Append a comparison (regression/conformance) row. Returns its id. */
export function recordComparison(db: DB, input: RecordComparisonInput): number {
  const info = db
    .prepare(
      `INSERT INTO regressions (component_id, axis, from_snapshot, to_snapshot, diff_ratio, status)
       VALUES (@componentId, @axis, @fromSnapshot, @toSnapshot, @diffRatio, @status)`,
    )
    .run({
      componentId: input.componentId,
      axis: input.axis,
      fromSnapshot: input.fromSnapshot,
      toSnapshot: input.toSnapshot,
      diffRatio: input.diffRatio ?? null,
      status: input.status,
    });
  return Number(info.lastInsertRowid);
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
