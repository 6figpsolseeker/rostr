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
}
