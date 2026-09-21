/**
 * The pick board, as a grid.
 *
 * A column per team in draft order, a row per round, and the snake reversing
 * every other row — the shape every draft room in the sport uses, because it is
 * the one that answers "when do I pick again" by counting downwards.
 *
 * **Nothing here computes the snake.** Every cell's position comes from
 * `pickPosition` in `@rostr/core`, the same function the server uses to decide
 * whose turn it is. A board that worked the ordering out for itself would be a
 * second implementation of the one rule the whole draft turns on, and the first
 * time the two disagreed the room would highlight the wrong seat while the
 * server accepted a pick from somebody else.
 *
 * It lives in `lib/` rather than in the component because `apps/web` cannot
 * render a component in a test — both vitest projects are node-environment with
 * no jsdom — so a rule written in `.tsx` is checked only by being run in
 * production. Same reasoning as `lib/lobby.ts` and `lib/pot.ts`.
 */

import { pickPosition, totalPicks } from "@rostr/core";

export interface BoardPick {
  readonly pickNumber: number;
  readonly teamId: string;
  readonly playerId: string;
  readonly source: string;
}

export type CellState = "MADE" | "ON_CLOCK" | "FUTURE";

export interface BoardCell {
  readonly pickNumber: number;
  /** `"3.04"` — the round and the pick within it, as everyone says them aloud. */
  readonly label: string;
  readonly teamId: string;
  /** Null until the pick is made. */
  readonly playerId: string | null;
  readonly source: string | null;
  readonly state: CellState;
}

export interface BoardRow {
  readonly round: number;
  /**
   * Which way this round runs.
   *
   * Rendered as an arrow on the row, because the reversal is the single thing
   * about a snake draft that people get wrong when planning two picks ahead.
   */
  readonly direction: "FORWARD" | "REVERSE";
  /** One per team, in **column** order — index 0 is the first seat, always. */
  readonly cells: readonly BoardCell[];
}

/**
 * Lay the board out.
 *
 * `order` is the drawn draft order, so column *i* is always the team holding
 * seat *i* whatever round is being drawn — which is what makes a column
 * readable as one team's draft.
 *
 * Returns an empty board rather than throwing when the order has not been
 * drawn. That state is ordinary: the room renders before the commissioner
 * presses the button, and a throw there would blank the whole screen.
 */
export function buildBoard(input: {
  readonly order: readonly string[];
  readonly rounds: number;
  readonly picks: readonly BoardPick[];
  /** The pick on the clock, or null when the draft has not started or is done. */
  readonly currentPickNumber: number | null;
}): readonly BoardRow[] {
  const teamCount = input.order.length;
  if (teamCount === 0 || input.rounds < 1) return [];

  const made = new Map(input.picks.map((pick) => [pick.pickNumber, pick]));
  const last = totalPicks(teamCount, input.rounds);

  // Seeded with nulls and filled by position, rather than pushed in pick order.
  // A round that is only half drafted still has to occupy the right columns, and
  // in a reversed round "the third pick made" and "the third column" are
  // different cells.
  const rows: BoardCell[][] = Array.from({ length: input.rounds }, () =>
    Array.from({ length: teamCount }, () => null as unknown as BoardCell),
  );

  for (let pickNumber = 1; pickNumber <= last; pickNumber++) {
    const { round, pickInRound, orderIndex } = pickPosition(pickNumber, teamCount);
    const pick = made.get(pickNumber);

    rows[round - 1]![orderIndex] = {
      pickNumber,
      label: `${round}.${String(pickInRound).padStart(2, "0")}`,
      teamId: input.order[orderIndex]!,
      playerId: pick?.playerId ?? null,
      source: pick?.source ?? null,
      state:
        pick !== undefined
          ? "MADE"
          : pickNumber === input.currentPickNumber
            ? "ON_CLOCK"
            : "FUTURE",
    };
  }

  return rows.map((cells, index) => ({
    round: index + 1,
    // Odd rounds run down the order; even rounds come back up it.
    direction: (index + 1) % 2 === 1 ? "FORWARD" : "REVERSE",
    cells,
  }));
}

