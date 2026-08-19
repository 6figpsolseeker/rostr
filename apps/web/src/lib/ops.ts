/**
 * The operator view's decisions, kept where a test can reach them.
 *
 * `apps/web` cannot render a component in a test — both vitest projects are
 * node-environment with no jsdom — so anything the screen *decides* lives here
 * and the component only draws it. Same reasoning that put `buildLobbyView` in
 * `lib/lobby.ts` and the commissioner checklist in `lib/setup.ts`; in the
 * `@rostr/escrow` case both defects review found were in a mapping inside a
 * component rather than in the rule it implemented.
 */

/** The correction window, from `RULES.md` §7. Hours after a game goes final. */
const ORDINARY_WINDOW_HOURS = 48;
const PAYING_WINDOW_HOURS = 168;

/** Weeks that pay money and therefore wait seven days rather than two. */
const PAYING_WEEKS = new Set([14, 17]);

export type ProblemStatus =
  /** The game has not finished. Nothing to correct yet. */
  | "NOT_FINAL"
  /** Inside the correction window — a fix still reaches the scores. */
  | "OPEN"
  /** The window has closed. A correction now changes nothing anyone reads. */
  | "CLOSED";

export interface ProblemRow {
  readonly gameRef: string;
  readonly season: number;
  readonly week: number;
  readonly problem: string;
  readonly status: ProblemStatus;
  /** Whole hours since the game went final; `null` when it has not. */
  readonly hoursSinceFinal: number | null;
  /** The window this week gets, in hours. Named so the screen can say why. */
  readonly windowHours: number;
}

export interface OpsView {
  readonly total: number;
  readonly shown: number;
  /** Problems still worth acting on, newest first. */
  readonly actionable: readonly ProblemRow[];
  /** Problems that can no longer be fixed. Kept visible deliberately. */
  readonly expired: readonly ProblemRow[];
}

/**
 * How long this week waits before its scores are settled.
 *
 * Weeks 14 and 17 decide money and the NFL issues official stat corrections for
 * up to seven days, so those wait 168 hours where everything else waits 48.
 * Read from the week number rather than from a league's frozen rules on purpose:
 * this screen is about the *provider*, and the same bad box score reaches every
 * league whatever each of them agreed. A league with an unusual window is a
 * league whose own scoring page is the right place to look.
 */
export function windowHoursFor(week: number): number {
  return PAYING_WEEKS.has(week) ? PAYING_WINDOW_HOURS : ORDINARY_WINDOW_HOURS;
}

/**
 * Whether a flagged game can still be corrected.
 *
 * **The distinction this screen exists to draw.** A finalised week is never
 * rescored, so a correction applied after the window writes a revision that
 * nothing will ever read — the operator would believe they had fixed a matchup
 * they had not. Reporting `CLOSED` is the honest answer and it is the reason
 * `finalAt` is carried all the way from the query.
 *
 * The boundary is inclusive of the window: at exactly 48 hours the window has
 * elapsed and the sweep may already have settled the week, so the safe reading
 * is closed. Being early costs a warning that says "probably too late" on a
 * fixable game; being late tells somebody a correction landed when it did not.
 */
export function statusOf(
  finalAt: Date | null,
  week: number,
  now: Date,
): { status: ProblemStatus; hoursSinceFinal: number | null } {
  if (finalAt === null) return { status: "NOT_FINAL", hoursSinceFinal: null };

  const elapsedHours = Math.floor((now.getTime() - finalAt.getTime()) / 3_600_000);
  // A game whose `final_at` is in the future is a clock problem, not an open
  // window. Treated as not final rather than as fresh, because the honest
  // answer to "how long ago" is that it has not happened.
  if (elapsedHours < 0) return { status: "NOT_FINAL", hoursSinceFinal: null };

  return {
    status: elapsedHours >= windowHoursFor(week) ? "CLOSED" : "OPEN",
    hoursSinceFinal: elapsedHours,
  };
}

/**
 * Turn the raw problem list into what the screen draws.
 *
 * Split rather than sorted, because the two halves call for different actions
 * and a single list ordered by time buries the urgent one under a season of
 * history. `expired` is kept rather than dropped: a game nobody can fix is
 * still evidence about the provider, and a growing tail of them is the argument
 * for wiring a second source into ingestion rather than reading this page.
 */
export function buildOpsView(
  input: {
    readonly total: number;
    readonly games: readonly {
      readonly gameRef: string;
      readonly season: number;
      readonly week: number;
      readonly problem: string;
      readonly finalAt: Date | null;
    }[];
  },
  now: Date,
): OpsView {
  const rows: ProblemRow[] = input.games.map((game) => {
    const { status, hoursSinceFinal } = statusOf(game.finalAt, game.week, now);
    return {
      gameRef: game.gameRef,
      season: game.season,
      week: game.week,
      problem: game.problem,
      status,
      hoursSinceFinal,
      windowHours: windowHoursFor(game.week),
    };
  });

  return {
    total: input.total,
    shown: rows.length,
    actionable: rows.filter((row) => row.status !== "CLOSED"),
    expired: rows.filter((row) => row.status === "CLOSED"),
  };
}
