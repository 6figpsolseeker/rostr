import { describe, expect, it } from "vitest";
import { NFL_DEFAULT_TRADES } from "../rules/nfl-ppr.js";
import type { TradeRules } from "../rules/types.js";
import {
  isVetoed,
  tradeBlockedBecause,
  vetoWindowEndsAt,
  vetoWindowHasClosed,
  vetoesRequired,
} from "./veto.js";

const RULES = NFL_DEFAULT_TRADES;

describe("vetoesRequired", () => {
  it("is one third of uninvolved managers", () => {
    // The documented example: 12 teams, two trading, 4 of the other 10.
    expect(vetoesRequired(10, RULES)).toBe(4);
  });

  it("rounds up rather than down", () => {
    // A third of 10 is 3.33. Rounding down would let three managers block a
    // trade the rules say needs a third — a different rule from the one members
    // signed.
    expect(vetoesRequired(10, RULES)).toBe(4);
    expect(vetoesRequired(4, RULES)).toBe(2);
    expect(vetoesRequired(7, RULES)).toBe(3);
  });

  it("matches the documented small-league case", () => {
    // Six managers and a bot: two trading leaves four uninvolved managers, and
    // two of them can block.
    expect(vetoesRequired(4, RULES)).toBe(2);
  });

  it("is zero when there is nobody to object", () => {
    expect(vetoesRequired(0, RULES)).toBe(0);
  });

  it("never goes negative", () => {
    expect(vetoesRequired(-3, RULES)).toBe(0);
  });

  it("follows the league's own numerator and denominator", () => {
    // The threshold is frozen per league, not a constant here.
    const majority: TradeRules = { ...RULES, vetoNumerator: 1, vetoDenominator: 2 };
    expect(vetoesRequired(10, majority)).toBe(5);

    const strict: TradeRules = { ...RULES, vetoNumerator: 2, vetoDenominator: 3 };
    expect(vetoesRequired(9, strict)).toBe(6);
  });
});

describe("isVetoed", () => {
  it("blocks at the threshold", () => {
    expect(isVetoed(4, 10, RULES)).toBe(true);
  });

  it("does not block one short", () => {
    expect(isVetoed(3, 10, RULES)).toBe(false);
  });

  it("blocks above the threshold", () => {
    expect(isVetoed(9, 10, RULES)).toBe(true);
  });

  it("lets a trade stand when nobody could object", () => {
    // Two managers and a bot leaves no uninvolved voters. A threshold of zero
    // would otherwise mean every trade is vetoed before anyone votes — which is
    // the opposite of what a league with nobody objecting should produce.
    expect(isVetoed(0, 0, RULES)).toBe(false);
  });

  it("does not block on zero votes in a normal league", () => {
    expect(isVetoed(0, 10, RULES)).toBe(false);
  });
});

describe("the veto window", () => {
  const ACCEPTED = 1_760_000_000;

  it("runs for the league's configured hours", () => {
    expect(vetoWindowEndsAt(ACCEPTED, RULES)).toBe(ACCEPTED + 48 * 3600);
  });

  it("has not closed a minute early", () => {
    expect(vetoWindowHasClosed(ACCEPTED, ACCEPTED + 48 * 3600 - 60, RULES)).toBe(false);
  });

  it("closes exactly on the hour it is due", () => {
    expect(vetoWindowHasClosed(ACCEPTED, ACCEPTED + 48 * 3600, RULES)).toBe(true);
  });

  it("uses the league's own window", () => {
    const quick: TradeRules = { ...RULES, vetoWindowHours: 24 };
    expect(vetoWindowEndsAt(ACCEPTED, quick)).toBe(ACCEPTED + 24 * 3600);
  });
});

describe("tradeBlockedBecause", () => {
  const base = {
    rules: RULES,
    week: 5,
    proposerTeamId: "a",
    receiverTeamId: "b",
    proposerGives: ["p1"],
    receiverGives: ["p2"],
  };

  it("allows an ordinary trade", () => {
    expect(tradeBlockedBecause(base)).toBeNull();
  });

  it("allows one on the deadline week itself", () => {
    expect(tradeBlockedBecause({ ...base, week: RULES.deadlineWeek })).toBeNull();
  });

  it("refuses after the deadline", () => {
    // Without it, an eliminated team can hand its roster to a contender it has a
    // side arrangement with.
    expect(tradeBlockedBecause({ ...base, week: RULES.deadlineWeek + 1 })).toBe(
      "PAST_DEADLINE",
    );
  });

  it("respects a league that set its own deadline", () => {
    const early: TradeRules = { ...RULES, deadlineWeek: 8 };
    expect(tradeBlockedBecause({ ...base, rules: early, week: 9 })).toBe("PAST_DEADLINE");
    expect(tradeBlockedBecause({ ...base, rules: early, week: 8 })).toBeNull();
  });

  it("refuses when the league disabled trading", () => {
    const off: TradeRules = { ...RULES, enabled: false };
    expect(tradeBlockedBecause({ ...base, rules: off })).toBe("TRADES_DISABLED");
  });

  it("refuses a trade with yourself", () => {
    expect(tradeBlockedBecause({ ...base, receiverTeamId: "a" })).toBe("SAME_TEAM");
  });

  it("refuses a one-sided giveaway", () => {
    // A trade where one side gives nothing is a gift, and a gift is how an
    // eliminated team hands its roster to a friend without anyone calling it a
    // trade.
    expect(tradeBlockedBecause({ ...base, proposerGives: [] })).toBe("NOTHING_OFFERED");
    expect(tradeBlockedBecause({ ...base, receiverGives: [] })).toBe("NOTHING_OFFERED");
  });

  it("allows an uneven trade", () => {
    // Two for one is a normal trade, not a giveaway. Only zero is refused.
    expect(
      tradeBlockedBecause({ ...base, proposerGives: ["p1", "p2"], receiverGives: ["p3"] }),
    ).toBeNull();
  });
});
