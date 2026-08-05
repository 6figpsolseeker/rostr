import type { SqlClient } from "./client.js";

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 *
 * Note for production: this issues BEGIN/COMMIT on whichever client it is given.
 * That is correct for PGlite (single connection) and for a checked-out
 * node-postgres client, but **not** for a pool — a pool hands each query to an
 * arbitrary connection, so the BEGIN and the work can land on different ones.
 * Check out a client first and pass that.
 */
export async function withTransaction<T>(
  db: SqlClient,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  await db.exec("BEGIN");
  try {
    const result = await fn(db);
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}
