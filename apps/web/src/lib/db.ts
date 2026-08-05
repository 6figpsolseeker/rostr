import "server-only";

import { createPostgresClient } from "@rostr/db/postgres";
import type { PostgresClient } from "@rostr/db/postgres";

let client: PostgresClient | undefined;

/**
 * The shared connection pool.
 *
 * Next recreates modules across hot reloads in development, so the pool is
 * cached on `globalThis` to avoid opening a new one on every edit and
 * exhausting Supabase's connection limit.
 */
export function db(): PostgresClient {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. See docs/SETUP-REQUIRED.md — a Supabase project is needed to run against a real database.",
    );
  }

  const cache = globalThis as { __rostrDb?: PostgresClient };
  client ??= cache.__rostrDb ?? createPostgresClient(url);
  cache.__rostrDb = client;
  return client;
}
