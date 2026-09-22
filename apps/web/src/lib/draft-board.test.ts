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
  const value = (rank: number): DraftValue => ({ rank });

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
      `ORDER BY r.overall_milli NULLS LAST`, so ascending `rank` *is* ascending
      ADP. Nothing here re-derives it — see `loadDraftBoard`.
    */
    expect(order(["third", value(31)], ["first", value(3)], ["second", value(12)])).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("reads nothing but rank — the club guard left here on 2026-09-22", () => {
    /*
      **Two tests were deleted to make room for this one, and this comment is
      their replacement.** They asserted that a player his club had cut sorted
      last however early his ADP, and the reasoning they carried is the
      reasoning that turned out to be wrong: `player_rankings_current` never
      expires a row, therefore a released player keeps the ADP he had while he
      was playing, therefore rank 40 against rank 900 "is the shape that would
      put Tyreek Hill in round four".

      Hill was then measured, against production, on 2026-09-22. **ADP 297.4,
      `as_of` the day before — current, not frozen.** The provider re-prices a
      released player downward rather than dropping him: the best club-less ADP
      in the whole 2026 pool is 249.0, against a 12-team 15-round draft that
      ends at pick 180. Forty-two players carry a frozen row and nine of those
      are also cut — Moody 249.0, Chubb 330.6, Hardman 337.5 among them — every
      one of them harmless, because harmless is what the data does with them.

      So this comparator reads `rank` and nothing else, and `DraftValue` no
      longer carries `active`: reintroducing the guard means widening the type,
      which is where that argument should happen. The fixture below deliberately
      cannot express "cut".

      **The guard itself is not gone.** It lives in `autopick.ts` and is pinned
      by that suite. What is gone is the claim that this comparator inherits it
      — a bot's endgame scans one position at a time, where the 180-pick margin
      that makes this screen safe does not exist.

      What no unit test here can pin: a player the provider stops listing
      *entirely* would still freeze at his last ADP. That is watched by a query,
      not an assertion — `docs/DATA-MODEL.md`. Run it before reinstating
      anything in this file.
    */
    expect(order(["early", value(40)], ["late", value(900)])).toEqual(["early", "late"]);
  });

  it("leaves the unranked tail at the bottom, still draftable", () => {
    /*
      Players with no ADP at all — rookies, deep bench, practice squads — are
      not special-cased here and must not be. Measured 2026-09-22, that is
      **1,022 of the 1,589** players the board admits: two rows in three. The
      loader's `NULLS LAST` has already numbered them after everyone ranked, so
      they arrive carrying large ranks and sort themselves.

      It is also why the room's ADP column prints a real ADP or an em dash and
      never `rank` — see `adp` in `lib/player.ts`.

      Last, never absent: a late flier on someone unranked is a legitimate pick.
    */
    expect(order(["unranked", value(812)], ["ranked", value(44)])).toEqual([
      "ranked",
      "unranked",
    ]);
  });

  it("is antisymmetric, so the pool's arrival order cannot change the board", () => {
    /*
      `Array.prototype.sort` is only stable for elements the comparator calls
      equal. This one never does — `rank` is dense over the whole board, so two
      rows never share one — which means the rendered order is a function of the
      data alone and not of which filter the manager clicked first.
    */
    const pairs: [DraftValue, DraftValue][] = [
      [value(3), value(1)],
      [value(3), value(90)],
      [value(12), value(400)],
    ];

    for (const [a, b] of pairs) {
      expect(Math.sign(byDraftValue(a, b))).toBe(-Math.sign(byDraftValue(b, a)));
    }
  });
});
