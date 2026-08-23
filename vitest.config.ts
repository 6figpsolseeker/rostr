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

    /**
     * Sixty seconds, matching every other project config in this repo — and this
     * file carried **no timeout at all**, so it ran on vitest's 5-second default.
     *
     * That was never right for what these tests do. Most of them build a fresh
     * PGlite database — real Postgres compiled to WASM, migrated from zero — per
     * test, which costs a second or more on an idle machine and several under
     * load. The suite has been passing on the margin and losing a little of it
     * with every test added.
     *
     * It surfaced as `settlementPlan` timing out at 5001ms with "PGlite is
     * closed", in a run made slower by ten new tests in a different file. The
     * same suite passes in isolation at ~1.2s a test. `CLAUDE.md` already
     * records this shape for the program suite — "fix the window, not the flake"
     * — and the window here is a default nobody chose.
     *
     * A test that genuinely hangs still fails. It just does so on evidence
     * rather than on how busy the machine happened to be.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts"],
    },
  },
});
