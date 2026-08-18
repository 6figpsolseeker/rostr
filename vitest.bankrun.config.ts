import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./vitest.alias.js";

/**
 * Program tests that need a clock rather than a chain.
 *
 * A third project, and the reason is one instruction. `settle` refuses until
 * seven days after the last week is finalised — the window in which anyone can
 * compare the posted scores against the providers before money moves — so no
 * wall-clock validator can ever reach the successful payout. `solana-bankrun`
 * loads the same compiled program in-process and lets the `Clock` sysvar be set
 * directly, so the seven days pass in a line of code.
 *
 * **Separate from `vitest.program.config.ts` because it does not want a
 * validator, not merely because it does not need one.** Run inside `anchor
 * test` the payout test passed alone in under a second and timed out at three
 * minutes beside a running validator, competing with it for the machine. There
 * is nothing for the two to share: bankrun never opens a socket.
 *
 * It does need the built artifact, so `anchor build` (or `anchor test`) has to
 * have run. `BPF_OUT_DIR` is where bankrun looks and where Anchor writes.
 *
 * **Linux only** — the native binding publishes no win32 build. That is the
 * same constraint the Anchor toolchain already imposes, so it costs nothing
 * here: WSL locally, Linux in CI.
 *
 *   pnpm test:bankrun
 */
export default defineConfig({
  resolve: { alias: [...workspaceAliases] },
  test: {
    include: ["programs/*/tests/**/*.bankrun.test.ts"],
    env: { BPF_OUT_DIR: "target/deploy" },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
