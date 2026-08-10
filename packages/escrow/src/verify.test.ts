import { describe, it, expect } from "vitest";
import { anchorTermMismatches, expectedTermsFromRules } from "./verify.js";
import type { ExpectedTerms, OnChainLeague } from "./verify.js";
import { PublicKey } from "@solana/web3.js";

/**
 * The security property: verifying a league anchor by its rules hash is not
 * enough, because the program stores the economic terms as a separate copy the
 * hash cannot bind. anchorTermMismatches is what catches a benign-hash /
 * hostile-terms anchor before it is recorded.
 */

const MINT = "So11111111111111111111111111111111111111112";
const FEE_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const RECIPIENT = new PublicKey(FEE_TO);

function onChain(overrides: Partial<OnChainLeague> = {}): OnChainLeague {
  return {
    address: PublicKey.default,
    rulesHash: "a".repeat(64),
    hasPot: true,
    buyIn: "5000000",
    tokenMint: MINT,
    refundUnlockAt: "1773000000",
    feeBps: 100,
    feeRecipient: FEE_TO,
    payoutBps: [6000, 1500, 1000, 1000, 500],
    maxTeams: 12,
    memberCount: 0,
    ...overrides,
  };
}

const EXPECTED: ExpectedTerms = {
  hasPot: true,
  maxTeams: 12,
  buyIn: "5000000",
  refundUnlockAt: "1773000000",
  tokenMint: MINT,
  feeBps: 100,
  feeRecipient: FEE_TO,
  payoutBps: [6000, 1500, 1000, 1000, 500],
};

describe("anchorTermMismatches", () => {
  it("passes when every term matches the signed rules", () => {
    expect(anchorTermMismatches(onChain(), EXPECTED)).toEqual([]);
  });

  it("catches a buy-in that exceeds what members agreed to", () => {
    const m = anchorTermMismatches(onChain({ buyIn: "50000000" }), EXPECTED);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/buyIn/);
  });

  it("catches a refund unlock pushed far past settlement (funds stuck)", () => {
    const m = anchorTermMismatches(onChain({ refundUnlockAt: "4102444800" }), EXPECTED);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/refundUnlockAt/);
  });

  it("catches a redirected fee recipient", () => {
    const attacker = PublicKey.default.toBase58();
    const m = anchorTermMismatches(onChain({ feeRecipient: attacker }), EXPECTED);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/feeRecipient/);
  });

  it("catches a raised fee", () => {
    expect(anchorTermMismatches(onChain({ feeBps: 500 }), EXPECTED)[0]).toMatch(/feeBps/);
  });

  it("catches a reshuffled payout split", () => {
    const m = anchorTermMismatches(
      onChain({ payoutBps: [1500, 6000, 1000, 1000, 500] }),
      EXPECTED,
    );
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/payoutBps/);
  });

  it("catches a different token mint", () => {
    const other = RECIPIENT.toBase58();
    expect(anchorTermMismatches(onChain({ tokenMint: other }), EXPECTED)[0]).toMatch(
      /tokenMint/,
    );
  });

  it("catches a max_teams that differs from the signed rules", () => {
    expect(anchorTermMismatches(onChain({ maxTeams: 255 }), EXPECTED)[0]).toMatch(/maxTeams/);
  });

  it("catches a free on-chain account standing in for a pot league", () => {
    // has_pot=false with zeroed terms, anchored under a pot league's hash.
    const free = onChain({
      hasPot: false,
      buyIn: "0",
      refundUnlockAt: "0",
      feeBps: 0,
      payoutBps: [0, 0, 0, 0, 0],
    });
    const m = anchorTermMismatches(free, EXPECTED);
    expect(m.some((x) => /hasPot/.test(x))).toBe(true);
  });

  it("passes a genuine free league and does not compare its money terms", () => {
    const free = onChain({
      hasPot: false,
      buyIn: "0",
      refundUnlockAt: "0",
      tokenMint: PublicKey.default.toBase58(),
      feeBps: 0,
      feeRecipient: PublicKey.default.toBase58(),
      payoutBps: [0, 0, 0, 0, 0],
    });
    const expectedFree: ExpectedTerms = { ...EXPECTED, hasPot: false };
    expect(anchorTermMismatches(free, expectedFree)).toEqual([]);
  });

  it("reports every hostile field at once", () => {
    const m = anchorTermMismatches(
      onChain({ buyIn: "50000000", feeBps: 500, refundUnlockAt: "4102444800" }),
      EXPECTED,
    );
    expect(m.length).toBe(3);
  });

  it("catches an i64::MAX refund unlock — the worst case, and the one that used to throw", () => {
    // `refund_stake` is the only way tokens leave the vault and it requires the
    // clock to have passed, so this is a permanent freeze of every deposit. The
    // program allows it: its only check is that the value is in the future.
    //
    // This is a string rather than a number because it does not fit in one.
    // Decoding the account with `BN.toNumber()` threw here — on precisely the
    // input this whole check exists to catch — and the throw surfaced as a 500
    // rather than as a refusal.
    const m = anchorTermMismatches(
      onChain({ refundUnlockAt: "9223372036854775807" }),
      EXPECTED,
    );
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/refundUnlockAt/);
    expect(m[0]).toContain("9223372036854775807");
  });

  it("does not compare a fee recipient when no fee is charged", () => {
    // With `FEE_RECIPIENT` unset a league is created fee-free, and its rules
    // carry an empty recipient — which no base58 key can equal. Comparing it
    // would refuse a legitimate anchor, and because the PDA is one-shot that
    // league could never be anchored at all.
    const free = { ...EXPECTED, feeBps: 0, feeRecipient: "" };
    const chain = onChain({ feeBps: 0, feeRecipient: PublicKey.default.toBase58() });
    expect(anchorTermMismatches(chain, free)).toEqual([]);
  });

  it("still catches a fee smuggled in against fee-free rules", () => {
    // The exemption above must not become a hole: `feeBps` is compared either
    // way, so a chain that charges a fee the rules do not is still refused.
    const free = { ...EXPECTED, feeBps: 0, feeRecipient: "" };
    const chain = onChain({ feeBps: 500, feeRecipient: FEE_TO });
    const m = anchorTermMismatches(chain, free);
    expect(m.some((x) => /feeBps/.test(x))).toBe(true);
  });
});

