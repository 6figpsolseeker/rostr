/**
 * The pot-league gate.
 *
 * Two jobs. It pins the decision itself, so flipping it is a deliberate edit to
 * a test rather than a one-character change nobody reviews — the same argument
 * the golden rules hash makes. And it exercises **both** sides, because the
 * shut side is the one running in production and the open side is the one that
 * has to still work when the season turns over.
 */

import { describe, expect, it } from "vitest";
import { POT_LEAGUES_COMING_SOON, POT_LEAGUES_OPEN, potLeagueGate } from "./pot-leagues.js";
import { potDepositGate } from "./settlement.js";

describe("the pot-league gate", () => {
  it("is shut, which is the 2026 season decision", () => {
    // Deliberately a change detector. If this fails, somebody is reopening pot
    // leagues — which is a product decision, not a refactor, so it should cost
    // an edit here and a moment's thought. Update it in the same commit that
    // sets the constant, and say why in the message.
    expect(POT_LEAGUES_OPEN).toBe(false);
    expect(potLeagueGate()).toEqual({ open: false, reason: "NOT_THIS_SEASON" });
  });

  it("opens cleanly when the decision reverses", () => {
    // The path that is not running today. Without this the reopen would be
    // untested code that has never executed, discovered on the day it matters.
    expect(potLeagueGate(true)).toEqual({ open: true });
  });

  it("carries no reason when it is open", () => {
    // The union is what forces every caller to be revisited if a second reason
    // ever appears. A bare boolean would let a new refusal be added silently
    // and explained nowhere.
    const gate = potLeagueGate(true);
    expect("reason" in gate).toBe(false);
  });

  it("says the feature is deferred, not broken", () => {
    // The copy is shared between the form and the 503 precisely so a creator
    // cannot be told two different things. What it must never read as is a
    // fault: "coming soon" is a roadmap, "unavailable" is an outage.
    expect(POT_LEAGUES_COMING_SOON).toMatch(/coming soon/i);
    expect(POT_LEAGUES_COMING_SOON).toMatch(/free to play/i);
    expect(POT_LEAGUES_COMING_SOON).not.toMatch(/error|failed|unavailable|broken/i);
  });

  it("sits in front of the deposit gate rather than replacing it", () => {
    /*
      These two answer different questions and the relationship is worth
      pinning, because it is the thing a reader gets wrong.

      `potDepositGate` opened by itself the day settlement shipped — it reads
      the committed IDL. That is still true and still correct. It is simply
      unreachable for new leagues while this gate is shut, because a league that
      cannot be created can never reach a deposit.

      Asserting it stays open is what stops somebody "tidying up" by shutting
      the deposit gate too: the devnet pot leagues already drafted go on
      depositing, and closing that would break leagues this decision explicitly
      left working.
    */
    expect(potDepositGate("devnet").open).toBe(true);
    expect(potLeagueGate().open).toBe(false);
  });
});
