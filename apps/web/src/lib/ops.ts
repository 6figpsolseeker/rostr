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
  /**
   * The week's clock has not started — a game in it has yet to kick off.
   *
   * Was `NOT_FINAL`, which asked about *this game* from inside a union that
   * means "can this week be corrected". See `statusOf`.
   */
  | "WEEK_IN_PLAY"
  /** Inside the correction window — a fix still reaches the scores. */
  | "OPEN"
  /** The window has closed. A correction now changes nothing anyone reads. */
  | "CLOSED";

export interface ProblemRow {
  readonly gameRef: string;
  readonly season: number;
  readonly week: number;
  /** What we hold. Drives the tone and the grouping — see `toneOf`. */
  readonly ingest: IngestState;
  /**
   * The provider's complaint, when there is one.
   *
   * Nullable, and it was not before: a game selected by the clock rather than by
   * an error carries nothing here. A caller that assumes a string renders an
   * empty card, which is how the state this screen was fixed to show would stay
   * invisible after all of it.
   */
  readonly problem: string | null;
  readonly status: ProblemStatus;
  /** Whole hours since the week's last kickoff; `null` before it. */
  readonly hoursSinceWeekEnd: number | null;
  /** The window this week gets, in hours. Named so the screen can say why. */
  readonly windowHours: number;
  /** Whether the provider has called this game final. Shown, never a tier. */
  readonly isFinal: boolean;
}

export type RunBanner = {
  readonly state: "OK" | "STALE" | "FAILING" | "NEVER_RAN";
  readonly detail: string;
};

