/**
 * The narrowest database interface this package needs.
 *
 * Deliberately small so it can be satisfied by PGlite in tests, node-postgres
 * against Supabase in production, or a transaction handle from either — without
 * this package depending on any of them.
 */
export interface SqlClient {
  /** Run one or more statements. No parameters, no results. */
  exec(sql: string): Promise<void>;

  /** Run a single parameterised statement and return its rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;

  /**
   * Check out a dedicated connection for a transaction, so every statement in it
   * shares one connection. Present on pool-backed clients (see `PostgresClient`);
   * absent on a single connection — PGlite, or a connection already checked out —
   * where the client is used directly. `withTransaction` relies on this.
   */
  connect?(): Promise<{ client: SqlClient; release: () => void }>;
}
