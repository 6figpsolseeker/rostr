import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { anchoringWallet, parseAnchoringWallet } from "./escrow";

const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("anchoringWallet", () => {
  it("answers with the recorded wallet", () => {
    const answer = anchoringWallet({ anchoredAt: new Date(), commissioner: WALLET });
    expect(answer.ok && answer.commissioner.toBase58()).toBe(WALLET);
  });

  it("refuses a league nobody has anchored", () => {
    const answer = anchoringWallet({ anchoredAt: null, commissioner: null });
    expect(!answer.ok && answer.body.reason).toBe("NOT_ANCHORED");
    expect(anchoringWallet(null).ok).toBe(false);
  });

  it("refuses a league anchored under the old program, rather than guessing", () => {
    // No wallet seeds the old address, so there is nothing to derive it from.
    // Answering with any key at all would address an account nobody can use.
    const answer = anchoringWallet({ anchoredAt: new Date(), commissioner: null });
    expect(!answer.ok && answer.body.reason).toBe("LEGACY_ANCHOR");
  });
});

describe("parseAnchoringWallet", () => {
  it("accepts a key that could have signed", () => {
    expect(parseAnchoringWallet(WALLET)?.toBase58()).toBe(WALLET);
  });

  it("refuses the default key, which is nobody's", () => {
    expect(parseAnchoringWallet(PublicKey.default.toBase58())).toBeNull();
  });

  it("refuses a key off the curve, which has no private key to sign with", () => {
    // A PDA is the realistic one: a program address cannot have paid for
    // `initialize_league`, so it cannot be the wallet that anchored.
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("x")], PublicKey.default);
    expect(parseAnchoringWallet(pda.toBase58())).toBeNull();
  });

  it("refuses anything that is not a base58 key", () => {
    for (const value of [undefined, null, 42, "", "not a key", "0OIl", WALLET + "x"]) {
      expect(parseAnchoringWallet(value)).toBeNull();
    }
  });
});
