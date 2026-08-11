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

/**
 * The advisory lock one migration run holds for its whole length, as a
 * `(class, id)` pair.
 *
 * Advisory locks share a single namespace per database and nothing else in this
 * repo takes one, so the numbers are arbitrary. `0x726f7374` is "rost" in ASCII,
 * which is a mnemonic for whoever reads this file — but `pg_locks.classid`
 * renders it as **1919906676**, so that is the number to grep for when working
 * out what is blocking a deploy. The refusal message below quotes it directly.
 */
const MIGRATION_LOCK_CLASS = 0x726f7374;
const MIGRATION_LOCK_ID = 1;

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
 *
 * Running two at once is **refused**, not serialised — *when this is given a
 * pool*. The run then checks out one connection for its whole length, holds a
 * session advisory lock on it, and a second run that finds the lock taken says
 * so and exits. Re-run it afterwards: forward-only migrations make that a no-op.
 *
 * Given a client that is already a single connection (PGlite in tests, or one a
 * caller checked out), there is no lock — see below.
 */
export async function migrate(
  db: SqlClient,
  migrations: readonly Migration[] = loadMigrations(),
): Promise<MigrateResult> {
  // Every statement below has to reach the same connection, and a pool hands
  // each one to an arbitrary connection — the docstring on
  // `PostgresClient.connect` states this rule and this function was the one
  // place in the repo still breaking it. Two things rest on it:
  //
  //   - **Each migration's DDL and its `schema_migrations` row are one
  //     transaction.** A `BEGIN` binds to a session, so if the DDL lands on a
  //     different connection it runs outside that transaction and commits on its
  //     own. Should the row then fail to write, the schema has changed without
  //     being recorded, and the next run re-applies the same file and dies on
  //     "already exists" — which forward-only migrations have no way back from.
  //   - **The advisory lock is a *session* lock.** Taken on one connection and
  //     released from another, it excludes nobody and is left behind on a
  //     connection that goes on serving other work.
  //
  // This deliberately does not go through `withTransaction`. That checks a
  // connection out and releases it per call, so the lock and each migration's
  // transaction would land on different ones; the loop needs a transaction per
  // migration on a connection held across the whole run.
  if (!db.connect) {
    // One connection already, and it is the caller's: PGlite in tests, or a
    // client someone has checked out and passed in. Run on it directly, exactly
    // as `withTransaction` does.
    //
    // **No lock, and that is a real gap rather than a proof of safety.** For
    // PGlite it is safe for a reason particular to PGlite: a private in-process
    // database with no second session to race. For a caller-supplied connection
    // it is not safe, it is simply undecidable from here — we cannot know
    // whether they are mid-transaction, already hold the lock, or want it. The
    // two callers in this repo are `cli.ts` (a pool, so locked) and
    // `createTestDatabase` (PGlite). A third caller passing a checked-out
    // connection would silently get no mutual exclusion.
    return applyPending(db, migrations);
  }

  const { client, release } = await db.connect();
  try {
    await acquireMigrationLock(client);
    try {
      return await applyPending(client, migrations);
    } finally {
      // Give the lock back before the connection returns to the pool. A session
      // lock left on it is inherited by whoever checks it out next, and every
      // later run that lands on a different connection would then refuse
      // forever. This can only fail if the session is already gone — which drops
      // the lock anyway — so it must not mask the error that killed it.
      await client
        .query("SELECT pg_advisory_unlock($1, $2)", [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_ID])
        .catch(() => undefined);
    }
  } finally {
    release();
  }
}

/**
 * Claim the run, or refuse.
 *
 * `pg_try_advisory_lock` rather than `pg_advisory_lock`, which waits: waiting is
 * how a deploy hangs, and under the pool's `statement_timeout` the wait would be
 * cut short anyway by an error naming the timeout instead of the real cause.
 * Refusing costs nothing here — the other run is applying these same files, and
 * re-running once it finishes is a no-op.
 *
 * It is taken before `schema_migrations` is created or read, not just around the
 * writes. Two runs that both read the pending set before either applies anything
 * would both decide to apply it; and concurrent `CREATE TABLE IF NOT EXISTS` can
 * fail outright on a duplicate key in the catalogue rather than yielding.
 */
async function acquireMigrationLock(db: SqlClient): Promise<void> {
  const [row] = await db.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1, $2) AS locked",
    [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_ID],
  );

  if (row?.locked !== true) {
    throw new MigrationError(
      "Could not take the migration lock on this database, so this run stopped " +
        "rather than race another one: both would read the same pending set and " +
        "apply the same files.\n\n" +
        "Usually another run holds it — wait for it and re-run, which is free " +
        "because applied migrations are skipped.\n\n" +
        "If no other run exists, the lock is stranded, and this message is " +
        "blaming a run that does not exist. Find its holder with:\n" +
        "  SELECT pid, state FROM pg_locks JOIN pg_stat_activity USING (pid)\n" +
        "   WHERE locktype = 'advisory' AND classid = 1919906676 AND objid = 1;\n" +
        "An idle holder can be cleared with pg_terminate_backend(pid). A " +
        "transaction-mode pooler strands the lock this way on every run — if " +
        "that is the shape of it, check the port before anything else.",
    );
  }
}

/** The run itself, on a connection the caller has already pinned. */
async function applyPending(
  db: SqlClient,
  migrations: readonly Migration[],
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
        // Two different files at the same version look exactly like one edited
        // file, because the check keys on version alone. They need opposite
        // remedies, so say which this is: "add a new one instead of editing
        // this" is useless advice for a numbering collision, and it is the more
        // likely of the two on a project developed in parallel.
        const collision = previous.name !== migration.name;

        throw new MigrationError(
          collision
            ? `Migration version ${migration.version} is recorded as ` +
                `"${previous.name}" but is "${migration.name}" on disk. Two branches ` +
                `numbered a migration independently — this is a collision, not an ` +
                `edit. See packages/db/migrations/README.md.`
            : `Migration ${migration.filename} has changed since it was applied ` +
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
          `Migrations are forward-only — renumber it above ${maxApplied} and rebase, ` +
          `but only if this file has not already run on this database. If it has, ` +
          `renumbering makes it re-run and fail. See packages/db/migrations/README.md.`,
      );
    }

    await db.exec("BEGIN");
    try {
      // A migration is not a request. The pool sets `statement_timeout` to 30s
      // (see `postgres.ts`) because a query still running after thirty seconds
      // is stuck and is holding a connection — but a `CREATE INDEX` on a
      // populated table legitimately runs for minutes, and being cancelled at
      // thirty seconds makes that migration one that can never succeed, on the
      // one database where it matters. Today's tables are empty, so this is
      // latent rather than broken; `stat_lines` will not be empty for long.
      //
      // `SET LOCAL` reverts at COMMIT or ROLLBACK, so the connection cannot
      // carry the exemption back into the pool and hand it to a request.
      await db.exec("SET LOCAL statement_timeout = 0");

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
