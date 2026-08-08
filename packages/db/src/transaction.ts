import type { SqlClient } from "./client.js";

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 *
 * BEGIN, the work, and COMMIT must all run on one connection — otherwise the
 * transaction is not atomic and any `SELECT ... FOR UPDATE` inside `fn` holds no
 * lock. A pool hands each statement to an arbitrary connection, so when the
 * client can check one out (`connect`), this does, and runs the whole callback
 * on that pinned connection. PGlite (single connection) and an already
 * checked-out client have no `connect` and run directly.
 */
export async function withTransaction<T>(
  db: SqlClient,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  if (db.connect) {
    const { client, release } = await db.connect();
    try {
      return await runTransaction(client, fn);
    } finally {
      release();
    }
  }
  return runTransaction(db, fn);
}

async function runTransaction<T>(db: SqlClient, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
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
