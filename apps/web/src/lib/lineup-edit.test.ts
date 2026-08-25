import { describe, expect, it } from "vitest";
import { applyLineupEdit } from "./lineup-edit.js";
import type { LineupSlot } from "./lineup-edit.js";

const slots = (...entries: [string, number, string | null][]): LineupSlot[] =>
  entries.map(([slotType, slotIndex, playerId]) => ({ slotType, slotIndex, playerId }));

describe("applyLineupEdit", () => {
  it("puts the player in the named slot", () => {
    const after = applyLineupEdit(slots(["QB", 0, null], ["RB", 0, null]), {
      slotType: "QB",
      slotIndex: 0,
      playerId: "p1",
    });

    expect(after).toEqual(slots(["QB", 0, "p1"], ["RB", 0, null]));
  });

  it("vacates the slot the player came from", () => {
    // Otherwise the submission holds him twice and the server refuses the whole
    // lineup for a slot the manager did not think they were editing.
    const after = applyLineupEdit(slots(["FLEX", 0, "p1"], ["RB", 0, null]), {
      slotType: "RB",
      slotIndex: 0,
      playerId: "p1",
    });

    expect(after).toEqual(slots(["FLEX", 0, null], ["RB", 0, "p1"]));
  });

  it("clears one slot without blanking every other empty one", () => {
    /*
      The `playerId !== null` guard. Without it, clearing a slot matches every
      slot already holding null — they all "hold the same player" — and one
      dropdown set to empty wipes the lineup.
    */
    const after = applyLineupEdit(slots(["QB", 0, "p1"], ["RB", 0, null], ["WR", 0, "p2"]), {
      slotType: "QB",
      slotIndex: 0,
      playerId: null,
    });

    expect(after).toEqual(slots(["QB", 0, null], ["RB", 0, null], ["WR", 0, "p2"]));
  });

  it("distinguishes slots of the same type by index", () => {
    const after = applyLineupEdit(slots(["RB", 0, "p1"], ["RB", 1, "p2"]), {
      slotType: "RB",
      slotIndex: 1,
      playerId: "p3",
    });

    expect(after).toEqual(slots(["RB", 0, "p1"], ["RB", 1, "p3"]));
  });

  it("leaves every slot the edit does not name exactly as it found them", () => {
    /*
      **The property the retry depends on, and the one the old merge broke.**

      After a `LINEUP_MOVED` the editor re-reads the lineup and re-applies the
      manager's decision to it. If applying that decision also carried anything
      from the manager's stale snapshot, the retry would revert whatever the
      other writer had just done — which is what the previous merge did, across
      every slot the two lists disagreed about.

      Here the fresh list holds a player in RB the manager's page never showed.
      Editing QB must not touch him.
    */
    const fresh = slots(["QB", 0, null], ["RB", 0, "autofilled"], ["WR", 0, "p2"]);

    const after = applyLineupEdit(fresh, { slotType: "QB", slotIndex: 0, playerId: "p1" });

    expect(after).toEqual(slots(["QB", 0, "p1"], ["RB", 0, "autofilled"], ["WR", 0, "p2"]));
  });

  it("still vacates on the retry when the player is the one who moved", () => {
    // The one case where touching another slot is correct: the manager is moving
    // a player the refresh shows somewhere else.
    const fresh = slots(["FLEX", 0, "p1"], ["RB", 0, "autofilled"]);

    const after = applyLineupEdit(fresh, { slotType: "RB", slotIndex: 0, playerId: "p1" });

    expect(after).toEqual(slots(["FLEX", 0, null], ["RB", 0, "p1"]));
  });

  it("does not mutate the list it was given", () => {
    const before = slots(["QB", 0, null]);
    applyLineupEdit(before, { slotType: "QB", slotIndex: 0, playerId: "p1" });
    expect(before).toEqual(slots(["QB", 0, null]));
  });
});
