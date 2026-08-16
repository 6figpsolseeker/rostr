import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./vitest.alias.js";

/**
 * Program tests — a separate project from `pnpm test` on purpose.
 *
 * The 630 tests under `packages/` run against pure functions and PGlite, so
 * they need no service, no credentials, and no chain. These need a validator
 * with the program deployed, which `anchor test` provides. Mixing them would
 * mean the fast suite could no longer be run by anyone who has not installed
 * the Solana toolchain.
 *
 * Run via `anchor test`, not directly — it builds, starts the validator,
 * deploys, and sets ANCHOR_PROVIDER_URL and ANCHOR_WALLET for the client.
 */
export default defineConfig({
  resolve: {
    // Resolved to source, like the other two projects. The point of aliasing
    // `@rostr/escrow` here is that the program suite can then check the client's
    // address derivation against the program's own — the only place those two
    // can be compared.
    //
    // `@rostr/db` and `@rostr/core` are here for the same reason, and for one
    // more: `anchor.test.ts` drives create → anchor → join across both halves,
    // which is the only place the database's gate and the chain's account can be
    // checked against each other rather than each against a stand-in.
    //
    // The shared list, not a curated subset — a package this suite never imports
    // costs nothing, and curating the subsets is what let the web project drift.
    // The web entries are omitted because nothing under `programs/` loads
    // `apps/web`, and `server-only` is a Next marker with no meaning here.
    alias: [...workspaceAliases],
  },
  test: {
    include: ["programs/*/tests/**/*.test.ts"],
    // A cold validator plus deploy is slow, and the default 5s timeout expires
    // partway through the first confirmation.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Every test in a file shares one validator and one program. Running files
    // in parallel against a single ledger makes airdrops and blockhashes race.
    fileParallelism: false,
  },
});
