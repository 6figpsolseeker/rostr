import { describe, expect, it } from "vitest";
import { ESCROW_IDL } from "./idl.js";
import { instructionNames, potDepositGate, settlementShipped } from "./settlement.js";

/**
 * The instructions the program has today.
 *
 * Pinned deliberately. See the tripwire test at the bottom of this file for why
 * this list is the thing that opens the mainnet deposit gate.
 */
/**
 * Sorted, because the assertion sorts the actual list and compares it to this
 * one as written. A new name goes in its alphabetical place, not at the end.
 *
 * `finalize_week`, `initialize_scores` and `post_week` arrived 2026-08-17 with
 * G7. All three write a payee roster or a set of results and **move no tokens**,
 * so the gate must still be shut with them present — the test below asserts
 * that explicitly, and it is the one that matters. Settlement is the
 * instruction that spends the vault, and it does not exist.
 */
const TODAY = [
  "deposit",
  "finalize_week",
  "initialize_free_league",
  "initialize_league",
  "initialize_scores",
  "join_league",
  "post_week",
  "refund_stake",
  // Added 2026-08-18 with D6/G9. **This is the one that opens the gate.**
  "settle",
  // Added 2026-08-17 with the failed-league refund (#170). It closes a refund
  // window; it pays nobody, so the gate below must stay shut — see the test
  // that says so explicitly.
  "start_season",
];

const settled = { instructions: [...TODAY, "settle_league"].map((name) => ({ name })) };

describe("settlementShipped", () => {
  it("is true, because `settle` shipped 2026-08-18", () => {
    // This assertion read `false` from the day the gate was written until D6
    // landed. Flipping it is the event the gate exists for, and the comment on
    // the tripwire below is what forced somebody to come here and do it
    // deliberately rather than discover it in production.
    expect(settlementShipped(ESCROW_IDL)).toBe(true);
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
    // Asserted against a synthetic IDL now that the real one contains `settle`.
    // The margin is still one letter and still worth pinning: had the prefixes
    // been looser — "s", or a substring match — `start_season` would have opened
    // the gate a day early, on a program that could not pay.
    expect(settlementShipped({ instructions: [{ name: "start_season" }] })).toBe(false);
    expect(
      potDepositGate("mainnet-beta", { instructions: [{ name: "start_season" }] }),
    ).toEqual({
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
  it("closes mainnet on a program that cannot pay a pot out", () => {
    // Against a synthetic IDL, because the real one now can. This is the rule
    // the gate encodes, and it outlives the day it flipped.
    expect(
      potDepositGate("mainnet-beta", { instructions: [{ name: "refund_stake" }] }),
    ).toEqual({
      open: false,
      reason: "SETTLEMENT_NOT_SHIPPED",
    });
  });

  /**
   * **Mainnet deposits are open as of 2026-08-18, and this is the assertion that
   * says so.**
   *
   * The gate's rule is "a mainnet buy-in is invited only once the program has an
   * instruction that can pay it back out", and `settle` is that instruction. The
   * rule is satisfied.
   *
   * What the rule does not say, and cannot check, is that the payout has ever
   * *run*. It has not. `settle` refuses until seven days after the last week is
   * finalised, which no wall-clock validator test can reach — so the program
   * suite covers every refusal and not the successful transfer. The derivation
   * and the arithmetic are covered as Rust units in `scores.rs`.
   *
   * That gap is real and is recorded in `docs/SETTLEMENT.md` §10 rather than
   * papered over here. If mainnet deposits should stay shut until the success
   * path is exercised, that is a decision to take deliberately — and the honest
   * place for it is a new condition on the gate, not a test that lies about what
   * the IDL contains.
   */
  it("is open on mainnet now that settle exists", () => {
    expect(potDepositGate("mainnet-beta", ESCROW_IDL)).toEqual({ open: true });
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
