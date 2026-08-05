/**
 * PGlite adapter for tests.
 *
 * PGlite is real Postgres compiled to WASM, running in-process. No service, no
 * Docker, no connection string — so migrations and constraints are genuinely
 * exercised rather than mocked, and CI needs no service containers.
 *
 * Test-only. Production uses node-postgres against Supabase.
 */

import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "./client.js";
import { migrate } from "./migrate.js";

export class PGliteClient implements SqlClient {
  constructor(private readonly db: PGlite) {}

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.db.query<T>(sql, params as unknown[]);
    return result.rows;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/** A fresh in-memory database with every migration applied. */
export async function createTestDatabase(): Promise<PGliteClient> {
  const client = new PGliteClient(new PGlite());
  await migrate(client);
  return client;
}
