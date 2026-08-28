import { describe, expect, it } from "vitest";
import {
  countedRosterSize,
  irExemptCount,
  isIrEligible,
  unlikelyToPlay,
  refuseIrPlacement,
} from "./injured-reserve.js";
import type { IrRosterEntry } from "./injured-reserve.js";

function entry(
  playerId: string,
  onIr: boolean,
  injuryDesignation: string | null,
): IrRosterEntry {
  return { playerId, onIr, injuryDesignation };
}

describe("isIrEligible", () => {
  /*
    The provider's own wording, not ours.

    This used to iterate the seven short codes the implementation contained and
    assert they were accepted — the constant checked against itself, which
    passes for any constant including a wrong one. That is how "Injured
    Reserve" went unnoticed: it is the second most common value in the column
    and matched nothing. Every string below is one this project has observed in
    the field, recorded with its counts in docs/TANK01.md.
  */
  it("accepts the designations the provider actually publishes", () => {
    expect(isIrEligible("Injured Reserve")).toBe(true);
    expect(isIrEligible("Out")).toBe(true);
    expect(isIrEligible("Doubtful")).toBe(true);
  });

  it("admits a designation nobody here has seen", () => {
    /*
      The property the inversion buys, and the reason to keep it.

      An allow-list is correct only while its enumeration is complete, and this
      vocabulary belongs to another company. Refusing an unfamiliar designation
      strands a player who is genuinely hurt, with no bound; admitting one costs
      a manager an IR slot he chose to spend, capped at `irSlots`.

      This fails the moment somebody re-tightens it into an allow-list, which is
      the whole job of the test.
    */
    expect(isIrEligible("Reserve/COVID-19")).toBe(true);
    expect(isIrEligible("Physically Unable To Perform")).toBe(true);
  });

  it("treats a healthy player as ineligible however the absence is spelt", () => {
    // Three shapes the column actually takes. An empty string reading as
    // eligible would put every healthy player on the list.
    expect(isIrEligible(null)).toBe(false);
    expect(isIrEligible(undefined)).toBe(false);
    expect(isIrEligible("")).toBe(false);
    expect(isIrEligible("   ")).toBe(false);
  });

  it("normalises case and whitespace, because the column is provider text", () => {
    expect(isIrEligible(" out ")).toBe(true);
    expect(isIrEligible("Questionable")).toBe(false);
    expect(isIrEligible("  questionable  ")).toBe(false);
  });

  it("refuses the one designation that means he may still play", () => {
    // 240 of the 383 designated players carried this on 2026-08-27 — the
    // largest group in the column by some way, and the one the IR slot is not
    // for. A questionable player usually plays.
    expect(isIrEligible("Questionable")).toBe(false);
  });
});

describe("an injury getting worse never costs the slot", () => {
  /*
    Issue 251, at the arithmetic rather than the predicate.

    The check is continuous, so a designation is re-read every time the roster
    is counted. "Out" was accepted and "Injured Reserve" was not, which meant a
    player who got *more* injured — the ordinary progression, and precisely the
    population an IR slot exists for — silently stopped being exempt. His
    manager was then told the roster was full, had waiver claims refused on that
    basis, and saw him labelled as no longer out.
  */
  it("keeps the exemption when Out becomes Injured Reserve", () => {
    const before = irExemptCount([entry("hurt", true, "Out")], 2);
    const after = irExemptCount([entry("hurt", true, "Injured Reserve")], 2);

    expect(before).toBe(1);
    expect(after).toBe(1);
  });

  it("still counts a player who recovers", () => {
    // The exemption is conditional in both directions: it is not a one-way
    // ratchet, and a fit player on the list counts against the roster again.
    expect(irExemptCount([entry("fit", true, "Questionable")], 2)).toBe(0);
  });
});

describe("irExemptCount", () => {
  it("exempts a genuinely injured player who is on IR", () => {
    const roster = [entry("a", true, "OUT"), entry("b", false, null)];
    expect(irExemptCount(roster, 2)).toBe(1);
  });

  it("stops exempting a player the moment he recovers", () => {
    // The owner's rule: a player on IR must actually be injured. Nothing is
    // forced off and nothing is dropped — the exemption simply evaporates, so a
    // healthy player can never buy his team an extra roster spot.
    const roster = [entry("a", true, null), entry("b", false, null)];
    expect(irExemptCount(roster, 2)).toBe(0);
  });

  it("never exempts more than the league's own irSlots", () => {
    const roster = [entry("a", true, "OUT"), entry("b", true, "IR"), entry("c", true, "PUP")];
    // Being injured is a condition of occupying a slot, not a way to make more.
    expect(irExemptCount(roster, 2)).toBe(2);
  });

  it("exempts nobody in a league with no IR slots", () => {
    expect(irExemptCount([entry("a", true, "OUT")], 0)).toBe(0);
  });

  it("ignores an injured player who is not on IR", () => {
    // Being hurt is not the same as being stashed. A manager who keeps an
    // injured starter on the bench has made a choice and still owes the spot.
    expect(irExemptCount([entry("a", false, "OUT")], 2)).toBe(0);
  });
});

