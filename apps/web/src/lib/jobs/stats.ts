import { NextResponse } from "next/server";
import { NFL } from "@rostr/core";
import {
  gamesUnderWay,
  recordCronRun,
  seasonsInPlay,
  syncBoxScores,
  unresolvedStatsProblems,
} from "@rostr/db";
import type { SqlClient } from "@rostr/db";
import type { StatsProvider } from "@rostr/stats";

/**
 * The body of `/api/cron/stats`.
 *
 * ## Why it is not in `route.ts`
 *
 * Next enforces the shape of a `route.ts`: it may export request handlers and
 * segment config, and nothing else. An exported `run` alongside `GET` fails the
 * production build with "does not match the required types of a Next.js Route"
 * — which is caught by `pnpm build` and by nothing else, since `tsc`, eslint and
 * the test suite are all perfectly happy with it.
 *
 * So the job lives here and the route is the credential guard, the provider, and
 * the call. The split is what makes the job testable at all: `GET` reads
 * `TANK01_API_KEY` and constructs a real HTTP client, and a suite that calls a
 * metered third-party API is one that fails when somebody else's quota runs out.
 *
 * ## Failures are recorded, never thrown away
 *
 * A season that throws is stamped and the next season still runs, for the same
 * reason every per-league loop in this repo continues: one bad season must not
 * stop the others, and a route that fails silently reads as one that is working.
 * `syncBoxScores` already reports per-game failures without throwing, so a throw
 * here is a database or provider-level fault rather than one bad game.
 *
 * ## And warnings are not failures
 *
 * They used to be reported as if they were. Every discrepancy the translator
 * raised — a field-goal count disagreeing with the plays parsed from it, a
 * defence missing from the response, and from 2026-08-17 a `scoreType` nobody
 * has seen before — arrived in `failures` and was announced to the heartbeat as
 * "N game(s) failed to ingest", on a game whose ninety players had all been
 * written correctly.
 *
 * That is not a naming quibble. The whole value of a warning here is that a week
 * finalises after 48 hours and is never rescored, so the window in which anybody
 * can act on one is short — and a channel that cries failure on healthy runs is
 * a channel people stop opening. The two are counted and reported separately,
 * and both reach `cron_runs`.
 *
 * ## The backlog, because a heartbeat does not remember
 *
 * `cron_runs` holds one row per job and the next run overwrites it, so a warning
 * raised at noon is gone by ten past. `games.stats_error` is where it actually
 * survives, and until now nothing read that column back. `unresolvedStatsProblems`
 * does, and its count rides along on every run — so a discrepancy stays visible
 * until the game is re-read cleanly, rather than until the next tick.
 */
