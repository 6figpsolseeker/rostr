import { fileURLToPath } from "node:url";

/**
 * The workspace aliases, in one place, for all three vitest projects.
 *
 * ## Why they exist at all
 *
 * Every `@rostr/*` package resolves to **source** rather than `dist/`. Without
 * that, a test exercises whatever was last built, so a run can pass against code
 * that is not the code in front of you. That is not hypothetical — a check of
 * the web suite against reverted source passed, because `dist/` still held the
 * fix.
 *
 * ## Why they are shared rather than repeated
 *
 * There were three copies: `vitest.config.ts`, `vitest.web.config.ts` and
 * `vitest.program.config.ts`. They had drifted, and the drift was a live defect
 * rather than untidiness — the web project was missing `@rostr/db/testing`, so
 * `visibility.test.ts` could not resolve its own imports and failed to collect
 * under `pnpm test:web` while passing under `pnpm test`. A test that passes in
 * one project and cannot load in another is worse than a failing one: the green
 * run is the one people quote.
 *
 * The ordering rule that fixes it was **already written down**, in the program
 * config's own comment, and had simply never reached the web config. Copying the
 * missing entry across would have left three lists to keep in step and the next
 * package one omission away from the same bug. So there is one list.
 *
 * ## The ordering rule
 *
 * Vite prefix-matches: a `find` of `@rostr/db` matches `@rostr/db/testing` too,
 * and rewrites it to `…/db/src/index.ts/testing`, which does not exist. **Every
 * subpath must come before its bare package name.** The array form is used for
 * exactly this reason — object keys give no ordering guarantee worth relying on
 * for correctness, and the array says the order is load-bearing.
 */

type Alias = { find: string | RegExp; replacement: string };

const pkgFile = (pkg: string, file: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/${file}`, import.meta.url));

const src = (pkg: string): string => pkgFile(pkg, "index.ts");

/**
 * Subpaths first, then bare names. See the ordering rule above before adding.
 *
 * A package listed here that a project never imports costs nothing — the alias
 * simply never fires — so all three projects take the whole list rather than
 * each curating a subset. Curating the subsets is what produced the bug.
 */
export const workspaceAliases: readonly Alias[] = [
  { find: "@rostr/db/postgres", replacement: pkgFile("db", "postgres.ts") },
  { find: "@rostr/db/migrate", replacement: pkgFile("db", "migrate.ts") },
  { find: "@rostr/db/testing", replacement: pkgFile("db", "testing.ts") },

  { find: "@rostr/core", replacement: src("core") },
  { find: "@rostr/db", replacement: src("db") },
  { find: "@rostr/escrow", replacement: src("escrow") },
  { find: "@rostr/pinning", replacement: src("pinning") },
  { find: "@rostr/stats", replacement: src("stats") },
];

/**
 * The web app's own path alias, mirroring `apps/web/tsconfig.json`.
 *
 * A route test importing `./route.js` pulls in `@/lib/db` transitively, so
 * without this the file cannot even be collected, let alone skipped.
 */
export const webSrcAlias: Alias = {
  find: /^@\/(.*)$/,
  replacement: `${fileURLToPath(new URL("./apps/web/src/", import.meta.url))}$1`,
};

/**
 * Next's `server-only` marker, stubbed for the runner.
 *
 * There were two stubs — `test-stubs/server-only.ts` and an undocumented
 * `apps/web/test/server-only.ts` containing `export {}` and no explanation of
 * why it was there. One is enough; see the stub itself for why it is a stub
 * rather than a change to the files that import it.
 */
export const serverOnlyAlias: Alias = {
  find: "server-only",
  replacement: fileURLToPath(new URL("./test-stubs/server-only.ts", import.meta.url)),
};

/** Everything a project that loads `apps/web` code needs. */
export const webAliases: readonly Alias[] = [...workspaceAliases, webSrcAlias, serverOnlyAlias];
