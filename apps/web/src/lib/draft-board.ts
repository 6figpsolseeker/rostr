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
