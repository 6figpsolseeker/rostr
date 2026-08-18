import { afterEach, describe, expect, it, vi } from "vitest";
import { depositsOpen } from "./pot.js";

/**
 * The mainnet deposit gate, bound to this deployment's declared cluster.
 *
 * The rule is tested in `packages/escrow/src/settlement.test.ts`. What is tested
 * here is the binding — and in particular that a deployment which cannot say
 * which chain it is on answers "closed" rather than throwing, because this runs
 * on a page that strangers are meant to be able to read.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("depositsOpen", () => {
  /**
   * **Open on mainnet as of 2026-08-18**, because `settle` shipped.
   *
   * This assertion read `false` for as long as the program could take a buy-in
   * and not pay it back out. Flipping it is the whole point of binding the gate
   * to the committed IDL rather than to a date or an environment variable: the
   * commit that shipped the payout is the commit that opened the deposit, and it
   * could not do one without visiting the other.
   *
   * The caveat is in `settlement.test.ts` and `docs/SETTLEMENT.md` §10: the
   * payout's *success* path has never executed, because the seven-day hold
   * cannot be reached on a wall-clock validator. What is covered is every
   * refusal, plus the derivation and the arithmetic as Rust units.
   */
  it("is open on mainnet now that the program can pay a pot out", () => {
    vi.stubEnv("SOLANA_CLUSTER", "mainnet-beta");
    expect(depositsOpen()).toBe(true);
  });

  it.each(["devnet", "testnet", "localnet"])("is open on %s", (cluster) => {
    vi.stubEnv("SOLANA_CLUSTER", cluster);
    expect(depositsOpen()).toBe(true);
  });

  it("is closed, and does not throw, when the cluster is unset in production", () => {
    // The assertion that matters most. `declaredCluster()` throws here, and
    // this is called from the league page — which is deliberately readable by
    // people who are not members. If the throw escaped, one missing environment
    // variable would 500 the entrance to every league rather than closing a
    // button nobody should be pressing yet.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SOLANA_CLUSTER", "");
    expect(() => depositsOpen()).not.toThrow();
    expect(depositsOpen()).toBe(false);
  });

  it("is closed, and does not throw, when the cluster names nothing", () => {
    vi.stubEnv("SOLANA_CLUSTER", "mainnet");
    expect(() => depositsOpen()).not.toThrow();
    expect(depositsOpen()).toBe(false);
  });
});
