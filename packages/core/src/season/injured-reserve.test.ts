import { describe, expect, it } from "vitest";
import {
  countedRosterSize,
  irExemptCount,
  isIrEligible,
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
  it("accepts the designations that mean a player will not appear", () => {
    for (const designation of ["OUT", "IR", "PUP", "NFI", "SUSPENDED", "INACTIVE"]) {
      expect(isIrEligible(designation)).toBe(true);
    }
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
