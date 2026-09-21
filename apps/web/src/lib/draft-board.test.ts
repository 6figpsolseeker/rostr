import { describe, expect, it } from "vitest";
import {
  buildBoard,
  byDraftValue,
  focusRound,
  picksUntilTurn,
  type BoardPick,
  type DraftValue,
} from "./draft-board.js";

/**
 * Four teams, so a reversal is visible in two rows and the fixture stays
 * readable. The lobby's own test learned this the expensive way: its first
 * draft restated a 12-team worked example against a 4-team fixture and failed.
 * Nothing here restates a pick number that the engine can be asked for.
 */
const ORDER = ["a", "b", "c", "d"];

const pick = (pickNumber: number, teamId: string, playerId: string): BoardPick => ({
  pickNumber,
  teamId,
  playerId,
  source: "MANUAL",
});

describe("buildBoard", () => {
  it("puts a team in the same column every round", () => {
    const rows = buildBoard({ order: ORDER, rounds: 3, picks: [], currentPickNumber: 1 });

    for (const row of rows) {
      expect(row.cells.map((cell) => cell.teamId)).toEqual(ORDER);
    }
  });

  it("reverses the pick numbers on even rounds", () => {
    // The snake itself. Column order is fixed; what moves is which pick number
    // lands in which column.
    const rows = buildBoard({ order: ORDER, rounds: 2, picks: [], currentPickNumber: 1 });

    expect(rows[0]!.cells.map((cell) => cell.pickNumber)).toEqual([1, 2, 3, 4]);
    expect(rows[1]!.cells.map((cell) => cell.pickNumber)).toEqual([8, 7, 6, 5]);
  });

  it("labels a pick the way people say it", () => {
    const rows = buildBoard({ order: ORDER, rounds: 3, picks: [], currentPickNumber: null });
    expect(rows[2]!.cells[0]!.label).toBe("3.01");
    // Zero-padded, so a column of labels lines up rather than jittering at ten.
    expect(rows[0]!.cells[3]!.label).toBe("1.04");
  });

  it("marks the direction of each round", () => {
    const rows = buildBoard({ order: ORDER, rounds: 3, picks: [], currentPickNumber: null });
    expect(rows.map((row) => row.direction)).toEqual(["FORWARD", "REVERSE", "FORWARD"]);
  });

  it("fills a half-drafted reversed round into the right columns", () => {
    // The bug this catches: pushing picks in the order they were made puts
    // pick 5 in column 0 of round 2, where it belongs to team `a` rather than
    // team `d`. It looks right in round 1 and is wrong in every even round.
    const rows = buildBoard({
      order: ORDER,
      rounds: 2,
      picks: [pick(5, "d", "p5")],
      currentPickNumber: 6,
    });

    const round2 = rows[1]!;
    expect(round2.cells[3]).toMatchObject({ pickNumber: 5, teamId: "d", playerId: "p5" });
    expect(round2.cells[2]).toMatchObject({ pickNumber: 6, teamId: "c", playerId: null });
  });

  it("separates made, on the clock, and still to come", () => {
    const rows = buildBoard({
      order: ORDER,
      rounds: 1,
      picks: [pick(1, "a", "p1")],
      currentPickNumber: 2,
    });

    expect(rows[0]!.cells.map((cell) => cell.state)).toEqual([
      "MADE",
      "ON_CLOCK",
      "FUTURE",
      "FUTURE",
    ]);
  });

  it("marks nothing as on the clock once the draft is complete", () => {
    const rows = buildBoard({
      order: ORDER,
      rounds: 1,
      picks: [1, 2, 3, 4].map((n) => pick(n, ORDER[n - 1]!, `p${n}`)),
      currentPickNumber: null,
    });

    expect(rows[0]!.cells.every((cell) => cell.state === "MADE")).toBe(true);
  });

  it("renders an empty board before the order is drawn", () => {
    // The ordinary state of the room before the commissioner presses the
    // button. Throwing here would blank the screen that explains the button.
    expect(buildBoard({ order: [], rounds: 15, picks: [], currentPickNumber: null })).toEqual(
      [],
    );
  });
});

describe("focusRound", () => {
  it("follows the clock rather than sitting on round one", () => {
    const rows = buildBoard({ order: ORDER, rounds: 5, picks: [], currentPickNumber: 9 });
    expect(focusRound(rows, 9)).toBe(3);
  });

  it("rests on the last round when the draft is over", () => {
    const rows = buildBoard({ order: ORDER, rounds: 5, picks: [], currentPickNumber: null });
    expect(focusRound(rows, null)).toBe(5);
  });

  it("answers for an empty board rather than throwing", () => {
    expect(focusRound([], 1)).toBe(1);
  });
});

describe("picksUntilTurn", () => {
  const rows = buildBoard({ order: ORDER, rounds: 3, picks: [], currentPickNumber: 2 });

  it("is zero for the team on the clock", () => {
    expect(picksUntilTurn(rows, "b", 2)).toBe(0);
  });

  it("counts across a reversal", () => {
    // Team `d` picks at 4 and again at 5. From pick 2 that is two away, and the
    // turn after it is immediate — the gap a snake makes awkward to eyeball.
    expect(picksUntilTurn(rows, "d", 2)).toBe(2);
    expect(picksUntilTurn(rows, "d", 5)).toBe(0);
  });

  it("says nothing for a spectator or before the draft starts", () => {
    expect(picksUntilTurn(rows, null, 2)).toBeNull();
    expect(picksUntilTurn(rows, "a", null)).toBeNull();
  });

  it("answers null when a team has no picks left", () => {
    expect(picksUntilTurn(rows, "a", 13)).toBeNull();
  });
});

