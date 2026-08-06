import { describe, expect, it } from "vitest";
import { deriveOrderSeed, explainOrderDraw } from "./seed.js";
import { generateDraftOrder } from "./order.js";

const BASE = {
  leagueId: "11111111-2222-3333-4444-555555555555",
  rulesHash: "5afc934db3b3e1b1f5ec7a9e503f61e531aa925a6f966c41ec227118201da36a",
  slot: 412_550_991,
  blockhash: "5xot9PVkphiX2adznghwrAuxGs2zeWisNSxMW6hU6Hkj",
};

describe("deriveOrderSeed", () => {
  it("is a 64-character hex digest", () => {
    expect(deriveOrderSeed(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is reproducible", () => {
    // The whole point: anyone holding the block can recompute the order.
    expect(deriveOrderSeed(BASE)).toBe(deriveOrderSeed({ ...BASE }));
  });

  it("changes with the blockhash", () => {
    expect(deriveOrderSeed({ ...BASE, blockhash: "different" })).not.toBe(
      deriveOrderSeed(BASE),
    );
  });

  it("changes with the slot", () => {
    expect(deriveOrderSeed({ ...BASE, slot: BASE.slot + 1 })).not.toBe(deriveOrderSeed(BASE));
  });

  it("changes with the league", () => {
    // Domain separation. Two leagues drawing from the same block must not get
    // correlated orders — otherwise knowing one order leaks the other.
    expect(deriveOrderSeed({ ...BASE, leagueId: "other" })).not.toBe(deriveOrderSeed(BASE));
  });

  it("changes with the rules hash", () => {
    expect(deriveOrderSeed({ ...BASE, rulesHash: "0".repeat(64) })).not.toBe(
      deriveOrderSeed(BASE),
    );
  });

  it("gives two leagues on the same block unrelated orders", () => {
    const teams = Array.from({ length: 12 }, (_, i) => `team-${i}`);

    const a = generateDraftOrder(teams, deriveOrderSeed(BASE));
    const b = generateDraftOrder(
      teams,
      deriveOrderSeed({ ...BASE, leagueId: "second-league" }),
    );

    expect(a).not.toEqual(b);
  });
});

describe("explainOrderDraw", () => {
  // A verification nobody can perform is indistinguishable from no verification,
  // so the instructions ship next to the order.
  const text = explainOrderDraw(BASE);

  it("names the slot to look up", () => {
    expect(text).toContain(String(BASE.slot));
  });

  it("shows the blockhash", () => {
    expect(text).toContain(BASE.blockhash);
  });

  it("gives the seed the reader should arrive at", () => {
    expect(text).toContain(deriveOrderSeed(BASE));
  });

  it("says how to confirm this is the only block the league could have used", () => {
    expect(text).toMatch(/block before it is earlier/i);
  });
});
