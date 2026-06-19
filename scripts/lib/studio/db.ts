import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Component Studio SQLite handle (SPEC §7 / D4). `better-sqlite3` (native, Node-20 floor) bootstrapped
 * through the same `ENGINE_DEPS` bridge that already ships `sharp`. The DB at `.visual-guard/studio.db`
 * is a **gitignored, rebuildable index** — `scripts/studio.ts reindex` reconstructs it from the
 * committed PNGs + `figma_meta.json`, so a binary DB is never committed.
 *
 * Pure-ish: `openDb`/`migrate` take a path / handle and do only the I/O SQLite needs. The query &
 * mutation logic lives in `store.ts` against an injected handle, so it is unit-testable over an
 * in-memory DB (`openDb(":memory:")`).
 */

export type DB = Database.Database;

/** The schema version this build knows how to produce (mirrors `PRAGMA user_version`). */
export const SCHEMA_VERSION = 3;

// schema.sql sits beside this module both in source and when shipped in the plugin, so resolve it
// relative to the module URL (works under tsx, vitest, and the bridged plugin runtime alike).
const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

/**
 * Open (creating if needed) the Studio DB at `path` and bring it to {@link SCHEMA_VERSION}. Sets the
 * connection-level PRAGMAs every open: WAL (so the localhost server can read while a sync writes) and
 * `foreign_keys = ON` (so the `ON DELETE CASCADE`s actually fire). Pass `":memory:"` for tests.
 */
export function openDb(path: string): DB {
  // better-sqlite3 cannot create the DB file if its directory is missing — ensure it exists for any
  // real path (every CLI that opens `.visual-guard/studio.db` in a fresh project relies on this).
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  let db: DB;
  try {
    db = new Database(path);
  } catch (err) {
    // The one failure that isn't about `path`: better-sqlite3's native `.node` binding didn't load
    // (missing prebuilt, or built for a different Node ABI after a Node upgrade). Turn the raw
    // `ERR_DLOPEN_FAILED`/bindings stack into an actionable message — the engine self-repairs on a
    // fresh session, so point there rather than leaving the user with a cryptic crash.
    throw mapNativeLoadError(err);
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** Read the integer `user_version` (the migration counter). */
export function schemaVersion(db: DB): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/** Does `table` already have `column`? Used to make an `ADD COLUMN` migration step re-runnable. */
function columnExists(db: DB, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/**
 * Bring `db` up to {@link SCHEMA_VERSION}. v0 (fresh) → apply schema.sql (the full current shape); an
 * older DB → run the incremental `if (from === N)` steps. Either way stamp `user_version = SCHEMA_VERSION`,
 * inside a transaction so a partial apply can never leave a half-built schema. A DB already at (or past)
 * the current version is left untouched, so `migrate` is idempotent and safe to call on every `openDb`.
 */
export function migrate(db: DB): void {
  const from = schemaVersion(db);
  if (from >= SCHEMA_VERSION) {
    return;
  }
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const apply = db.transaction(() => {
    if (from === 0) {
      // Fresh DB: schema.sql already contains the current (v3) shape, indexes + columns included.
      db.exec(schema);
    } else {
      // Older DB: run EVERY incremental step from `from` up to current — cumulative (NOT one step keyed
      // on the exact `from`), so a v1 DB gets both the v2 index AND the v3 column, not just the first.
      if (from < 2) {
        // v1 → v2: add the regression lookup index a v1 DB was built without. IF NOT EXISTS so a
        // hand-rebuilt DB can never trip on a name it already has. (component_usages needs no new index —
        // its UNIQUE(component_id, …) autoindex already covers the component_id prefix.)
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_regressions_component_axis
             ON regressions(component_id, axis, computed_at DESC, id DESC);`,
        );
      }
      if (from < 3 && !columnExists(db, "variants", "render_url")) {
        // v2 → v3: the live-preview harness URL per code variant. Guarded by a column-existence check
        // (SQLite has no ADD COLUMN IF NOT EXISTS) so a partially-migrated/hand-rebuilt DB can't crash.
        db.exec(`ALTER TABLE variants ADD COLUMN render_url TEXT;`);
      }
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  apply();
}

/**
 * Recognize the signatures of a failed native-addon load (as opposed to a normal SQLite error like a
 * bad path or a locked file): the dynamic-loader code, the V8 ABI-mismatch message, or the
 * `bindings`-package "couldn't find the .node" message.
 */
function isNativeLoadError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === "ERR_DLOPEN_FAILED" ||
    /NODE_MODULE_VERSION|compiled against a different Node\.js version|Could not locate the bindings file|dlopen|invalid ELF header|not a valid Win32 application/i.test(
      message,
    )
  );
}

/**
 * Wrap a native-load failure with a message that tells the user how to recover; pass any other error
 * through unchanged so genuine SQLite errors keep their original text. Exported for {@link openDb}'s
 * error mapping and its unit tests.
 */
export function mapNativeLoadError(err: unknown): Error {
  if (!isNativeLoadError(err)) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const original = err instanceof Error ? err.message : String(err);
  return new Error(
    `Visual Guard: the native SQLite binding (better-sqlite3) failed to load for Node ${process.version} ` +
      `(ABI ${process.versions.modules}, ${process.platform}/${process.arch}). Its prebuilt binary is missing ` +
      `or was built for a different Node version. Recover by starting a fresh Claude Code session — the ` +
      `SessionStart hook rebuilds the engine for your current Node — or run \`/visual-setup\` to reinstall.` +
      `\nOriginal error: ${original}`,
  );
}
