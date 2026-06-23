import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  mapNativeLoadError,
  migrate,
  openDb,
  schemaVersion,
  SCHEMA_VERSION,
} from "../scripts/lib/studio/db";

describe("mapNativeLoadError — actionable message when the native binding can't load", () => {
  it("wraps a dlopen failure with recovery guidance and preserves the original text", () => {
    const raw = Object.assign(new Error("dlopen(better_sqlite3.node): symbol not found"), {
      code: "ERR_DLOPEN_FAILED",
    });
    const mapped = mapNativeLoadError(raw);
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped.message).toMatch(/native SQLite binding/i);
    expect(mapped.message).toMatch(/\/visual-setup|fresh Claude Code session/);
    expect(mapped.message).toContain(process.versions.modules); // names the current ABI
    expect(mapped.message).toContain("dlopen(better_sqlite3.node)"); // original preserved
  });

  it("recognizes the V8 ABI-mismatch message (no code property)", () => {
    const raw = new Error(
      "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115.",
    );
    expect(mapNativeLoadError(raw).message).toMatch(/native SQLite binding/i);
  });

  it("passes a normal SQLite error through unchanged (not every error is a native-load error)", () => {
    const raw = new Error("SQLITE_CANTOPEN: unable to open database file");
    const mapped = mapNativeLoadError(raw);
    expect(mapped).toBe(raw); // same instance — untouched
  });
});

describe("openDb / migrate", () => {
  it("creates the v1 schema with foreign_keys ON", () => {
    const db = openDb(":memory:");
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "components",
        "variants",
        "component_usages",
        "snapshots",
        "regressions",
      ]),
    );

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_snapshots_timeline",
        "idx_snapshots_hash",
        "idx_regressions_component_axis", // v2 — a schema.sql revert would drop this
      ]),
    );
    db.close();
  });

  it("migrates a fresh (user_version 0) database up to current", () => {
    const db = new Database(":memory:");
    expect(schemaVersion(db)).toBe(0);
    migrate(db);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  const variantColumns = (db: Database.Database): string[] =>
    (db.pragma("table_info(variants)") as { name: string }[]).map((c) => c.name);

  it("migrates a v1 DB up to current — cumulatively adds the v2 index AND the v3 render_url column", () => {
    // Simulate a DB built by the v1 schema: drop the v2 index + v3 column and roll the marker back to 1.
    const db = openDb(":memory:");
    db.exec("DROP INDEX IF EXISTS idx_regressions_component_axis");
    db.exec("ALTER TABLE variants DROP COLUMN render_url");
    db.pragma("user_version = 1");
    expect(schemaVersion(db)).toBe(1);

    migrate(db); // must run BOTH the v1→v2 and v2→v3 steps (cumulative), not just the first

    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toContain("idx_regressions_component_axis");
    expect(variantColumns(db)).toContain("render_url");
    db.close();
  });

  it("migrates a v2 DB up to v3 — adds the render_url column (guarded, idempotent)", () => {
    const db = openDb(":memory:");
    db.exec("ALTER TABLE variants DROP COLUMN render_url");
    db.pragma("user_version = 2");
    expect(variantColumns(db)).not.toContain("render_url");

    migrate(db);

    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(variantColumns(db)).toContain("render_url");
    // Re-migrating must not trip the ALTER again (columnExists guard).
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  const regressionColumns = (db: Database.Database): string[] =>
    (db.pragma("table_info(regressions)") as { name: string }[]).map((c) => c.name);

  it("migrates a v3 DB up to v4 — adds the conformance breakdown columns (guarded, idempotent)", () => {
    const db = openDb(":memory:");
    db.exec("ALTER TABLE regressions DROP COLUMN dimension_delta");
    db.exec("ALTER TABLE regressions DROP COLUMN palette_delta");
    db.pragma("user_version = 3");
    expect(regressionColumns(db)).not.toContain("dimension_delta");

    migrate(db);

    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(regressionColumns(db)).toContain("dimension_delta");
    expect(regressionColumns(db)).toContain("palette_delta");
    // Re-migrating must not trip the ALTER again (columnExists guard).
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  it("is idempotent — re-migrating a current DB changes nothing", () => {
    const db = openDb(":memory:");
    const count = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number }).n;
    const before = count();
    migrate(db);
    migrate(db);
    expect(count()).toBe(before);
    db.close();
  });

  it("enforces foreign keys (a snapshot needs a real component)", () => {
    const db = openDb(":memory:");
    expect(() =>
      db
        .prepare(
          `INSERT INTO snapshots (component_id, source, image_path, image_hash, version_seq)
           VALUES (999, 'code', 'x.png', 'h', 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });
});

describe("openDb — WAL on a real file DB", () => {
  let tmp = "";
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("enables WAL journal mode (the in-memory tests can't observe this — it downgrades to 'memory')", () => {
    tmp = mkdtempSync(join(tmpdir(), "vg-wal-"));
    const db = openDb(join(tmp, "studio.db"));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });

  it("creates the DB's parent directory if it doesn't exist (fresh .visual-guard/)", () => {
    tmp = mkdtempSync(join(tmpdir(), "vg-mkdir-"));
    // a nested, not-yet-created path — better-sqlite3 alone would throw "directory does not exist"
    const db = openDb(join(tmp, ".visual-guard", "studio.db"));
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });
});
