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
   * different ones. `withTransaction` must be given one of these, not the pool.
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
    }),
  );
}