export async function runStatsJob(
  client: SqlClient,
  provider: StatsProvider,
  now: Date,
): Promise<NextResponse> {
  const seasons = await seasonsInPlay(client, NFL.key);

  const runs: {
    season: number;
    games?: number;
    /** Games being played at this instant. See the note above `problem`. */
    underWay?: number;
    /** Games the breaker stopped short of. Not failures — see the push below. */
    deferred?: readonly string[];
    inserted?: number;
    revised?: number;
    retracted?: number;
    /** Named rather than counted — a bare count once hid "every kicker". */
    unmatched?: readonly string[];
    failures?: readonly { gameRef: string; reason: string }[];
    /** Ingested, with something that did not reconcile. Not a failure. */
    warnings?: readonly { gameRef: string; warning: string }[];
    error?: string;
  }[] = [];

  for (const season of seasons) {
    try {
      /*
        Read **before** the ingest, so it describes the slate the run was about
        to look at rather than the one it left behind. Asked first for the same
        reason: if `syncBoxScores` throws, the season is already recorded as
        broken and this number would be missing from exactly the run that most
        needs it.
      */
      const underWay = await gamesUnderWay(client, NFL.key, season);
      const outcome = await syncBoxScores(client, provider, NFL.key, season);
      runs.push({
        season,
        underWay,
        games: outcome.games,
        /*
          Games the run stopped short of, because the provider had failed
          CONSECUTIVE_FAILURE_LIMIT times in a row.

          **Reported, and it was not.** `syncBoxScores` has returned this since
          the breaker was added and nothing read it, so a breaker trip was
          invisible in both the response body and the heartbeat — the same shape
          as the column written by something and read by nothing that this whole
          area keeps producing.

          It is not a failure and must not reach `problem`: nothing was
          attempted for these and nothing was stamped, so the next tick picks
          them up. A heartbeat that went red for the breaker working would be an
          alarm nobody trusts.
        */
        deferred: outcome.deferred,
        inserted: outcome.inserted,
        revised: outcome.revised,
        retracted: outcome.retracted,
        unmatched: outcome.unmatched,
        failures: outcome.failures,
        warnings: outcome.warnings,
      });
    } catch (error) {
      runs.push({
        season,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The outcome, not the fact of running. A row saying "ran, all fine" while a
  // season threw or half the games failed is the healthy face this record exists
  // to remove — and per-game failures do not throw, so without this line they
  // would never reach the heartbeat at all.
  const brokenSeasons = runs.filter((entry) => entry.error).length;
  const gameFailures = runs.reduce((total, entry) => total + (entry.failures?.length ?? 0), 0);
  const gameWarnings = runs.reduce((total, entry) => total + (entry.warnings?.length ?? 0), 0);
  const starvedSeasons = runs.filter(
    (entry) => (entry.underWay ?? 0) > 0 && entry.games === 0,
  ).length;

  // Everything unresolved, not only what this run happened to touch. A run that
  // fetched nothing is the normal case on a Tuesday and would otherwise report
  // itself clean over a game that has been failing since Sunday.
  const outstanding = await unresolvedStatsProblems(client, NFL.key);

  // **Every reason, joined — not the first one.** This was a chain of ternaries,
  // so a run with a broken season announced only that and said nothing about the
  // twelve games that also failed. A heartbeat is read once and acted on once.
  /*
    Only a **failure** reaches `last_outcome`, because that field is a state
    rather than a message: `cronJobState` returns `FAILING` for any non-null
    value, ahead of the staleness check. Anything written here is an alarm
    whatever the words say.

    Warnings used to be folded in, and #157 is about to make them common — a
    provider that contradicts itself on a finalised game contradicts itself
    forever, so the first such game would have turned `pnpm cron:status` red for
    the rest of the season. That command is this deployment's only heartbeat and
    CLAUDE.md tells every arriving session to run it first.

    `outstanding.total` is dropped for a sharper version of the same reason:
    `unresolvedStatsProblems` is deliberately unbounded by season or correction
    window — its docstring says so, and that is right for a *report* — so a game
    past its window can never be re-read, its `stats_error` is permanent by
    construction, and the count only ever grows. A permanently-true health signal
    is a broken one.

    This is #182's fix applied to the sibling job that did not get it:
    `season-sync` reported FAILING daily for the four week-16 and four week-17
    fixtures the NFL deliberately leaves undated. Same table, same shape.

    `outstanding.blockingRecent` belongs to the same rule and was briefly on the
    wrong side of it. It counts games the *provider* has not given us a complete
    box score for — a real thing to act on, and not a fault in this job. Because
    `unresolvedStatsProblems` reports everything unresolved rather than what this
    run touched, a run that fetched nothing, failed at nothing and skipped
    nothing still reported `FAILING` while one game anywhere was outstanding:
    exactly the permanently-true health signal this note argues against, and the
    one `pnpm cron:status` reads first.

    Nothing is lost. Every count is in the response body below,
    `games.stats_error` still holds the text per game, and `/ops/stats` renders
    each of them with the severity that belongs to it — which is what #233 was
    filed to make possible. What is still missing is a channel for "the provider
    owes us a box score" that is neither a job failure nor silence; that needs a
    severity axis `cronJobState` does not have.
  */
  const problem =
    [
      brokenSeasons > 0 ? `${brokenSeasons} of ${seasons.length} seasons failed` : null,
      gameFailures > 0 ? `${gameFailures} game(s) failed to ingest` : null,
      /*
        **A slate was being played and the work list selected nothing.**

        This is issue #256 itself, expressed as a health check. The work list
        used to gate on `games.status`, which one daily cron wrote at an hour no
        NFL game has ever been in progress — so on a Sunday it matched nothing,
        no game *failed*, and `problem` was therefore null. `pnpm cron:status`
        read green through sixteen hours of a pipeline that was not running, and
        that is the reason the defect survived long enough to be found by reading
        rather than by an alarm.

        Not `games === 0` on its own, which is the normal Tuesday and would
        leave the heartbeat permanently red between slates. And not a second copy
        of the live predicate either: `gamesUnderWay` runs the same SQL fragment
        the work list runs, because an alarm that asks a different question than
        the selection it guards can fall silent for a reason the selection does
        not have.

        Self-limiting by construction — it can only be true while a game is
        actually being played, so it cannot become the permanently-true signal
        this file's own note above warns about.
      */
      starvedSeasons > 0
        ? `${starvedSeasons} season(s) had games under way and read none`
        : null,
    ]
      .filter((part) => part !== null)
      .join("; ") || null;

  await recordCronRun(client, "stats", problem);

  return NextResponse.json({
    at: now.toISOString(),
    seasons: seasons.length,
    // Surfaced here rather than in `last_outcome`, which is a state and not a
    // message. See the note above the `problem` string.
    gameWarnings,
    runs,
    outstanding,
  });
}