describe("countedRosterSize", () => {
  it("subtracts only the genuine occupants", () => {
    const roster = [entry("a", true, "OUT"), entry("b", true, null), entry("c", false, null)];
    // Three players, one genuinely stashed: two count.
    expect(countedRosterSize(roster, 2)).toBe(2);
  });

  it("counts a full healthy roster in full", () => {
    const roster = Array.from({ length: 14 }, (_, i) => entry(`p${i}`, false, null));
    expect(countedRosterSize(roster, 2)).toBe(14);
  });
});

describe("refuseIrPlacement", () => {
  const injured = entry("hurt", false, "OUT");
  const healthy = entry("fit", false, null);

  it("allows an injured player onto an empty IR", () => {
    expect(
      refuseIrPlacement({ roster: [injured, healthy], playerId: "hurt", irSlots: 2 }),
    ).toBeNull();
  });

  it("refuses a healthy player", () => {
    expect(refuseIrPlacement({ roster: [injured, healthy], playerId: "fit", irSlots: 2 })).toBe(
      "NOT_INJURED",
    );
  });

  it("refuses somebody who is not on the roster", () => {
    expect(refuseIrPlacement({ roster: [injured], playerId: "stranger", irSlots: 2 })).toBe(
      "NOT_ON_ROSTER",
    );
  });

  it("refuses when every slot is genuinely occupied", () => {
    const roster = [entry("a", true, "OUT"), entry("b", true, "IR"), injured];
    expect(refuseIrPlacement({ roster, playerId: "hurt", irSlots: 2 })).toBe("IR_FULL");
  });

  it("lets a recovered occupant's slot be taken", () => {
    // He is on IR and no longer entitled to be, so he is not holding the slot
    // against anybody. This is the other half of the exemption being
    // conditional: it frees the room as well as removing the benefit.
    const roster = [entry("a", true, null), entry("b", true, "IR"), injured];
    expect(refuseIrPlacement({ roster, playerId: "hurt", irSlots: 2 })).toBeNull();
  });

  it("refuses everybody in a league with no IR slots", () => {
    expect(refuseIrPlacement({ roster: [injured], playerId: "hurt", irSlots: 0 })).toBe(
      "IR_FULL",
    );
  });
});

describe("unlikelyToPlay", () => {
  /*
    The autofill's own vocabulary, deliberately not `isIrEligible`'s.

    They sound like one question and are two: "is he shelved for a while"
    against "will he appear on Sunday". `DOUBTFUL` is where they part — he may
    occupy an IR slot, and he is ranked behind a healthy player here.
  */

  it("demotes the three designations that mean he will not appear", () => {
    expect(unlikelyToPlay("Out")).toBe(true);
    expect(unlikelyToPlay("Doubtful")).toBe(true);
    expect(unlikelyToPlay("Injured Reserve")).toBe(true);
  });

  it("leaves a questionable player alone, which is most of them", () => {
    /*
      240 of the 383 designated players in `docs/TANK01.md`'s capture — five of
      every eight — and the one value the provider uses to mean he may still
      play. Demoting it would bench a questionable starter behind a healthy
      bench body every week, in the lineup nobody is watching.

      No major product does it: ESPN's Quick Lineup acts on "O" alone, and
      Yahoo's Start Active Players swaps a starter only for a healthy one.
    */
    expect(unlikelyToPlay("Questionable")).toBe(false);
  });

  it("treats an unfamiliar designation as fit, which is the opposite of the IR rule", () => {
    /*
      The inversion, and it is the whole reason this is a separate set.

      `isIrEligible` is a deny-list: an unknown word means injured, because
      refusing a genuinely hurt player an IR slot strands him with no recourse.
      Here the unbounded failure runs the other way — demoting a healthy man
      benches him every week with nobody watching — so an unknown word ranks
      normally.

      It also means the vocabulary being incomplete cannot hurt anyone.
      `docs/TANK01.md` lists "Physically Unable To Perform" and "Suspension" as
      never yet observed; if either arrives, this treats him as fit and
      `syncInjuries` puts the new word in the logs.
    */
    expect(unlikelyToPlay("Physically Unable To Perform")).toBe(false);
    expect(unlikelyToPlay("Suspension")).toBe(false);
    expect(isIrEligible("Physically Unable To Perform")).toBe(true);
  });

  it("reads a healthy player as fit", () => {
    expect(unlikelyToPlay(null)).toBe(false);
    expect(unlikelyToPlay(undefined)).toBe(false);
    expect(unlikelyToPlay("")).toBe(false);
    expect(unlikelyToPlay("   ")).toBe(false);
  });

  it("matches the provider's wording however it is cased or padded", () => {
    // The column holds Tank01's wording verbatim, which is title case with a
    // space — the shape the old seven short codes could never match.
    expect(unlikelyToPlay("  injured reserve  ")).toBe(true);
    expect(unlikelyToPlay("OUT")).toBe(true);
  });

  it("parts from the IR rule on exactly one value", () => {
    // Doubtful may take an IR slot and is still ranked behind a healthy body.
    expect(isIrEligible("Doubtful")).toBe(true);
    expect(unlikelyToPlay("Doubtful")).toBe(true);

    // Questionable is the mirror: never IR-eligible, never demoted.
    expect(isIrEligible("Questionable")).toBe(false);
    expect(unlikelyToPlay("Questionable")).toBe(false);
  });
});
