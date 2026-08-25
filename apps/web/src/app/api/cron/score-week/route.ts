import { NextResponse } from "next/server";
import { BracketError, NFL } from "@rostr/core";
import {
  currentWeek,
  advancePlayoffs,
  enterPlayoffs,
  PlayoffError,
  resolveLeagueWeek,
  recordCronRun,
  resolveLeagueWeeksThrough,
  WeekError,
} from "@rostr/db";
import type { SqlClient } from "@rostr/db";
import { db } from "@/lib/db";
import { cronForbidden } from "@/lib/cron";

/**
 * Score every active league's current week.
 *
 * Safe to run often — that is how live scores stay current. Each run rewrites
 * points from the latest stat revisions and finalises once the correction window
 * has elapsed, which inside that window also requires every game to be final. A
 * finalised week is skipped, not rescored.
 *
 * Past the window a week finalises whether or not every game reached `FINAL` —
 * `docs/RULES.md` §10, the postponed game — and says so in
 * `finalizedWithUnfinishedGames`. That field is the only signal that a week
 * settled on the fallback rather than on complete data, so surface it rather
 * than collapsing it into `finalized: true`.
 *
 * Hourly is plenty on a normal day; during Sunday games something closer to
 * every ten minutes makes the numbers feel live. `apps/web/vercel.json`
 * schedules it.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const forbidden = cronForbidden(request);
  if (forbidden) return forbidden;

  const client = db();
  const now = new Date();

  try {
    return await run(client, now, request);
  } catch (error) {
    // Stamped and rethrown, so the response is exactly what it was before. A
    // route that throws on every invocation is worse than one that never fires,
    // and without this both read as a stale row.
    await recordCronRun(
      client,
      "score-week",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

async function run(client: SqlClient, now: Date, request: Request): Promise<NextResponse> {
  const requestedWeek = Number.parseInt(
    new URL(request.url).searchParams.get("week") ?? "",
    10,
  );

  /*
    **Each league is scored against its own season, one week per league.**

    Issue #105 gave this route a season filter and a season to put in it, and
    the season it chose was `max(season)` over every active league — one scalar,
    applied to every league in the loop. That is a worse defect than the
    cross-season read it removed, and it is reachable without an attacker.

    `seasonYear` comes off the request body and is range-checked nowhere; a
    league reaches IN_SEASON on its final draft pick, months before its season
    kicks off; and nothing in this repo ever writes SETTLED, so an active league
    never stops being active. So one league created for a later season makes
    `max(season)` name a season with no kicked-off games, the week comes back 0,
    and the whole job returns `{week: null, leagues: []}` — before the loop, for
    everybody, every ten minutes — while recording a **healthy** run, because a
    run over no weeks legitimately is one. That is the confident green this file
    already has a paragraph about.

    In January 2027 it needs no stray league at all: any 2027 league drafted
    while the 2026 championship is inside its 168-hour window starves that
    settlement permanently, since `max(season)` never comes back down.

    It also made the two copies of "the current week" disagree for the first
    time. They used to be byte-identical and wrong together; the fix gave the
    scoreboard the league's own frozen season and gave this one a global max, so
    a 2026 league's scoreboard would read week 17 while this wrote week 2 of
    2027 into it.

    Per league closes all three, and deletes the duplicated SQL that #105
    declined to deduplicate: there is now one `currentWeek`, called with the
    league's own season, and the cron and the scoreboard cannot disagree because
    they are the same function on the same argument.
  */
  const leagues = await client.query<{ id: string; name: string; season: number }>(
    "SELECT id, name, season FROM leagues WHERE state IN ('IN_SEASON', 'PLAYOFFS')",
  );

  const scored: {
    leagueId: string;
    name: string;
    weeks?: {
      week: number;
      matchups: number;
      finalized: boolean;
      holdReason?: string;
      finalizedWithUnfinishedGames?: string;
    }[];
    failedWeeks?: readonly { readonly week: number; readonly reason: string }[];
    deferredWeeks?: readonly number[];
    bracketGames?: number;
    bracketProblem?: string;
    skipped?: string;
    awaitingKickoff?: boolean;
  }[] = [];

  let anyWeek = false;

  for (const league of leagues) {
    let bracketGames = 0;
    let bracketProblem: string | null = null;

    /*
      The lagging answer, for this league's season.

      `currentWeek` rather than `transactionWeek`: this wants the week of the
      most recent kickoff and keeps answering it until the next week's first
      game, which is exactly the window in which a week is scored and finalised.

      A league whose season has not kicked off yet has no week and is skipped —
      it is not a failure, and it must not decide anything for the leagues that
      do have one. That was the whole bug.
    */
    const week = Number.isFinite(requestedWeek)
      ? requestedWeek
      : ((await currentWeek(client, NFL.key, league.season, now)) ?? 0);

    if (!week) {
      /*
        Reported, and deliberately **not** as `skipped`.

        `skipped` is what the failure count below reads, and a league whose
        season has not kicked off yet is not a failure — it is every league,
        every ten minutes, from now until September. Filing it there would trade
        the old silent no-op for a permanent red, which is the same false alarm
        wearing the other label; `cronJobState` reads any non-null outcome as
        FAILING before it looks at staleness.
      */
      scored.push({ leagueId: league.id, name: league.name, awaitingKickoff: true });
      continue;
    }
    anyWeek = true;

    // Bracket fixtures are laid *before* scoring, not after. Week 15 has no
    // matchups until the regular season finalises and `advancePlayoffs` writes
    // them, and `resolveLeagueWeek` refuses a week with no schedule — so doing
    // this second would cost a whole cycle every time a round turns over.
    //
    // A league still mid-season refuses, which is not a failure and is why this
    // does not take the scoring below it down with it.
    try {
      await enterPlayoffs(client, league.id);
      bracketGames = (await advancePlayoffs(client, league.id)).written;
    } catch (error) {
      // **One league's failure may never stop the others scoring.**
      //
      // This was an allowlist — rethrow anything that is not a `PlayoffError` —
      // and it was the only one in the repo. `BracketError` extends `Error`
      // directly rather than `PlayoffError`, so an undersized field escaped the
      // per-league catch and aborted the entire run: every league after it in a
      // query with no `ORDER BY` went unscored, deterministically, every ten
      // minutes. Adding `BracketError` to the list would fix that one class and
      // leave `StandingsError` (reachable from the same `seedOrder` call) and
      // every future class exactly as exposed, because none of these share a
      // base class for an `instanceof` to catch.
      //
      // So it records and continues, like `waivers`, `trades`, `draft-tick`, and
      // the scoring catch immediately below. An allowlist here fails open on the
      // one thing it is protecting.
      //
      // **Nothing is swallowed.** The failure is reported, because the cost of
      // silence is a league whose bracket can never be built looking healthy
      // forever — and `INVARIANT` says the fault is ours, not the league's.
      bracketProblem =
        error instanceof BracketError
          ? `${error.code}: ${error.message}`
          : error instanceof PlayoffError
            ? error.code
            : `UNEXPECTED: ${error instanceof Error ? error.message : String(error)}`;
    }

    try {
      // A single explicit week is targeted directly; otherwise sweep every
      // not-yet-finalised week up to the current one, so a paying week (168h
      // window) finalises even after the pointer has moved past it — week 14 is
      // abandoned four days early by week 15's Thursday game, and week 17, the
      // championship week, once week-18 games are ingested.
      const sweep = Number.isFinite(requestedWeek)
        ? {
            outcomes: [await resolveLeagueWeek(client, league.id, week, now)],
            failures: [],
            deferred: [],
          }
        : await resolveLeagueWeeksThrough(client, league.id, week, now);

      // **Every week reports itself.** Collapsing a sweep to one row meant
      // publishing an older week's matchup count and hold reason under the
      // current week's number, and — worse — asserting `finalized: true` for a
      // week that was never examined, which is the reading an operator would
      // take as "nothing left to do".
      scored.push({
        leagueId: league.id,
        name: league.name,
        weeks: sweep.outcomes.map((o) => ({
          week: o.week,
          matchups: o.matchups,
          finalized: o.finalized,
          ...(o.holdReason ? { holdReason: o.holdReason } : {}),
          ...(o.finalizedWithUnfinishedGames
            ? { finalizedWithUnfinishedGames: o.finalizedWithUnfinishedGames }
            : {}),
          ...(o.matchupsAlreadyFinal ? { matchupsAlreadyFinal: o.matchupsAlreadyFinal } : {}),
        })),
        ...(sweep.failures.length > 0 ? { failedWeeks: sweep.failures } : {}),
        ...(sweep.deferred.length > 0 ? { deferredWeeks: sweep.deferred } : {}),
        ...(bracketGames > 0 ? { bracketGames } : {}),
        ...(bracketProblem ? { bracketProblem } : {}),
      });
    } catch (error) {
      // A league with no schedule yet, or one already final, is not a failure —
      // and one broken league must not stop the rest from scoring.
      scored.push({
        leagueId: league.id,
        name: league.name,
        ...(bracketGames > 0 ? { bracketGames } : {}),
        ...(bracketProblem ? { bracketProblem } : {}),
        skipped:
          error instanceof WeekError
            ? error.code
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }

  // The outcome, not merely the fact of running. A league is counted as failed
  // if it was skipped entirely, if any week in its sweep failed, or if its
  // bracket could not be built — all three are already in the JSON, and a row
  // saying "ran, all fine" over them would be the healthy face this record
  // exists to remove.
  const failed = scored.filter(
    (entry) => entry.skipped || entry.failedWeeks?.length || entry.bracketProblem,
  ).length;

  /*
    A week that settled on the fallback is recorded here too, and it was not.

    `finalizedWithUnfinishedGames` reached the JSON response body and stopped
    there. Vercel does not keep cron response bodies, so the one durable record
    of a run — the row `pnpm cron:status` reads — said nothing, and a run in
    which a paying week permanently scored twelve teams zero on box scores we
    never fetched was indistinguishable from a quiet Tuesday. Green.

    It is deliberately **not** folded into `failed`. That count means "this
    league did not get scored", which is a different and recoverable thing; a
    fallback settlement is the opposite — the league was scored, once, for good.
    Counting them together would let a retry-shaped response be applied to
    something no retry can reach.
  */
  const onFallback = scored.filter((entry) =>
    entry.weeks?.some((week) => week.finalizedWithUnfinishedGames),
  ).length;

  const notes = [
    ...(failed > 0 ? [`${failed} of ${scored.length} leagues had a problem`] : []),
    ...(onFallback > 0
      ? [
          `${onFallback} of ${scored.length} leagues permanently settled a week on the ` +
            `clock rather than on complete data — see finalizedWithUnfinishedGames`,
        ]
      : []),
  ];

  await recordCronRun(client, "score-week", notes.length > 0 ? notes.join("; ") : null);

  /*
    No top-level `week` any more: there is one per league, and publishing a
    single number for a run that may span two seasons is how this went wrong.
    `anyWeek` keeps the one fact the old field was actually read for — whether
    this run had anything to score at all.
  */
  return NextResponse.json({ at: now.toISOString(), scoring: anyWeek, leagues: scored });
}