describe("byDraftValue", () => {
  const value = (active: boolean, rank: number): DraftValue => ({ active, rank });

  /** Names, so a failure says which ordering broke rather than which index. */
  const order = (...players: [string, DraftValue][]): string[] =>
    [...players].sort((x, y) => byDraftValue(x[1], y[1])).map(([name]) => name);

  it("runs the board in ADP order — owner's ruling, 2026-09-21", () => {
    /*
      **The reversal.** This list used to come back ["best projection", …]: the
      room sorted on points projected under the league's own rules, and used ADP
      only to break a tie.

      The owner asked for the opposite on 2026-09-21 — ADP decides the order,
      projected points ride alongside in their own column. A draft room is read
      against the draft that is actually happening, and a manager who has spent
      a week with a public board does not experience a differently-ordered list
      as a second opinion. He experiences it as a bug.

      `rank` is the server's dense 1..n index, assigned after
      `ORDER BY … r.overall_milli NULLS LAST`, so ascending `rank` *is* ascending
      ADP. Nothing here re-derives it — see `loadDraftBoard`.
    */
    expect(
      order(["third", value(true, 31)], ["first", value(true, 3)], ["second", value(true, 12)]),
    ).toEqual(["first", "second", "third"]);
  });

  it("puts a player his club has cut last, however early his ADP", () => {
    /*
      **The 2026-09-16 ruling, and the only line of it the screen owns.**

      `player_rankings_current` is `DISTINCT ON … as_of DESC` over a table whose
      rows are never deleted, only superseded by one with a later `as_of`, and
      `syncRankings` writes only for players in the provider's feed that day. So
      a player who drops out of that feed is never superseded again and keeps the
      ADP he had on the way out. Nothing expires it and no job prunes it.

      A player still *in* the feed does get a fresh row daily and his ADP moves
      in either direction — that case is fine and is not what this defends.

      That is why this survives the reversal rather than being dropped with the
      projection keys. Under the old order the demotion protected against a stale
      *projection*; it now protects against a stale *ADP*, which is the same
      hazard from the other store. Rank 40 against rank 900 is the shape that
      would put Tyreek Hill in round four.
    */
    expect(
      order(["cut star", value(false, 40)], ["ordinary starter", value(true, 900)]),
    ).toEqual(["ordinary starter", "cut star"]);
  });

  it("keeps the ruling even when the loader's own ordering would have held", () => {
    /*
      The check above is a **restatement, not a derivation**. `rank` already
      encodes `p.active DESC`, so on today's data this branch decides no
      ordering the loader had not already decided.

      Deleting the line fails **two** tests — this one and the cut-player test
      above it. Measured, not assumed: the comparator was mutated to
      `a.rank - b.rank` and the suite run, and those two are the pair that died.
      This one is the narrower pin, asserting the branch directly rather than
      through a sorted list.

      It is kept because the day `loadDraftBoard`'s ordering changes — a new
      source, a different `ORDER BY`, a caller that re-ranks a filtered pool — is
      the day a rank-only sort silently reverses a product ruling on the one
      screen where money is being committed. Pinned here so that deletion is a
      failing test rather than a quiet regression.
    */
    expect(byDraftValue(value(false, 1), value(true, 999))).toBeGreaterThan(0);
  });

  it("orders two cut players against each other on the same rule", () => {
    // Being cut decides the group, not the order within it — a manager taking a
    // stash still wants the earlier-drafted of two.
    expect(order(["later", value(false, 900)], ["earlier", value(false, 300)])).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("leaves the unranked tail at the bottom, still draftable", () => {
    /*
      Players with no ADP at all — rookies, deep bench, most of the ~570 the
      board admits — are not special-cased here and must not be. The loader's
      `NULLS LAST` has already numbered them after everyone ranked, so they
      arrive carrying large ranks and sort themselves.

      Last, never absent: a late flier on someone unranked is a legitimate pick.
    */
    expect(order(["unranked", value(true, 812)], ["ranked", value(true, 44)])).toEqual([
      "ranked",
      "unranked",
    ]);
  });

  it("is antisymmetric, so the pool's arrival order cannot change the board", () => {
    /*
      `Array.prototype.sort` is only stable for elements the comparator calls
      equal. This one never does — `rank` is dense over the whole board, so two
      players never share one — which means the rendered order is a function of
      the data alone and not of which filter the manager clicked first.

      Asserted rather than assumed because the comparator has an early return on
      a different field, which is the usual way this property gets broken.
    */
    const pairs: [DraftValue, DraftValue][] = [
      [value(true, 3), value(false, 1)],
      [value(true, 3), value(true, 90)],
      [value(false, 12), value(false, 400)],
    ];

    for (const [a, b] of pairs) {
      expect(Math.sign(byDraftValue(a, b))).toBe(-Math.sign(byDraftValue(b, a)));
    }
  });
});