export interface OpsView {
  readonly total: number;
  readonly shown: number;
  /**
   * Games whose box score is missing or behind the game, in a week that can
   * still be corrected.
   *
   * Both severities. "No usable box score" would be wrong for the STALE half,
   * which has one.
   *
   * The count fit to drive an alarm, and the only one here that can fall to
   * zero. Computed by the query rather than from the rows below, because those
   * are truncated by the LIMIT and a truncated count presented as a total is the
   * same lie one layer down.
   */
  readonly blockingRecent: number;
  /** No usable box score. Every player in these games scores zero. */
  readonly noStats: readonly ProblemRow[];
  /** Stats exist; the latest read failed. The scoreboard is behind the game. */
  readonly stale: readonly ProblemRow[];
  /** Ingested, with something that did not reconcile. Roughly one game in seven. */
  readonly discrepancies: readonly ProblemRow[];
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
 * Whether a flagged game's week can still be corrected.
 *
 * **The distinction this screen exists to draw.** A finalised week is never
 * rescored, so a correction applied after the window writes a revision that
 * nothing will ever read — the operator would believe they had fixed a matchup
 * they had not.
 *
 * ## The anchor is the week's last kickoff, and it used to be the game's own
 *
 * `finalizationHold` clears a week at `max(kickoff_at) + finalizationHours`, over
 * the whole week. This measured from the individual game's `final_at`, which is a
 * different clock rather than a different latency — so the two disagreed in both
 * directions, and after #256 made `final_at` accurate the dominant error grew
 * rather than shrank. An early Sunday game read `CLOSED` roughly **28 hours
 * before** its week actually settled: the screen telling an operator a
 * correction was pointless while it would still have landed. That slot holds 123
 * of the 256 synced fixtures.
 *
 * **What is fixed is the anchor, not the duration.** `windowHoursFor` stays
 * sport-level and its reasoning below is untouched: this screen is about the
 * provider, and the same bad box score reaches every league. So for a league on
 * the default correction window — which invariant 5 forces on every paying week,
 * and which every league that exists today uses — this now agrees with
 * `finalizationHold` exactly rather than approximately. A league that varied its
 * window still diverges, by exactly the amount it varied, which is the class of
 * error this function already accepts on purpose.
 *
 * The boundary is inclusive: at exactly 48 hours the window has elapsed and the
 * sweep may already have settled the week, so the safe reading is closed.
 */
export function statusOf(
  weekLastKickoff: Date,
  week: number,
  now: Date,
): { status: ProblemStatus; hoursSinceWeekEnd: number | null } {
  const elapsedHours = Math.floor((now.getTime() - weekLastKickoff.getTime()) / 3_600_000);

  /*
    The week's clock has not started, because a game in it has not kicked off.

    **Renamed from `NOT_FINAL`, and the rename is a fix.** That value asked
    whether *this game* had finished, from inside a union that means "can this be
    corrected" — and once the anchor moved it became reachable for a game that
    demonstrably had finished, whose week merely still had a fixture to come. It
    rendered as the calmest chip on the page, which is the same misplaced calm
    this whole change is about.

    Kept as a third value rather than folded into OPEN, because there is
    genuinely no number to show: the countdown has not begun, and reporting
    "0 of 48 hours" would imply it had.
  */
  if (elapsedHours < 0) return { status: "WEEK_IN_PLAY", hoursSinceWeekEnd: null };

  return {
    status: elapsedHours >= windowHoursFor(week) ? "CLOSED" : "OPEN",
    hoursSinceWeekEnd: elapsedHours,
  };
}

/**
 * What we hold for this game, as one word.
 *
 * Carried from SQL rather than recomputed here, deliberately. The severity that
 * labels a row and the severity that sorts it must be one expression, or a row
 * can sort into one bucket and wear another — which is issue #233's own defect
 * one layer up. What this module owns is the *presentation* of that fact: the
 * tone, the ordering of the sections, and the sentence.
 */
export type IngestState = "NO_STATS" | "STALE" | "DISCREPANCY";

/**
 * The tone a row is drawn in.
 *
 * **Keyed on what we hold, never on whether it can still be fixed**, and that
 * reassignment is the presentation half of issue #233. Colour used to come from
 * the window status, so a game whose every read had failed — no stats at all,
 * every player scoring zero — rendered in the lowest-contrast tone on the page,
 * because its provider had not yet called it final. The most severe state got
 * the calmest chip, by default, every Sunday.
 */
export function toneOf(ingest: IngestState): "critical" | "warning" | "neutral" {
  if (ingest === "NO_STATS") return "critical";
  if (ingest === "STALE") return "warning";
  return "neutral";
}

/**
 * One sentence saying what this state does to a score.
 *
 * Here rather than in the component for the reason at the top of this file, and
 * for one more: the sentence it replaces was a **page-level** claim across a
 * heterogeneous list — *"the stat lines were still ingested… so every one of
 * these games has been scored"* — which was false for two of the three states
 * and was rendered to the operator at the moment they decided whether to act.
 * A claim that can only be true of some rows belongs on a row.
 */
export function ingestSentence(row: ProblemRow): string {
  if (row.ingest === "NO_STATS") {
    return row.status === "CLOSED"
      ? "No box score was ever read for this game. Every player in it scored zero, permanently."
      : "No box score has been read for this game. Every player in it currently scores zero.";
  }
  if (row.ingest === "STALE") {
    // **Not "the most recent read failed".** That is one of two ways to get here
    // and not the more common one: a game starved by `MAX_GAMES_PER_RUN`, or
    // skipped by the consecutive-failure breaker, has had no read attempted
    // since the whistle at all. Naming a failure that did not happen sends an
    // operator looking for an error that is not there.
    return (
      "Stat lines exist from a read taken before the game finished, and nothing has " +
      "been read successfully since, so these are not the final numbers."
    );
  }
  return "The stat lines were ingested — this is a discrepancy, not a failure — so this game has been scored, possibly wrongly.";
}

/**
 * Turn the raw problem list into what the screen draws.
 *
 * Grouped by **what we hold** rather than split by recoverability, which is the
 * change #233 asked for: the old two-way split answered "can I act" for a list
 * whose rows differed by an order of magnitude in what they cost. Recoverability
 * survives as a chip on every row.
 *
 * There was a `blockingOpen` count here too — `noStats` rows still inside their
 * window — computed, documented and unit-tested, and read by nothing. The page
 * renders recoverability per row, so no header wanted it. A field written by
 * something and read by nothing is the shape this screen exists to correct, and
 * shipping one inside the fix would have been the joke telling itself. If a
 * banner ever needs the number, it is one `filter` and it should arrive with
 * its reader.
 */
export function buildOpsView(
  input: {
    readonly total: number;
    readonly blockingRecent: number;
    readonly games: readonly {
      readonly gameRef: string;
      readonly season: number;
      readonly week: number;
      readonly ingest: IngestState;
      readonly problem: string | null;
      readonly finalAt: Date | null;
      readonly syncedAt: Date | null;
      readonly isFinal: boolean;
      readonly weekLastKickoff: Date;
    }[];
  },
  now: Date,
): OpsView {
  const rows: ProblemRow[] = input.games.map((game) => {
    const { status, hoursSinceWeekEnd } = statusOf(game.weekLastKickoff, game.week, now);
    return {
      gameRef: game.gameRef,
      season: game.season,
      week: game.week,
      ingest: game.ingest,
      problem: game.problem,
      status,
      hoursSinceWeekEnd,
      windowHours: windowHoursFor(game.week),
      isFinal: game.isFinal,
    };
  });

  const of = (state: IngestState) => rows.filter((row) => row.ingest === state);

  return {
    total: input.total,
    shown: rows.length,
    blockingRecent: input.blockingRecent,
    noStats: of("NO_STATS"),
    stale: of("STALE"),
    discrepancies: of("DISCREPANCY"),
  };
}

/**
 * The stats job's own last run, rendered above the list.
 *
 * **An empty list beside a job that is not running is a false all-clear**, and it
 * is the same defect as the prose this change deletes — a reassuring statement
 * the code cannot support, shown to somebody deciding whether to act.
 *
 * It is also the only way a **run-level** failure reaches this screen at all.
 * The pool check that refuses a run whose player pool has a position group at
 * zero throws before the game loop, so it writes no `stats_error` and produces no
 * row here — and the same is true of a database fault, a provider auth failure,
 * a season that threw, and the "a slate was under way and nothing was selected"
 * alarm added with #256. Every one of those turns `pnpm cron:status` red and,
 * until now, left this page saying "nothing flagged".
 *
 * Stamping those faults onto individual games was the obvious alternative and is
 * wrong: it writes a fact about the *run* onto rows that were never attempted,
 * and the retry clause would then pace against it.
 */
export function buildRunBanner(
  run: { readonly lastRanAt: Date | null; readonly lastOutcome: string | null } | undefined,
  now: Date,
): RunBanner {
  if (run === undefined || run.lastRanAt === null) {
    return { state: "NEVER_RAN", detail: "The stats job has no recorded run." };
  }
  if (run.lastOutcome !== null) {
    return { state: "FAILING", detail: run.lastOutcome };
  }
  const minutesAgo = Math.floor((now.getTime() - run.lastRanAt.getTime()) / 60_000);
  /*
    Stale, not failing. The job runs every ten minutes; an hour of silence is a
    scheduler problem rather than an ingest one, and saying so sends somebody to
    the right place. Generous, because a single missed tick is not news and an
    alarm that fires on one is an alarm that gets muted.
  */
  if (minutesAgo >= 60) {
    return {
      state: "STALE",
      detail: `The stats job last completed ${minutesAgo} minutes ago.`,
    };
  }
  return { state: "OK", detail: `The stats job last completed ${minutesAgo} minutes ago.` };
}
