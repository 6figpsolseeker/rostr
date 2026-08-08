/**
 * Migration runner.
 *
 * Plain numbered SQL files applied in order, tracked in `schema_migrations`.
 * No ORM and no migration framework: the same files run on PGlite in tests and
 * on Supabase in production, and anyone auditing this project can read the
 * schema without learning a DSL.
 *
 * Migrations are forward-only. There are no down migrations — a league's rules
 * are immutable and its history must stay auditable, so the answer to a bad
 * migration is another migration.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { SqlClient } from "./client.js";

/** `packages/db/migrations`, resolved identically from `src/` and `dist/`. */
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  /** SHA-256 of the file, so an edited applied migration can be detected. */
  readonly checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Read and validate the migration set from disk, ordered by version. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const migrations = files.map((filename): Migration => {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match) {
      throw new MigrationError(
        `Migration "${filename}" must be named NNNN_snake_case_name.sql`,
      );
    }
    const sql = readFileSync(join(dir, filename), "utf8");
    return {
      version: Number(match[1]),
      name: match[2] as string,
      filename,
      sql,
      checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
    };
  });

  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new MigrationError(`Duplicate migration version ${m.version} (${m.filename})`);
    }
    seen.add(m.version);
  }

  return migrations;
}

async function ensureMigrationsTable(db: SqlClient): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     integer PRIMARY KEY,
      name        text NOT NULL,
      checksum    char(64) NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Apply every migration not yet recorded, in version order.
 *
 * Re-running is safe: applied migrations are skipped. If an already-applied file
 * has been edited since, this throws rather than silently diverging — the schema
 * in the database would no longer match the schema in the repo.
 */
export async function migrate(
  db: SqlClient,
  migrations: readonly Migration[] = loadMigrations(),
): Promise<MigrateResult> {
  await ensureMigrationsTable(db);

  const applied = await db.query<AppliedRow>(
    "SELECT version, name, checksum FROM schema_migrations",
  );
  const byVersion = new Map(applied.map((row) => [Number(row.version), row]));
  const maxApplied = applied.reduce((max, row) => Math.max(max, Number(row.version)), 0);

  const didApply: string[] = [];
  const didSkip: string[] = [];

  for (const migration of migrations) {
    const previous = byVersion.get(migration.version);

    if (previous) {
      if (previous.checksum !== migration.checksum) {
        throw new MigrationError(
          `Migration ${migration.filename} has changed since it was applied ` +
            `(recorded ${previous.checksum.slice(0, 12)}, ` +
            `now ${migration.checksum.slice(0, 12)}). ` +
            `Migrations are forward-only — add a new one instead of editing this.`,
        );
      }
      didSkip.push(migration.filename);
      continue;
    }

    // Forward-only means forward. A new migration must be newer than everything
    // already applied; a lower unapplied version means two branches numbered
    // migrations independently and the higher one deployed first. Applying the
    // lower one now would build the schema in an order it was never tested in.
    if (migration.version < maxApplied) {
      throw new MigrationError(
        `Migration ${migration.filename} (version ${migration.version}) is older than ` +
          `the latest applied version (${maxApplied}). ` +
          `Migrations are forward-only — renumber it above ${maxApplied} and rebase.`,
      );
    }

    await db.exec("BEGIN");
    try {
      await db.exec(migration.sql);
      await db.query(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migration.checksum],
      );
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw new MigrationError(
        `Migration ${migration.filename} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    didApply.push(migration.filename);
  }

  return { applied: didApply, skipped: didSkip };
}