/**
 * The mapping from signed rules to expected terms.
 *
 * This is the half that used to live inline in the route, where nothing could
 * test it — `apps/web` has no test project. Both bugs found in review were here
 * rather than in the comparison.
 */
describe("expectedTermsFromRules", () => {
  const POT = {
    tokenMint: MINT,
    buyInBaseUnits: "5000000",
    refundUnlockAt: 1_773_000_000,
    feeBps: 100,
    feeRecipient: FEE_TO,
    payout: [
      { prize: "CHAMPION", basisPoints: 6000 },
      { prize: "RUNNER_UP", basisPoints: 1500 },
      { prize: "REGULAR_SEASON", basisPoints: 1000 },
      { prize: "CONSOLATION", basisPoints: 1000 },
      { prize: "THIRD_PLACE", basisPoints: 500 },
    ],
  };

  it("agrees with an honestly anchored pot league", () => {
    const expected = expectedTermsFromRules({ league: { maxTeams: 12 }, pot: POT });
    expect(anchorTermMismatches(onChain(), expected)).toEqual([]);
  });

  it("orders the payout by PRIZE_ORDER, not by the order the shares arrive in", () => {
    // Deliberately shuffled. In declaration order this bug is invisible, which
    // is why the shares are passed out of order here: a mapping that trusted
    // input order would produce [1000, 500, 6000, 1500, 1000] and reshuffle the
    // split with no error anywhere.
    const shuffled = [
      POT.payout[2],
      POT.payout[4],
      POT.payout[0],
      POT.payout[1],
      POT.payout[3],
    ];
    const expected = expectedTermsFromRules({
      league: { maxTeams: 12 },
      pot: { ...POT, payout: shuffled as typeof POT.payout },
    });
    expect(expected.payoutBps).toEqual([6000, 1500, 1000, 1000, 500]);
    expect(anchorTermMismatches(onChain(), expected)).toEqual([]);
  });

  it("carries a 64-bit refund unlock without losing it", () => {
    const expected = expectedTermsFromRules({
      league: { maxTeams: 12 },
      pot: { ...POT, refundUnlockAt: 4_102_444_800 },
    });
    expect(expected.refundUnlockAt).toBe("4102444800");
  });

  it("builds a free league the way the route does, and it verifies", () => {
    const expected = expectedTermsFromRules({ league: { maxTeams: 12 }, pot: null });
    expect(expected.hasPot).toBe(false);

    const free = onChain({
      hasPot: false,
      buyIn: "0",
      refundUnlockAt: "0",
      tokenMint: PublicKey.default.toBase58(),
      feeBps: 0,
      feeRecipient: PublicKey.default.toBase58(),
      payoutBps: [0, 0, 0, 0, 0],
    });
    expect(anchorTermMismatches(free, expected)).toEqual([]);
  });

  it("treats a missing pot key as free, not as a pot", () => {
    // `pot` is parsed from stored JSON. A document that omits the key yields
    // `undefined`, and `!== null` would call that a pot league — telling a
    // genuine free league its rules imply one, unresolvably.
    const expected = expectedTermsFromRules({
      league: { maxTeams: 12 },
      pot: undefined as unknown as null,
    });
    expect(expected.hasPot).toBe(false);
  });
});
