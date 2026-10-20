import { describe, expect, it } from "vitest";
import { anchoringWallet } from "./escrow";

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
