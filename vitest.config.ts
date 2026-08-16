import { defineConfig } from "vitest/config";
import { webAliases } from "./vitest.alias.js";

export default defineConfig({
  resolve: {
    // Shared with the web and program projects — see `vitest.alias.ts` for why
    // they are one list and why the order in it is load-bearing. This project
    // collects `apps/web` as well as `packages`, so it takes the web set.
    alias: [...webAliases],
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
