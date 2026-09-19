import { describe, expect, it } from "vitest";
import { irAvailability } from "./ir-notice";

/*
  What the screen is allowed to offer for injured reserve.

  These are the tests the rule could not have, because the decision used to live
  in `LineupEditor.tsx` by omission — the "To IR" button consulted the player and
  never the league, and `apps/web` cannot render a component in a test.
*/
describe("irAvailability", () => {
  it("opens both directions during the season", () => {
    for (const state of ["IN_SEASON", "PLAYOFFS"]) {
      expect(irAvailability(state)).toEqual({
        place: true,
        activate: true,
        notice: null,
      });
    }
  });

  it("shuts both before a roster exists", () => {
    const ir = irAvailability("FORMING");

    expect(ir.place).toBe(false);
    expect(ir.activate).toBe(false);
    expect(ir.notice).toMatch(/has not drafted yet/);
  });

  it("refuses placement during a draft and still allows activation", () => {
    /*
      **The only case #316 could actually reach**, and the reason this file is
      two booleans rather than one.

      Nothing in this repo writes `SETTLED` or `DISSOLVED` — `score-week`'s own
      comment says so — so the finished-league scenario the issue was filed for
      is unreachable today. What is reachable is a manager who drafted a player
      already carrying an OUT designation: he satisfies every player-level
      condition the "To IR" button checks, and `moveToIr` refuses him anyway.

      Activation staying open is the owner's ruling of 2026-09-18, and binding
      both controls to one boolean is how it would be silently deleted.
    */
    const ir = irAvailability("DRAFTING");

    expect(ir.place).toBe(false);
    expect(ir.activate).toBe(true);
    expect(ir.notice).toMatch(/draft is still running/);
  });

  it("still names a reason in the one state where a control survives", () => {
    /*
      A closed direction with no sentence is the failure this whole change
      exists to prevent — a button that vanished with nothing saying why is
      indistinguishable from a bug, and `DRAFTING` is the state where half the
      section is still live and could read as complete.
    */
    expect(irAvailability("DRAFTING").notice).not.toBeNull();
  });

  it("shuts both once the season is over", () => {
    /*
      Unreachable through the product today and asserted anyway: the states are
      in the `league_state` enum, the rule in `@rostr/db` answers for them, and
      this is what makes the single `notice` field honest across all six rather
      than across the four somebody happened to think about.
    */
    for (const state of ["SETTLED", "DISSOLVED"]) {
      const ir = irAvailability(state);

      expect(ir.place).toBe(false);
      expect(ir.activate).toBe(false);
      expect(ir.notice).toMatch(/season is over/);
    }
  });

  it("never reports a direction open without a sentence, or shut without one", () => {
    /*
      **The invariant that makes one `notice` enough for two controls.**

      `notice` is the placement sentence, and the component renders it above both
      buttons. That is only honest while placement is shut in every state where
      activation is — otherwise the screen would show a sentence about the wrong
      button, or show none at all beside a control that had silently vanished.

      Asserted rather than trusted. If the rule ever gains a state where
      activation alone is refused, this goes red instead of the screen going
      quietly wrong.
    */
    for (const state of [
      "FORMING",
      "DRAFTING",
      "IN_SEASON",
      "PLAYOFFS",
      "SETTLED",
      "DISSOLVED",
    ]) {
      const ir = irAvailability(state);

      expect(ir.notice === null).toBe(ir.place);
      if (!ir.activate) expect(ir.place).toBe(false);
    }
  });

  it("treats a state it has never heard of as shut", () => {
    // Fails closed, like `loadKickoffs` and `slotIsLocked`. A new enum value
    // reaching here means the rule has not been taught about it, and offering
    // both controls on a guess is the expensive direction to be wrong in.
    const ir = irAvailability("PROBATION");

    expect(ir.place).toBe(false);
    expect(ir.activate).toBe(false);
    expect(ir.notice).not.toBeNull();
  });
});
