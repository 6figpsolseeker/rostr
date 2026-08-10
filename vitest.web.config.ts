import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
 */
export default defineConfig({
  resolve: {
    alias: {
      // `server-only` is a build-time guard for the Next bundler. Under vitest
      // its default export throws, so it is stubbed rather than worked around
      // by deleting the import — the import is correct and should stay.
      "server-only": fileURLToPath(new URL("./apps/web/test/server-only.ts", import.meta.url)),
      "@/": fileURLToPath(new URL("./apps/web/src/", import.meta.url)),
      // Workspace packages resolved to **source**, like the program config.
      //
      // Without this they resolve to `dist/`, and `dist/` is whatever was last
      // built — so a test can silently exercise stale or newer code than the
      // source in the tree. That is not a hypothetical: a check of this very
      // suite against reverted source passed, because `dist/` still held the
      // fix. Order matters, vite prefix-matches.
      "@rostr/db/postgres": fileURLToPath(
        new URL("./packages/db/src/postgres.ts", import.meta.url),
      ),
      "@rostr/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
      "@rostr/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@rostr/escrow": fileURLToPath(
        new URL("./packages/escrow/src/index.ts", import.meta.url),
      ),
    },
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
