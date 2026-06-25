-- Component Studio schema (SPEC §7). v5 baseline.
--
-- This file is the FULL current-version DDL: db.ts `migrate()` applies it once on a fresh database and
-- then stamps user_version = SCHEMA_VERSION (currently 5). An existing older DB is brought forward by the
-- incremental `if (from < N)` steps in migrate() instead. Connection-level PRAGMAs (journal_mode = WAL,
-- foreign_keys = ON) are set by `openDb()` on EVERY connection, not here. The DB is a gitignored,
-- rebuildable index; the source of truth is the committed PNGs under .visual-baselines/ plus
-- .visual-baselines/figma_meta.json.
--
-- v5 adds the advisory DRIFT/MAINTENANCE layer (all informational, never gates CI):
--   * components.lifecycle      — presence/drift axis (matched/figma-only/code-only/removed/renamed),
--                                 derived once at the sync/reindex rollup; removal is a reversible
--                                 soft-mark here (NOT a sync_state, so no CHECK-widening table rebuild).
--   * components.code_props_json / figma_axes_json — F4 variant/prop axes for the set-diff.
--   * components.figma_last_modified / code_last_seen_sha + snapshots.figma_last_modified — F5 staleness.
--   * figma_code_links   — durable explicit figma-node <-> code-component edge (F1 bonus mirror).
--   * population_snapshots — per-sync component-population keysets for "N new since last sync" (F5).
--   * rename_events      — append-only rename/move history (F2).
-- The new components columns are appended AFTER updated_at and snapshots.figma_last_modified AFTER
-- approved, so this fresh shape matches what the migrate() ADD COLUMN steps produce (ADD COLUMN always
-- appends), keeping a fresh DB and a migrated DB structurally identical.

CREATE TABLE components (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,                            -- stable slug, e.g. "buttons/primary-button"
  name TEXT NOT NULL,
  description TEXT,
  figma_file_key TEXT, figma_node_id TEXT,            -- Figma linkage (nullable)
  code_instance TEXT, code_target TEXT, story_id TEXT,-- code linkage (nullable)
  status TEXT NOT NULL DEFAULT 'unknown'              -- denormalized rollup (recomputed)
    CHECK (status IN ('same','changed','regression','new','error','unknown')),
  parity_status TEXT                                  -- figma↔code axis (nullable: no figma link)
    CHECK (parity_status IS NULL OR parity_status IN ('same','changed','regression','new','error','unknown')),
  sync_state TEXT NOT NULL DEFAULT 'synced'           -- resumable-sync state (SPEC §9.5)
    CHECK (sync_state IN ('synced','figma-pending','code-pending','error')),
  last_attempt_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- v5 drift columns (advisory; appended after updated_at to mirror ADD COLUMN order).
  lifecycle TEXT NOT NULL DEFAULT 'unknown'           -- presence/drift axis (derived once at rollup)
    CHECK (lifecycle IN ('matched','figma-only','code-only','removed','renamed','unknown')),
  code_props_json TEXT,                               -- F4 code prop axes (live-sync-only; NULL after reindex)
  figma_axes_json TEXT,                               -- F4 figma variant-axis labels (durable via figma_meta.json)
  figma_last_modified TEXT,                           -- F5 figma node lastModified ISO8601 (durable via figma_meta.json)
  code_last_seen_sha TEXT                             -- F5 git sha the code side was last observed at (live-sync-only)
);
-- Lifecycle is the gallery's drift filter (matched / figma-only / removed / …); index the low-cardinality column.
CREATE INDEX idx_components_lifecycle ON components(lifecycle);

CREATE TABLE variants (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('figma','code')),
  name TEXT NOT NULL,                                 -- "size=lg, state=hover" or a story name
  props_json TEXT, figma_node_id TEXT, story_id TEXT,
  render_url TEXT,                                    -- live harness preview URL captured from (v3, nullable)
  UNIQUE (component_id, source, name)
);

CREATE TABLE component_usages (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('code-import','figma-instance','route','story','doc')),
  used_in TEXT NOT NULL, detail TEXT,
  UNIQUE (component_id, kind, used_in)
);

