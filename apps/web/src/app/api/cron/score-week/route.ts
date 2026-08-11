import { NextResponse } from "next/server";
import { BracketError, NFL } from "@rostr/core";
import {
  advancePlayoffs,
  enterPlayoffs,
  PlayoffError,
  resolveLeagueWeek,
  resolveLeagueWeeksThrough,
  WeekError,
} from "@rostr/db";
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

  const requestedWeek = Number.parseInt(
    new URL(request.url).searchParams.get("week") ?? "",
    10,
  );

  // The current NFL week, from the schedule rather than a calendar guess: the
  // week whose games have started and are not yet a week old.
  const [current] = await client.query<{ week: number }>(
    `SELECT g.week
       FROM games g
       JOIN sports s ON s.id = g.sport_id
      WHERE s.key = $1 AND g.kickoff_at <= $2
      ORDER BY g.kickoff_at DESC
      LIMIT 1`,
    [NFL.key, now.toISOString()],
  );

  const week = Number.isFinite(requestedWeek) ? requestedWeek : Number(current?.week ?? 0);
  if (!week) {
    return NextResponse.json({ at: now.toISOString(), week: null, leagues: [] });
  }

  // The enum is FORMING / DRAFTING / IN_SEASON / PLAYOFFS / SETTLED / DISSOLVED.
  // An invented value here is not a no-op — Postgres fails to cast it and the
  // whole job errors.
  const leagues = await client.query<{ id: string; name: string }>(
    "SELECT id, name FROM leagues WHERE state IN ('IN_SEASON', 'PLAYOFFS')",
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
  }[] = [];

  for (const league of leagues) {
    let bracketGames = 0;
    let bracketProblem: string | null = null;

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

  return NextResponse.json({ at: now.toISOString(), week, leagues: scored });
}
