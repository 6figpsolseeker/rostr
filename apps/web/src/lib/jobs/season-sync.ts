import { NextResponse } from "next/server";
import { NFL } from "@rostr/core";
import {
  currentWeek,
  recordCronRun,
  seasonsInPlay,
  syncByeWeeks,
  syncGames,
  syncPlayers,
  syncProjections,
  syncRankings,
} from "@rostr/db";
import type {
  AdpCapableProvider,
  ByeCapableProvider,
  ProjectionCapableProvider,
  SqlClient,
} from "@rostr/db";

/**
 * The body of `/api/cron/season-sync`. See `jobs/stats.ts` for why it is not in
 * the route file.
 *
 * ## The same set as `pnpm db:sync`, on purpose
 *
 * It is tempting to have the cron do a narrower job than the operator command —
 * only the schedule, say. That is how the two drift, and then "run the sync"
 * means one thing to a person and another to the scheduler. The one difference
 * is the draft-board printout, which is output rather than work.
 *
 * ## Order matters
 *
 * Players first: `syncGames`, `syncRankings` and `syncProjections` all match on
 * a player that has to already exist, and a rookie signed this week is unmatched
 * until `syncPlayers` has seen him. Running the pool last would leave every
 * dependent sync one day behind it, permanently.
 *
 * ## The provider type
 *
 * The intersection of the three capability interfaces, spelled out rather than
 * taken as `Tank01Provider`. `syncPlayers` and `syncGames` want a
 * `StatsProvider`, rankings want ADP, projections and byes want their own — and
 * the point of those narrow interfaces is that the sync logic never learns which
 * provider is behind it, which is what keeps swapping providers a one-file
 * change. Naming the concrete class here would put that back.
 */
/**
 * "1-18" rather than "1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18".
 *
 * Whole-season outages are the common case for the schedule sync, and a reader
 * seeing a contiguous range knows immediately that this is the provider being
 * down rather than particular fixtures being unreadable. Assumes ascending
 * input, which the loop that builds it guarantees.
 */
