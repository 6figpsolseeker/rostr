import { NextResponse } from "next/server";
import { BracketError, NFL } from "@rostr/core";
import {
  advancePlayoffs,
  enterPlayoffs,
  PlayoffError,
  resolveLeagueWeek,
  WeekError,
} from "@rostr/db";
import { db } from "@/lib/db";

/**
 * Score every active league's current week.
 *
 * Safe to run often — that is how live scores stay current. Each run rewrites
 * points from the latest stat revisions and finalises only once the week's games
 * are all final *and* the correction window has elapsed. A finalised week is
 * skipped, not rescored.
 *
 * Hourly is plenty on a normal day; during Sunday games something closer to
 * every ten minutes makes the numbers feel live. `apps/web/vercel.json`
 * schedules it.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret) {
    const provided =
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      new URL(request.url).searchParams.get("secret");

    if (provided !== secret) {
      return NextResponse.json({ error: "Not authorised" }, { status: 401 });
    }
  }

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
    matchups?: number;
    finalized?: boolean;
    holdReason?: string;
    bracketGames?: number;
    skipped?: string;
  }[] = [];

  for (const league of leagues) {
    let bracketGames = 0;

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
      // A league still mid-season refuses (PlayoffError), and a bracket that
      // cannot be built for this league (BracketError) is this league's problem.
      // Neither may abort the shared run and stop every other league scoring.
      if (!(error instanceof PlayoffError) && !(error instanceof BracketError)) throw error;
    }

    try {
      const outcome = await resolveLeagueWeek(client, league.id, week, now);
      scored.push({
        leagueId: league.id,
        name: league.name,
        matchups: outcome.matchups,
        finalized: outcome.finalized,
        ...(outcome.holdReason ? { holdReason: outcome.holdReason } : {}),
        ...(bracketGames > 0 ? { bracketGames } : {}),
      });
    } catch (error) {
      // A league with no schedule yet, or one already final, is not a failure —
      // and one broken league must not stop the rest from scoring.
      scored.push({
        leagueId: league.id,
        name: league.name,
        ...(bracketGames > 0 ? { bracketGames } : {}),
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