-- THE TIMELINE TABLE — append-only; powers both histories + the timeline control.
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES variants(id) ON DELETE SET NULL,   -- NULL = default
  source TEXT NOT NULL CHECK (source IN ('figma','code','current')),
  image_path TEXT NOT NULL,                           -- repo-relative
  image_hash TEXT NOT NULL,                           -- sha256 (content address / dedupe)
  width INTEGER, height INTEGER, viewport INTEGER,
  version_seq INTEGER NOT NULL,                       -- writer-assigned, monotonic per (component,variant,source)
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  figma_version_id TEXT, git_sha TEXT,
  approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0,1)),   -- 1 = baseline
  figma_last_modified TEXT,                           -- v5: figma node lastModified at capture (NULL for code/current)
  UNIQUE (component_id, variant_id, source, version_seq)
);
CREATE INDEX idx_snapshots_timeline ON snapshots(component_id, source, variant_id, version_seq DESC);
CREATE INDEX idx_snapshots_hash ON snapshots(image_hash);
-- The table-level UNIQUE above does NOT constrain the default-variant lane, because SQLite treats
-- NULLs as DISTINCT in a UNIQUE index. This expression index closes that gap (NULL → -1) so per-lane
-- version_seq monotonicity is enforced for EVERY lane, making appendSnapshot's UNIQUE-collision retry
-- a real backstop on default lanes rather than dead code. (variant ids are positive, so -1 is a safe
-- sentinel that can never collide with a real variant.)
CREATE UNIQUE INDEX idx_snapshots_lane_seq
  ON snapshots(component_id, COALESCE(variant_id, -1), source, version_seq);

CREATE TABLE regressions (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK (axis IN ('current_vs_baseline','figma_vs_code')),
  from_snapshot INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  to_snapshot   INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  diff_ratio REAL,                                    -- 0..1 from diff.ts (NULL for new/error)
  -- Advisory conformance breakdown (figma_vs_code axis only; NULL for the code-regression axis). The
  -- collapsed `diff_ratio` above is max(dimension_delta, palette_delta); these two record which axis
  -- drove the verdict so the UI can say "size drifted" vs "color drifted" (v4).
  dimension_delta REAL,                               -- relative size delta 0..1 (figma↔code)
  palette_delta REAL,                                 -- perceptual color delta 0..1 (figma↔code)
  status TEXT NOT NULL CHECK (status IN ('same','changed','regression','new','error')),
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- regressions is append-only and the highest-cardinality table after snapshots. recomputeStatus /
-- latestLaneStatus / latestRegressionStatus all filter by (component_id, axis) and take the newest row
-- (computed_at DESC, id DESC). Per touched component, the sync loop runs that scan — without this index
-- it is a full table scan that grows with history. The index serves the filter + the ORDER BY...LIMIT 1.
CREATE INDEX idx_regressions_component_axis
  ON regressions(component_id, axis, computed_at DESC, id DESC);
-- (component_usages needs no extra index: its UNIQUE(component_id, kind, used_in) backing autoindex
-- already leads with component_id, so the "Used in" read (WHERE component_id ORDER BY kind, used_in) and
-- the ON DELETE CASCADE probe both use it.)

-- v5 DRIFT TABLES (advisory; never read by the CI gate) -----------------------------------------------

-- A durable, explicit figma-node <-> code-component edge. F1 ships on figma_meta.json's `codeKey` alone
-- (this is a bonus mirror in the rebuildable DB); the UNIQUE(figma_file_key, figma_node_id) autoindex
-- already serves the node lookup, so no extra index is declared.
CREATE TABLE figma_code_links (
  id INTEGER PRIMARY KEY,
  figma_file_key TEXT NOT NULL,
  figma_node_id TEXT NOT NULL,
  component_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('override','auto','manual')),
  linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (figma_file_key, figma_node_id)
);

-- Per-sync component-population snapshot — the keysets present on each side at sync time, so F5 can
-- set-diff the two newest rows into "N new figma/code components since last sync". A derived cache:
-- history that does NOT survive reindex (reindex records one fresh baseline point).
CREATE TABLE population_snapshots (
  id INTEGER PRIMARY KEY,
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  total INTEGER NOT NULL,
  figma_count INTEGER NOT NULL,
  code_count INTEGER NOT NULL,
  both_count INTEGER NOT NULL,
  figma_keys TEXT NOT NULL,                           -- JSON array of component keys present on the figma side
  code_keys TEXT NOT NULL                             -- JSON array of component keys present on the code side
);
CREATE INDEX idx_population_captured ON population_snapshots(captured_at DESC, id DESC);

-- Append-only rename/move history (F2). component_id is ON DELETE SET NULL so the audit trail outlives a
-- (future) hard-deleted component. `anchor` records WHAT proved the rename (a stable figma node id, a
-- stable code instance, or an advisory fuzzy match); `resolution` whether it was auto-applied or only
-- surfaced for review.
CREATE TABLE rename_events (
  id INTEGER PRIMARY KEY,
  side TEXT NOT NULL CHECK (side IN ('figma','code')),
  component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
  figma_file_key TEXT,
  figma_node_id TEXT,
  from_key TEXT,
  to_key TEXT,
  from_name TEXT NOT NULL,
  to_name TEXT NOT NULL,
  anchor TEXT NOT NULL CHECK (anchor IN ('figma-node-id','code-instance','fuzzy')),
  confidence REAL NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('applied','surfaced')),
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_rename_events_recent ON rename_events(computed_at DESC, id DESC);