function collapse(weeks: readonly number[]): string {
  const parts: string[] = [];
  let start = weeks[0];
  let previous = weeks[0];
  if (start === undefined || previous === undefined) return "";
  for (const week of weeks.slice(1)) {
    if (week === previous + 1) {
      previous = week;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = week;
    previous = week;
  }
  parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  return parts.join(", ");
}

/**
 * Cap a recorded outcome, keeping the front.
 *
 * The useful half of a provider error is its first sentence; the rest is a
 * stack or a body echo. An ellipsis rather than a hard cut, so a reader can
 * tell truncation from a message that simply ended.
 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export async function runSeasonSyncJob(
  client: SqlClient,
  provider: AdpCapableProvider & ByeCapableProvider & ProjectionCapableProvider,
  now: Date,
): Promise<NextResponse> {
  const seasons = await seasonsInPlay(client, NFL.key);

  const runs: {
    season: number;
    players?: number;
    byeWeeks?: number;
    games?: number;
    /** Fixtures the provider has not given a kickoff time. See the loop below. */
    undatedGames?: number;
    ranked?: number;
    /** Season-aggregate projection rows, for the draft board. */
    projections?: number;
    /** Weekly projection rows, which the autofill ranks on. */
    weeklyProjections?: number;
    /**
     * Which weeks those were pulled for.
     *
     * Named rather than counted, because "42 rows" cannot tell an operator that
     * the job has been writing week 0 and nothing else — which is what it did
     * from the day it shipped until issue #287.
     */
    projectionWeeks?: readonly number[];
    error?: string;
    /**
     * Weeks whose schedule sync threw, named rather than counted.
     *
     * A season is not "failed" because one week's fixtures could not be read —
     * the other seventeen are still ingested, and this job is idempotent, so
     * tomorrow completes what today did not. It is still worth saying which.
     */
    weekFailures?: readonly { week: number; reason: string }[];
  }[] = [];

  for (const season of seasons) {
    try {
      const players = await syncPlayers(client, provider, NFL.key, season);
      const byeWeeks = await syncByeWeeks(
        client,
        NFL.key,
        season,
        await provider.listByeWeeks(season),
      );

      // Every week each run, not just the weeks ahead. A flexed Sunday-night
      // game moves within an already-ingested week, and re-reading a past week
      // is an idempotent upsert costing one call.
      //
      // `NFL.seasonWeeks`, not a local 18. The sport registry is where a fact
      // about football belongs, and a copy here would be a second answer to a
      // question that already has one.
      // `skipped` is reported rather than discarded, and that is the whole of
      // how an undated fixture becomes visible to an operator.
      //
      // `syncGames` drops a game the provider has not given a kickoff time,
      // deliberately — storing a zero would lock lineups at the epoch. The count
      // used to be thrown away here, so the only symptom of a missing fixture
      // was a team quietly absent from a week, and the only way to find it was
      // to query the database by hand. The NFL dates its late-December games
      // last, which puts those weeks squarely on the championship.
      //
      // A steady small number late in the season is normal and resolves itself
      // as the fixtures are announced. A number that grows, or one in an early
      // week, is a broken ingest.
      let games = 0;
      let undated = 0;
      /*
        **Each week guarded on its own**, so a provider fault in week 3 does not
        cost weeks 4 through 18 their sync.

        The eighteen calls used to sit inside the per-season try alone, so one
        throw anywhere in the loop abandoned every later week — and the loop runs
        in ascending order, which puts the live week at the end. A transient
        failure on a week nobody is playing took out the one that mattered.

        It matters differently since issue #256. This job is no longer the
        primary writer of `games.status` — the ten-minute box-score read is — so
        this is the **backstop**, the thing that catches a game which never
        produced a readable box score at all. A backstop that loses fifteen weeks
        to one bad call is not one.

        Named, never counted. `runSeasonSyncJob` has already been through this
        once: `1 of 1 seasons failed` was recorded with no indication of what
        failed, and the cause of that run is unrecoverable because nothing wrote
        it down.
      */
      const weekFailures: { week: number; reason: string }[] = [];
      for (let week = 1; week <= NFL.seasonWeeks; week++) {
        try {
          const result = await syncGames(client, provider, NFL.key, season, week);
          games += result.inserted + result.updated;
          undated += result.skipped;
        } catch (error) {
          weekFailures.push({
            week,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const rankings = await syncRankings(client, provider, NFL.key, season);
      const projections = await syncProjections(client, provider, NFL.key, season);

      /*
        And the week itself, which nothing ever asked for.

        `syncProjections` defaults its week to the season aggregate, and the call
        above takes that default — so week 0 was the only row this system ever
        wrote. `loadProjectedPoints` asks for the real week, so it came back
        empty every week of every season, and a league whose signed rules say
        `WEEKLY_PROJECTION` silently ranked on season averages instead. Issue
        #287. The asymmetry was visible three lines up: `syncGames` loops the
        weeks, this did not.

        Two weeks, not eighteen. A projection for week 12 published in August is
        not a projection, and eighteen provider calls a day for seventeen answers
        nobody reads is the kind of cost `listSeasonProjections` exists to avoid.
        The current week is what the autofill is ranking on now; the next one is so
        that a week has projections before its own Thursday rather than after it.

        Failures here are collected like the per-week game failures above rather
        than thrown: a provider that has not published week N+1 yet is the
        ordinary case in the hours after a week ends, not a fault.
      */
      const projectionWeeks: number[] = [];
      const playing = await currentWeek(client, NFL.key, season, now);
      for (const week of [playing ?? 1, (playing ?? 0) + 1]) {
        if (week >= 1 && week <= NFL.seasonWeeks && !projectionWeeks.includes(week)) {
          projectionWeeks.push(week);
        }
      }

      let weeklyProjections = 0;
      for (const week of projectionWeeks) {
        try {
          const result = await syncProjections(client, provider, NFL.key, season, week);
          weeklyProjections += result.inserted + result.updated;
        } catch (error) {
          weekFailures.push({
            week,
            reason: `projections: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      runs.push({
        season,
        players: players.inserted + players.updated,
        byeWeeks,
        games,
        undatedGames: undated,
        weekFailures,
        ranked: rankings.inserted,
        projections: projections.inserted,
        weeklyProjections,
        projectionWeeks,
      });
    } catch (error) {
      // One season's failure must not stop another's, and a partial season is
      // left as it is rather than rolled back: every function above is an
      // idempotent upsert, so tomorrow's run completes what today's did not.
      runs.push({
        season,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /*
    Only a failure goes in `last_outcome`, because that field is not a message —
    it is a state. `cronJobState` returns `FAILING` for *any* non-null value,
    ahead of the staleness check, so anything written here is an alarm whatever
    the words say.

    The comment that used to sit here said undated fixtures "are not a failure
    and must not read as one" and then wrote them into this field anyway. It was
    right about the rule and wrong about the code, which is the worse half: from
    2026-08-18 this job reported `FAILING` every day for the four week-16 and
    four week-17 games the NFL deliberately holds back for flex scheduling — a
    permanent, correct condition, raising a daily alarm. #182 exists to *keep*
    those fixtures rather than discard them; reporting their presence as a fault
    undoes the point of keeping them.

    The count still matters before week 16 and is still returned in the response,
    where it informs without alarming. A row that cries wolf every day is a row
    people stop reading, and this is the same table that has to be believed when
    scoring breaks in October.
  */
  const failed = runs.filter((entry) => entry.error).length;
  const undated = runs.reduce((total, entry) => total + (entry.undatedGames ?? 0), 0);

  /*
    The message goes in, not just the count.

    This recorded "1 of 1 seasons failed" and nothing else. The error was caught
    per season, put in `runs[].error` and returned in the JSON — which nobody
    reads, because a cron runs unattended and its response goes to a scheduler.
    So the one durable record of a failure said that one had happened and
    refused to say what it was, and `pnpm cron:status` could only repeat it.

    A job that cannot say why it failed is a job nobody can fix. It cost a
    session an hour of guessing at quotas.

    Truncated, because a provider error can carry a stack and this column is
    read by a status command that prints one line per job. The season is named
    because a multi-season failure otherwise reads as one problem.
  */
  const problems = runs
    .filter((entry) => entry.error)
    .map((entry) => `${entry.season}: ${entry.error}`)
    .join("; ");

  /*
    A week that failed inside an otherwise healthy season.

    Reported, because this job is now the **backstop** for `games.status` rather
    than its primary writer — the ten-minute box-score read is that. A week whose
    fixtures never arrived is a week whose games can never be marked FINAL by
    anything except a box score, and if that box score is also unreadable the
    week holds open with no other signal that anything is wrong.

    It does not count as a failed season: seventeen weeks did sync, and the job
    is idempotent, so tomorrow's run completes it. Overstating it would make the
    heartbeat red for a condition that heals itself, which this file has already
    been fixed for once.
  */
  const weekProblems = runs.flatMap((entry) => entry.weekFailures ?? []);

  /*
    Grouped by reason, because the common shape is *every* week failing for the
    same cause.

    Naming each one individually is right when the reasons differ and useless
    when they do not: eighteen copies of "provider exploded" overflow the 400
    character cap, so the weeks that scroll off are the late ones — 15 through
    18, which are the playoff and championship weeks. The truncation kept the
    least interesting half.

    One line per distinct reason, with the weeks it hit, says strictly more in
    less space. "1-18" is also the shape that tells an operator this is an outage
    rather than a fixture problem, which the flat list buried.
  */
  const byReason = new Map<string, number[]>();
  for (const failure of weekProblems) {
    const weeks = byReason.get(failure.reason);
    if (weeks) weeks.push(failure.week);
    else byReason.set(failure.reason, [failure.week]);
  }
  const weekSummary = [...byReason]
    .map(([reason, weeks]) => `weeks ${collapse(weeks)}: ${reason}`)
    .join("; ");

  const outcome =
    [
      failed > 0 ? `${failed} of ${seasons.length} seasons failed — ${problems}` : null,
      weekProblems.length > 0 ? `${weekProblems.length} week(s) failed — ${weekSummary}` : null,
    ]
      .filter((part) => part !== null)
      .join("; ") || null;

  await recordCronRun(
    client,
    "season-sync",
    // Truncated only when there is something to truncate — `null` is the healthy
    // value and must stay null, not become an empty string, which `cronJobState`
    // would read as FAILING.
    outcome === null ? null : truncate(outcome, 400),
  );

  return NextResponse.json({
    at: now.toISOString(),
    seasons: seasons.length,
    undatedGames: undated,
    runs,
  });
}
