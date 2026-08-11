import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkgFile = (pkg: string, file: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/${file}`, import.meta.url));

const src = (pkg: string): string => pkgFile(pkg, "index.ts");

export default defineConfig({
  resolve: {
    // Resolve workspace packages to source rather than dist. Tests then never
    // depend on build order, and a stale dist cannot produce a passing or
    // failing run that disagrees with the code in front of you.
    // The array form, not the object one: object keys match exactly, and two of
    // these need to match a prefix.
    alias: [
      // Subpath exports, before the bare name. `@rostr/db` is an exact match and
      // would not cover `@rostr/db/postgres`, which would then fall through to
      // node resolution and load `dist` — the stale-build problem these aliases
      // exist to remove, reappearing only for the subpaths.
      { find: "@rostr/db/postgres", replacement: pkgFile("db", "postgres.ts") },
      { find: "@rostr/db/migrate", replacement: pkgFile("db", "migrate.ts") },
      { find: "@rostr/db/testing", replacement: pkgFile("db", "testing.ts") },

      { find: "@rostr/core", replacement: src("core") },
      { find: "@rostr/db", replacement: src("db") },
      { find: "@rostr/escrow", replacement: src("escrow") },
      { find: "@rostr/pinning", replacement: src("pinning") },
      { find: "@rostr/stats", replacement: src("stats") },

      // The web app's own path alias, mirroring `apps/web/tsconfig.json`. A
      // route test importing `./route.js` pulls in `@/lib/db` transitively, so
      // without this the file cannot even be collected, let alone skipped.
      {
        find: /^@\/(.*)$/,
        replacement: `${fileURLToPath(new URL("./apps/web/src/", import.meta.url))}$1`,
      },

      // See the stub for why this is a stub rather than a change to the five
      // files that import it.
      {
        find: "server-only",
        replacement: fileURLToPath(new URL("./test-stubs/server-only.ts", import.meta.url)),
      },
    ],
  },
  test: {
    /**
     * `apps/web` is included, and it was not.
     *
     * `apps/web/src/app/api/cron/score-week/route.test.ts` was written to prove
     * that one league's failure cannot stop the others scoring — a guard that
     * had already shipped once in a shape that did not hold. Its own docstring
     * says `apps/web` had no test project "so the guard was argued about rather
     * than run". It then sat outside this pattern and was never collected, so it
     * went on being argued about.
     *
     * A test that exists and never runs is worse than no test: it reads as
     * coverage in a diff and in a review, and it is not.
     *
     * Most of what it needs is a real Postgres, so it is `skipIf(!DATABASE_URL)`
     * and still skips here. That is the point — skipped is a state you can see,
     * and on a machine with the variable set it now actually runs.
     */
    include: ["packages/*/src/**/*.test.ts", "apps/web/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts"],
    },
  },
});
