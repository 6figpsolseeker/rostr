import { describe, expect, it } from "vitest";
import { ESCROW_IDL } from "./idl.js";
import { instructionNames, potDepositGate, settlementShipped } from "./settlement.js";

/**
 * The instructions the program has today.
 *
 * Pinned deliberately. See the tripwire test at the bottom of this file for why
 * this list is the thing that opens the mainnet deposit gate.
 */
const TODAY = [
  "deposit",
  "initialize_free_league",
  "initialize_league",
  "join_league",
  "refund_stake",
  // Added 2026-08-17 with the failed-league refund (#170). It closes a refund
  // window; it pays nobody, so the gate below must stay shut — see the test
  // that says so explicitly.
  "start_season",
];

const settled = { instructions: [...TODAY, "settle_league"].map((name) => ({ name })) };

describe("settlementShipped", () => {
  it("is false for the program as it stands", () => {
    expect(settlementShipped(ESCROW_IDL)).toBe(false);
  });

  /**
   * `start_season` must never read as settlement, and the margin is one letter.
   *
   * `SETTLEMENT_PREFIXES` matches on `startsWith`, and "start" and "settle"
   * share their first two characters. Had the prefixes been looser — "s", or a
   * substring match — adding this instruction would have silently opened the
   * mainnet deposit gate on a program that still cannot pay a pot out, which is
   * the exact failure the gate exists to prevent.
   *
   * It closes a refund window. It moves nothing to anybody.
   */
  it("does not count start_season, which pays nobody", () => {
    expect(instructionNames(ESCROW_IDL)).toContain("start_season");
    expect(settlementShipped(ESCROW_IDL)).toBe(false);
    expect(potDepositGate("mainnet-beta", ESCROW_IDL)).toEqual({
      open: false,
      reason: "SETTLEMENT_NOT_SHIPPED",
    });
  });

  it("is true once an instruction that pays a pot out exists", () => {
    expect(settlementShipped(settled)).toBe(true);
  });

  it("does not mistake refund_stake for settlement", () => {
    // The trap this whole gate exists for: a refund returns your own stake, it
    // does not pay a champion. A prefix list that matched "refund" would read
    // the escape hatch as the payout and open the gate on a program that still
    // cannot award a prize.
    expect(settlementShipped({ instructions: [{ name: "refund_stake" }] })).toBe(false);
  });
});

describe("potDepositGate", () => {
  it("closes mainnet while the program cannot pay a pot out", () => {
    expect(potDepositGate("mainnet-beta", ESCROW_IDL)).toEqual({
      open: false,
      reason: "SETTLEMENT_NOT_SHIPPED",
    });
  });

  it("leaves every other cluster open", () => {
    // Not a loophole. The funding path has to be exercisable end to end — that
    // is the Aug 22 milestone — and no real money is at risk off mainnet.
    for (const cluster of ["devnet", "testnet", "localnet"] as const) {
      expect(potDepositGate(cluster, ESCROW_IDL)).toEqual({ open: true });
    }
  });

  it("opens mainnet on the program's interface, not on a date or a variable", () => {
    expect(potDepositGate("mainnet-beta", settled)).toEqual({ open: true });
  });
});

describe("the tripwire", () => {
  it("pins the program's instruction list", () => {
    // This test exists to fail, once, on the commit that ships settlement.
    //
    // `potDepositGate` opens when it recognises a settlement instruction by
    // name prefix, and those prefixes are a guess. A wrong guess fails in the
    // dangerous direction — the gate stays shut and nobody notices, or worse,
    // somebody deletes the gate rather than teaching it the new name.
    //
    // So pin the list. When D6 lands, `pnpm idl:sync` moves this and the
    // failure lands here, in the file that decides whether mainnet can take a
    // buy-in, with instructions attached.
    //
    // If you are reading this because the test just failed: check that
    // `SETTLEMENT_PREFIXES` in `settlement.ts` matches whatever the new
    // instruction is called, confirm `potDepositGate("mainnet-beta")` is now
    // open, then add the name below.
    expect(instructionNames(ESCROW_IDL).sort()).toEqual(TODAY);
  });

  it("keeps the gate shut on an IDL whose shape has moved", () => {
    // A regenerated IDL that no longer looks like this should read as "no
    // settlement here" rather than throwing — this runs behind a page a
    // stranger can load, and the safe answer is the closed one.
    expect(settlementShipped({ instructions: [null, 42, {}, { name: 7 }] })).toBe(false);
    expect(potDepositGate("mainnet-beta", { instructions: [null] })).toEqual({
      open: false,
      reason: "SETTLEMENT_NOT_SHIPPED",
    });
  });
});
