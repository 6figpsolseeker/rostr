import { defineConfig } from "vitest/config";
import { webAliases } from "./vitest.alias.js";

/**
 * `apps/web` tests — the project this repo has never had.
 *
 * Routes were verified only by being run in production. That is how a cron
 * guard shipped whose whole purpose was to stop one league's failure taking the
 * others down, with nothing exercising it: the logic under a route can be
 * argued about but not run, and an argument is not a test.
 *
 * Separate from the main project because these need a real Postgres —
 * `apps/web/src/lib/db.ts` builds a node-postgres pool from `DATABASE_URL`, and
 * PGlite is not that. `pnpm test` must keep needing no credentials.
 *
 * Run with `pnpm test:web`, which requires `DATABASE_URL`.
 *
 * Its aliases used to be a second hand-maintained copy of the main project's,
 * and had drifted: `@rostr/db/testing` was missing, so `visibility.test.ts`
 * failed to collect here while passing under `pnpm test`. The `@/` entry also
 * read `"@/"` with a trailing slash rather than the regex the main project uses,
 * which matches a different set of specifiers. Both lists are now one list.
 */
export default defineConfig({
  resolve: {
    alias: [...webAliases],
  },
  test: {
    include: ["apps/web/src/**/*.test.ts"],
    // A real database round trip, and these seed whole leagues.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One database. Parallel files would race on the same rows.
    fileParallelism: false,
  },
});
