import { describe, expect, it } from "vitest";
import { irGameStarted } from "./ir-placement.js";

/*
  The screen's copy of `moveToIr`'s kickoff refusal.

  These are the only layer that can be tested: both vitest projects are
  node-environment with no jsdom, so `LineupEditor` cannot be rendered. That is
  why the predicate is an exported function rather than an expression at the
  call site — everything left untested there is one `||` and a ternary.
*/

/** Thursday 20:15, the week's first kickoff. Epoch seconds, as the payload carries. */
const WEEK_START = 1_762_200_000;
const SUNDAY_AFTERNOON = WEEK_START + 3 * 24 * 60 * 60;

describe("irGameStarted", () => {
  it("says a player whose game has kicked off has started — #321", () => {
    /*
      The filed bug. "To IR" rendered for this player and answered 409, in the
      Sunday window when a manager reacting to an inactives report is most
      likely to press it.
    */
    expect(irGameStarted({ opponentRef: "NO", kickoffAt: WEEK_START }, SUNDAY_AFTERNOON)).toBe(
      true,
    );
  });

  it("says a clubless player has NOT started, though his kickoff is synthesised", () => {
    /*
      **The assertion this whole issue exists to protect, and the one that goes
      red if anyone simplifies this function to read `kickoffAt` alone.**

      A player no NFL club lists still carries a non-null `kickoffAt`: with no
      fixture to join, `loadRosterForWeek` hands him the week's first kickoff so
      his lineup slot freezes rather than never locking. That is deliberate and
      it is the lineup lock's rule.

      Injured reserve asks a different question. `heldRoster` LEFT JOINs the
      same fixture, finds nothing, leaves `kickoff_at` NULL, and `moveToIr`
      accepts the placement — which `RULES.md` §2 requires, since its IR test is
      a designation test with no club or kickoff condition.

      So the naive conjunct would hide a button the server would honour. Worse
      than the 409 it removes, and invisible: nothing to notice, nothing to
      report. `opponentRef` is what keeps the two apart.

      Not hypothetical. `listInjuries` reads the provider's full player list and
      filters only on a non-empty designation — team is never consulted — so a
      player placed on NFL injured reserve and then released keeps an OUT
      designation with no club. An ordinary September sequence.
    */
    expect(irGameStarted({ opponentRef: null, kickoffAt: WEEK_START }, SUNDAY_AFTERNOON)).toBe(
      false,
    );
  });

  it("says a player on a bye has not started", () => {
    // A bye keeps `kickoffAt` null rather than synthesising one, so this branch
    // is reachable two ways. Kills a nullish-coercion rewrite — `now >=
    // (kickoffAt ?? 0)` would answer true here and refuse a legal placement.
    expect(irGameStarted({ opponentRef: null, kickoffAt: null }, SUNDAY_AFTERNOON)).toBe(false);
  });

  it("says a fixture with no kickoff time has not started", () => {
    /*
      A `games` row exists — so both team refs are present and `opponentRef` is
      non-null — but the provider has not published a kickoff. The server reads
      `player?.kickoff_at &&`, which is falsy, and accepts.

      This is the edge the second conjunct exists for. Without it the function
      would compare against null and answer true, refusing a placement the
      server would take.
    */
    expect(irGameStarted({ opponentRef: "NO", kickoffAt: null }, SUNDAY_AFTERNOON)).toBe(false);
  });

  it("counts a kickoff exactly now as started, the way the server does", () => {
    // `moveToIr` compares `new Date(player.kickoff_at) <= input.now`. Inclusive.
    // Kills a drift to `>`, which would disagree for one second.
    expect(irGameStarted({ opponentRef: "NO", kickoffAt: WEEK_START }, WEEK_START)).toBe(true);
  });

  it("says a future kickoff has not started", () => {
    // The ordinary Thursday-morning case, and the control that stops a mutant
    // returning true unconditionally from passing the first test alone.
    expect(irGameStarted({ opponentRef: "NO", kickoffAt: SUNDAY_AFTERNOON }, WEEK_START)).toBe(
      false,
    );
  });
});
