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
  const value = (
    active: boolean,
    rank: number,
    projectedMilliPoints: number | null,
  ): DraftValue => ({ active, rank, projectedMilliPoints });

  /** Names, so a failure says which ordering broke rather than which index. */
  const order = (...players: [string, DraftValue][]): string[] =>
    [...players].sort((x, y) => byDraftValue(x[1], y[1])).map(([name]) => name);

  it("puts a player his club has cut last, however good his projection", () => {
    /*
      The reason this function exists.

      `loadDraftBoard` already returns cut players last, but the room re-sorts on
      projections — and `loadProjections` does not filter on `players.active`
      while `syncProjections` never deletes a row. So a receiver projected for
      180 points who is cut in September keeps that number for ever, and a sort
      that consulted only the projection would put him in the top handful.

      The server's demotion reaches the draft *engine*, which ranks on `rank`.
      It does not reach the *screen* unless it is restated here.
    */
    expect(
      order(
        ["cut star", value(false, 40, 180_000)],
        ["ordinary starter", value(true, 900, 10_000)],
      ),
    ).toEqual(["ordinary starter", "cut star"]);
  });

  it("puts a cut player below even an active one nobody projected", () => {
    // The null-projection branch is the one an `active` check placed after the
    // projection comparison would get wrong.
    expect(
      order(["cut", value(false, 5, 200_000)], ["unprojected", value(true, 800, null)]),
    ).toEqual(["unprojected", "cut"]);
  });

  it("orders active players on projection, then ADP", () => {
    // A lock on the behaviour moved out of `DraftRoom.tsx`, so the extraction
    // is provably faithful rather than a rewrite.
    expect(
      order(
        ["lesser", value(true, 2, 8_000)],
        ["better", value(true, 90, 12_000)],
        ["unprojected", value(true, 3, null)],
      ),
    ).toEqual(["better", "lesser", "unprojected"]);
  });

  it("breaks an equal projection on ADP", () => {
    expect(
      order(["later adp", value(true, 50, 9_000)], ["earlier adp", value(true, 12, 9_000)]),
    ).toEqual(["earlier adp", "later adp"]);
  });

  it("orders two cut players against each other on the same rules", () => {
    // Being cut decides the group, not the order within it — a manager taking a
    // stash still wants the better of two.
    expect(
      order(["worse", value(false, 300, 4_000)], ["better", value(false, 900, 9_000)]),
    ).toEqual(["better", "worse"]);
  });
});
