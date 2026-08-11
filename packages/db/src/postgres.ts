/**
 * node-postgres adapter, for production against Supabase.
 *
 * Kept in its own module so importing `@rostr/db` in a browser bundle does not
 * drag in `pg`. Server code imports this path explicitly.
 */

import { Pool } from "pg";
import type { PoolClient } from "pg";
import type { SqlClient } from "./client.js";

export class PostgresClient implements SqlClient {
  constructor(private readonly pool: Pool) {}

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query(sql, params as unknown[]);
    return result.rows as T[];
  }

  /**
   * Check out a single connection.
   *
   * Required for anything transactional: a pool hands each query to an
   * arbitrary connection, so a BEGIN and the work that follows could land on
   * different ones. It is also required for session state — a `SET`, or a
   * session advisory lock — which is meaningless if the next statement is
   * served by a different session.
   *
   * Within this package `withTransaction` and `migrate` each check one out
   * rather than being given the pool, and they hold it for different spans —
   * which is why `migrate` does not simply use `withTransaction`. A transaction
   * lasts one callback; a migration run lasts a lock plus a transaction per
   * file, and a lock is worthless on a connection that is handed back between
   * statements. Routes that need a transaction across several calls check out
   * directly too.
   */
  async connect(): Promise<{ client: SqlClient; release: () => void }> {
    const connection = await this.pool.connect();
    return {
      client: new PooledClient(connection),
      release: () => {
        connection.release();
      },
    };
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

class PooledClient implements SqlClient {
  constructor(private readonly connection: PoolClient) {}

  async exec(sql: string): Promise<void> {
    await this.connection.query(sql);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.connection.query(sql, params as unknown[]);
    return result.rows as T[];
  }
}

export function createPostgresClient(connectionString: string): PostgresClient {
  return new PostgresClient(
    new Pool({
      connectionString,
      // Supabase terminates plaintext connections; its CA is not in the default
      // Node trust store on every platform.
      ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 10,

      // Every transaction now checks out a connection rather than dispatching
      // per statement (see `withTransaction`), which is what makes a transaction
      // atomic and a `FOR UPDATE` hold a real lock. It also means checkout is on
      // the hot path for the first time.
      //
      // `pool.connect()` waits **forever** by default when all `max` are busy.
      // On Vercel that turns saturation from "slow" into "every request hangs
      // until the function times out" — the pool never refuses, so nothing sheds
      // load and nothing surfaces an error anyone can act on. Ten seconds is
      // long enough to ride out a slow query and short enough to fail visibly.
      connectionTimeoutMillis: 10_000,

      // Serverless functions are suspended and resumed unpredictably, so idle
      // connections rot: the pool believes it holds a connection the server has
      // already dropped. Recycling them keeps that window small.
      idleTimeoutMillis: 30_000,

      // A statement that has run for thirty seconds is not going to finish
      // usefully, and while it runs it holds a pooled connection and any locks
      // it took. Bounding it server-side is the only thing that helps once a
      // query is already stuck.
      //
      // Migrations are the exception and lift it per transaction (`migrate.ts`),
      // because `db:migrate` runs on this same pool: a `CREATE INDEX` on a
      // populated table runs for minutes and would otherwise be cancelled here,
      // leaving a migration that can never succeed.
      statement_timeout: 30_000,

      // The failure this actually guards against: a transaction that opened,
      // stopped making progress, and holds row locks. Everything blocked behind
      // it waits. Ours are short — a draft pick, a lineup write — so anything
      // idle in a transaction for a minute is already broken.
      idle_in_transaction_session_timeout: 60_000,
    }),
  );
}
