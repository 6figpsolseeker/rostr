import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
    // Resolved to source, like the main config. The point of aliasing it here
    // is that the program suite can then check the client's address derivation
    // against the program's own — the only place those two can be compared.
    alias: {
      "@rostr/escrow": fileURLToPath(
        new URL("./packages/escrow/src/index.ts", import.meta.url),
      ),
    },
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
