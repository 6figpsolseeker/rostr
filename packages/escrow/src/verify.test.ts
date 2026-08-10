import { describe, it, expect } from "vitest";
import { anchorTermMismatches } from "./verify.js";
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
    refundUnlockAt: 1_773_000_000,
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
  refundUnlockAt: 1_773_000_000,
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
    const m = anchorTermMismatches(onChain({ refundUnlockAt: 4_102_444_800 }), EXPECTED);
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
    const m = anchorTermMismatches(onChain({ payoutBps: [1500, 6000, 1000, 1000, 500] }), EXPECTED);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/payoutBps/);
  });

  it("catches a different token mint", () => {
    const other = RECIPIENT.toBase58();
    expect(anchorTermMismatches(onChain({ tokenMint: other }), EXPECTED)[0]).toMatch(/tokenMint/);
  });

  it("catches an unbounded max_teams", () => {
    expect(anchorTermMismatches(onChain({ maxTeams: 255 }), EXPECTED)[0]).toMatch(/maxTeams/);
  });

  it("catches a free on-chain account standing in for a pot league", () => {
    // has_pot=false with zeroed terms, anchored under a pot league's hash.
    const free = onChain({
      hasPot: false,
      buyIn: "0",
      refundUnlockAt: 0,
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
      refundUnlockAt: 0,
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
      onChain({ buyIn: "50000000", feeBps: 500, refundUnlockAt: 4_102_444_800 }),
      EXPECTED,
    );
    expect(m.length).toBe(3);
  });
});