/**
 * Which round to scroll to.
 *
 * The round on the clock, or the last round once the draft is over — never
 * round one, which is where a naive board sits while the interesting part
 * happens eleven rows below the fold.
 */
export function focusRound(
  rows: readonly BoardRow[],
  currentPickNumber: number | null,
): number {
  if (rows.length === 0) return 1;
  if (currentPickNumber === null) return rows[rows.length - 1]!.round;

  const row = rows.find((candidate) =>
    candidate.cells.some((cell) => cell.pickNumber === currentPickNumber),
  );
  return row?.round ?? 1;
}

/**
 * How many picks until this team is up again, counting from the pick on the
 * clock. `null` when they have no picks left, `0` when they are on the clock.
 *
 * The number a manager actually wants during someone else's turn, and the one
 * that is genuinely awkward to eyeball on a snake — the gap alternates between
 * short and long, and it is the long one that decides whether to reach for a
 * position now.
 */
export function picksUntilTurn(
  rows: readonly BoardRow[],
  teamId: string | null,
  currentPickNumber: number | null,
): number | null {
  if (teamId === null || currentPickNumber === null) return null;

  const next = rows
    .flatMap((row) => row.cells)
    .filter((cell) => cell.teamId === teamId && cell.pickNumber >= currentPickNumber)
    .sort((a, b) => a.pickNumber - b.pickNumber)[0];

  return next ? next.pickNumber - currentPickNumber : null;
}

/** Only the fields the ordering reads, so a test needs no board row. */
export interface DraftValue {
  readonly active: boolean;
  /**
   * The server's dense 1..n board index. `loadDraftBoard` orders on
   * `p.active DESC, r.overall_milli NULLS LAST, p.full_name` and numbers the
   * result — so ascending `rank` is ADP order *within* each club group, with
   * every cut player already banished to the tail. Not ADP order outright, and
   * the `active` branch below depends on the difference.
   */
  readonly rank: number;
}

/**
 * Board order: on an NFL roster first, then ADP.
 *
 * **Reversed on 2026-09-21 by the owner**, who asked for the board to run in ADP
 * order with projected points shown beside it rather than deciding it. It
 * previously sorted on this league's own projection with ADP as the tiebreak.
 * Both numbers are still on screen; what changed is which one sorts.
 *
 * The argument for the old order was that a projection scored against this
 * league's rules says what a player is worth *here*, while ADP is a crowd's
 * opinion filtered through other people's settings. The argument that won is
 * that a draft room is read against the draft actually happening: managers
 * arrive with a board already in their heads, and a list that disagrees with it
 * reads as broken rather than as opinionated. The projection is one column away,
 * which is the right weight for a second opinion.
 *
 * **`active` is restated here rather than inherited.** `rank` already encodes it
 * — the loader's `ORDER BY p.active DESC, r.overall_milli NULLS LAST, …` puts
 * cut players last *before* numbering — so this line changes no ordering today.
 * It is kept because it is the only place the screen itself owns the 2026-09-16
 * ruling that a released player sorts to the bottom, and that ruling is load
 * bearing: `player_rankings_current` is `DISTINCT ON … as_of DESC` over a table
 * whose rows are never deleted, only superseded by one with a later `as_of`.
 * `syncRankings` writes only for players in the provider's feed *that day*, so
 * a player who drops out of it is never superseded again and keeps the ADP he
 * had on the way out for ever. A sort that trusted `rank` alone would float him
 * back into round four the moment the loader's ordering moved. See
 * `docs/DECISIONS.md`.
 *
 * **There is no projection tiebreak, because there can be no tie.** `rank` is a
 * dense index over the whole board, so two rows never share one — a tiebreak
 * here would be unreachable against any board the loader can actually produce,
 * coverable only by a hand-built fixture asserting a state that cannot occur.
 *
 * Unranked players still sort last and stay draftable: the loader's `NULLS LAST`
 * puts them at the end of the numbering, so a late flier on someone with no ADP
 * remains a legitimate pick.
 */
export function byDraftValue(a: DraftValue, b: DraftValue): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  return a.rank - b.rank;
}
