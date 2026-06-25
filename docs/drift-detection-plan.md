# Drift Detection & Maintenance — Implementation Plan

Visual Guard is built for **code-vs-code-baseline pixel regression** and surfaces Figma↔code
*presence* (figma-only / code-only) as a browseable signal. It has had no **maintenance / drift**
layer: it could not flag a renamed Figma variant or code prop, a newly-appeared Figma component, or
a mapping that has gone stale. This plan adds that layer across five features.

Everything here is **advisory**. No drift signal may ever reach `ci.ts` or move
`components.status` (the code-regression axis the CI gate reads) — the `figma_vs_code`-never-gates
invariant is preserved. Drift is informational: a glance, never a build failure.

## The five features

| # | Feature | What it adds |
|---|---------|--------------|
| F1 | Stable identity / persisted mapping | Persist the Figma `nodeId` + code key into the committed `figma_meta.json` so the node↔code mapping survives `reindex` (which wipes the rebuildable DB) and is diffable across syncs. |
| F2 | Rename detection | Diff the prior persisted mapping against the fresh name-match; emit an explicit `renamed/moved` event instead of a silent re-match or a delete+add. |
| F3 | Orphan / removal pass | A pass over rows not in the touched set on a full sync soft-marks removed code components `removed` instead of leaving stale orphans. Cooperates with F2 so a rename is not misread as a removal. |
| F4 | Variant / prop-axis capture + set-diff | Persist Figma variant-axis labels (today dropped) and best-effort code props; set-diff them to surface missing/extra/renamed axes. Honest about partial code-prop enumeration. |
| F5 | Deltas, staleness & surfacing | Per-sync population snapshot for "N new since last sync"; parse Figma `lastModified` to compute mapping staleness; surface everything via the `status` CLI, `/api/summary` + `/api/drift`, studio badges, and a new `/visual-drift` report. |

## Key design decisions

1. **One schema migration, version 4 → 5.** Four design specs independently proposed bumping
   `SCHEMA_VERSION` to 5 with overlapping DDL. Only one v5 can exist: the migration owns the single
   bump and absorbs F2's `rename_events`, F3's `sync_state` CHECK-widen + `components` rebuild, and
   F5's `snapshots.figma_last_modified` + population table. `db.ts`/`schema.sql` are edited exactly
   once (step 1), following the existing cumulative `if (from < N)` `migrate()` mechanism.
2. **Soft-mark, not hard-delete (F3).** A removed component flips `sync_state='removed'` (reversible;
   resurrects on return) rather than being deleted — preserving its drift timeline and curated Figma
   link. `prune.ts` can later reap truly-dead rows on a retention policy.
3. **Advisory only (all five).** `axisDiff`, `lifecycle`, `removed`, `renames`, `drift`/`staleness`
   read `parity_status`/presence/timestamps and never write `components.status`. A guardrail test
   asserts it.
4. **Lifecycle derived once.** A single `setLifecycle` called from one rollup point (reindex's
   component loop + the sync tail) owns the `lifecycle` column; it is excluded from
   `upsertComponent`'s COALESCE merge so no per-side upsert can clobber it.
5. **Reindex source-of-truth split.** `reindex` rebuilds only from committed PNGs + `figma_meta.json`,
   so `figma_last_modified`, `figma_axes_json`, the link's Figma endpoint, and `codeKey` live in
   `figma_meta.json` (durable, rehydrated). `code_props_json`/`code_last_seen_sha` are accepted as
   live-sync-only (NULL after reindex). `population_snapshots`/`rename_events` are history and do not
   survive reindex by design.
6. **Code-prop enumeration is necessarily partial (F4).** The engine reads only Storybook/Ladle
   `index.json` (id/title/name/type/importPath); story args are runtime iframe values it never reads.
   So the code side defaults to a single synthetic `{Variant: story-name}` and reports `unknown`
   (not `missing`) when it has no declared axes — the honesty guard against constant false positives.
   A real value-level diff is computed only when the user opts in via `config.studio.variantAxes`.
7. **F2 before F3 (load-bearing order).** F2 owns rebinding a renamed component's row into the
   `touched` set; only then does F3's removal pass correctly skip it. Shipping F3 first would make
   every rename read as a removal + a new component.

## Unified migration (v5) — purely additive, no table rebuild

The design's draft widened the `sync_state` CHECK via a `components` table-rebuild. That was **rejected
during implementation**: `openDb` sets `foreign_keys = ON`, so `DROP TABLE components` performs an
implicit DELETE that **cascades and wipes every variant/snapshot/regression** — and `PRAGMA
foreign_keys` cannot be toggled inside `migrate()`'s transaction. Instead, removal/rename live in the
**new `lifecycle` column** (a fresh `ADD COLUMN` whose CHECK includes `'removed'`/`'renamed'`), so no
rebuild is needed and the migration is purely additive.

- New `components` columns: `lifecycle` (with its CHECK), `code_props_json`, `figma_axes_json`,
  `figma_last_modified`, `code_last_seen_sha`; index `idx_components_lifecycle`. Appended after
  `updated_at` so a fresh DB and a migrated DB converge (ADD COLUMN always appends).
- `snapshots.figma_last_modified` (appended after `approved`).
- New tables: `figma_code_links` (durable explicit edge), `population_snapshots` (per-sync keysets),
  `rename_events` (side/anchor/confidence/resolution, `component_id` ON DELETE SET NULL).

On the fresh path `schema.sql` carries the full v5 shape; on the migrate path a single `if (from < 5)`
block does the `columnExists`-guarded `ADD COLUMN`s and the `IF NOT EXISTS` creates — inside the
existing `migrate()` transaction. A convergence test proves fresh == migrated.

## Build order (dependency-correct)

1. **Migration + schema** — `db.ts`, `schema.sql`, `tests/studio-db.test.ts` (4-part migration tests).
2. **Store surface** — `store.ts` setters/recorders/types for the new tables/columns (no callers yet).
3. **figma-meta durable fields** — `figma-meta.ts` gains all optional rehydration fields in one edit.
4. **F1** — wire `codeKey` end-to-end (`record-figma.ts`, `studio.ts` reindex) so the mapping survives reindex.
5. **F2** — `rename.ts` pure diff + persistence wiring in `record-figma.ts`/`sync.ts`; `renames` subcommand.
6. **F3** — orphan/removal pass in `sync.ts` (after F2's rebind); `removed` count in `status`.
7. **F4** — `variant-axes.ts` parse/diff; persist axes; `axisDiff` on detail; studio badge.
8. **F5** — `lastModified` parse; population snapshot; staleness; `drift`/`snapshot` subcommands;
   `/api/drift`; gallery Stale chip; new `scripts/drift.ts` + `commands/visual-drift.md`.
9. **Gates** — full `npm test` / `typecheck` / `lint` / `claude plugin validate . --strict` + coverage.

## Gates (run after every step)

- `npm test` (`vitest run`), `npm run typecheck` (`tsc --noEmit`), `npm run lint` (eslint).
- `claude plugin validate . --strict` (strictly required once step 8 adds the command file).
- `npx vitest run --coverage` must hold 80% aggregate + `scripts/studio/server.ts` per-file floor.
- Output is **emoji-free**; the repo is intentionally **not** prettier-clean — never run `prettier --write`.
