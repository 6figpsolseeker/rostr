import "server-only";

/**
 * What a `score-week` run writes into `cron_runs.last_outcome`.
 *
 * ## Why this is not in the route
 *
 * `apps/web/src/app/api/cron/score-week/route.test.ts` is
 * `describe.skipIf(!DATABASE_URL)`, so it runs on nobody's machine and never in
 * CI. Every rule that lived in the route body was therefore verified only by
 * being run in production — the reason `lib/lobby.ts`, `lib/setup.ts` and
 * `lib/ops.ts` exist. `apps/web/src/lib/*.test.ts` **is** collected by the root
 * `vitest.config.ts` and needs no database, so a test here actually executes.
 *
 * ## The rule this file exists to get right
 *
 * `cronJobState` reads **any** non-null outcome as `FAILING`, and it checks that
 * before it checks staleness. So a note written on a healthy run does not merely
 * add noise: it pins the job red, and a red job can never report `STALE`. While
 * a permanent note is being written, a scheduler that stops firing altogether
 * looks exactly like one that is working.
 *
 * That is not hypothetical here. `score-week` wrote one on every run for the
 * whole regular season — see the gate in `route.ts` — so for roughly a hundred
 * days a year the only monitoring on the job that decides money was reporting a
 * constant, and the staleness detector behind it was switched off.
 *
 * **So the test for a note is not "did something unusual happen". It is "is
 * there something a person should go and do".** `onFallback` and `overdue` earn
 * it; a league waiting out its correction window does not.
 */

/** One week, as the run reports it. Mirrors the route's response shape. */
export interface WeekRow {
  readonly week: number;
  readonly finalized: boolean;
  readonly holdReason?: string;
  /**
   * Set when the hold can never clear on its own — today only `NO_SCHEDULE`.
   *
   * Matched as a code rather than by reading `holdReason`, so that rewording an
   * operator-facing sentence cannot silently disable the alarm behind it.
   */
  readonly holdCode?: string;
  readonly finalizedWithUnfinishedGames?: string;
}

/** One league, as the run reports it. */
export interface LeagueRow {
  readonly weeks?: readonly WeekRow[];
  readonly failedWeeks?: readonly { readonly week: number }[];
  readonly deferredWeeks?: readonly number[];
  readonly bracketProblem?: string;
  readonly skipped?: string;
  readonly prefillProblem?: string;
}

/**
 * Did this league fail to get scored?
 *
 * Three conditions, and they mean the same thing — the league did not get the
 * work done that this run exists to do. `bracketProblem` **stays in this set**,
 * and that is the decision: after the call gate in `route.ts`, a bracket
 * refusal is no longer the normal state of a healthy league, so any refusal
 * that still arrives is a league already in `PLAYOFFS` whose regular season
 * came apart underneath it, our own `INVARIANT`, or an unrecognised class. All
 * three deserve an alarm.
 *
 * `deferredWeeks` joins them, and did not before. A league whose sweep hit
 * `SWEEP_LIMIT` has weeks it never examined, which is the same "did not get
 * scored" this counter is named for — and it was reported only in a response
 * body nobody retains.
 */
function leagueFailed(row: LeagueRow): boolean {
  return Boolean(
    row.skipped || row.failedWeeks?.length || row.deferredWeeks?.length || row.bracketProblem,
  );
}

/** Weeks that will never finalise without somebody intervening. */
function overdueWeeks(row: LeagueRow): readonly number[] {
  return (row.weeks ?? []).filter((w) => !w.finalized && w.holdCode).map((w) => w.week);
}

/**
 * The note for one run, or `null` when there is nothing to say.
 *
 * `null` is the healthy answer and has to stay reachable — it is the only thing
 * that lets `cron:status` report `OK`, and therefore the only thing that lets it
 * ever report `STALE`.
 */
export function scoreWeekNotes(rows: readonly LeagueRow[]): string | null {
  const failed = rows.filter(leagueFailed).length;
  const prefillProblems = rows.filter((r) => r.prefillProblem).length;

  /*
    A week that settled on the clock rather than on complete data.

    Deliberately **not** folded into `failed`. That count means "this league did
    not get scored", which is recoverable and will be retried; a fallback
    settlement is the opposite — the league was scored, once, for good, and no
    retry can reach it.
  */
  const onFallback = rows.filter((r) =>
    r.weeks?.some((w) => w.finalizedWithUnfinishedGames),
  ).length;

  /*
    The wedge, and the reason the bracket gate alone was not enough.

    A week with no `games` rows holds forever: no kickoff, so no window, so the
    fallback that ends every other wait never runs. It does not throw, so it is
    not in `failedWeeks`; later weeks finalise normally, so the sweep never
    defers it. Before this, the only thing that reported such a league was the
    bracket refusal it caused — which fired on healthy leagues too, so it named
    a real problem with a message that was true of everybody.

    Now the bracket refusal is gone for healthy leagues, so this has to be said
    directly or it would be said nowhere at all.
  */
  const overdue = rows.flatMap((r) => overdueWeeks(r));

  const notes = [
    ...(failed > 0 ? [`${failed} of ${rows.length} leagues had a problem`] : []),
    ...(overdue.length > 0
      ? [
          `${overdue.length} week(s) can never finalise and are holding the bracket: ` +
            `week ${[...new Set(overdue)].sort((a, b) => a - b).join(", ")}`,
        ]
      : []),
    ...(prefillProblems > 0
      ? [`${prefillProblems} of ${rows.length} leagues could not prefill next week's lineups`]
      : []),
    ...(onFallback > 0
      ? [
          `${onFallback} league(s) finalised a week on the correction-window fallback — ` +
            `those scores are permanent`,
        ]
      : []),
  ];

  return notes.length > 0 ? notes.join("; ") : null;
}
