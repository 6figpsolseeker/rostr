import { NextResponse } from "next/server";
import { NFL } from "@rostr/core";
import {
  advancePlayoffs,
  enterPlayoffs,
  PlayoffError,
  resolveLeagueWeek,
  resolveLeagueWeeksThrough,
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
      if (!(error instanceof PlayoffError)) throw error;
    }

    try {
      // A single explicit week is targeted directly; otherwise sweep every
      // still-unfinalised week up to the current one, so a paying week (168h
      // window) finalises even after the pointer has moved past it to the
      // playoffs. The current week's outcome is what the status line reports.
      const outcomes = Number.isFinite(requestedWeek)
        ? [await resolveLeagueWeek(client, league.id, week, now)]
        : await resolveLeagueWeeksThrough(client, league.id, week, now);
      const outcome = outcomes.find((o) => o.week === week) ?? outcomes.at(-1);
      scored.push({
        leagueId: league.id,
        name: league.name,
        matchups: outcome?.matchups ?? 0,
        finalized: outcome?.finalized ?? true,
        ...(outcome?.holdReason ? { holdReason: outcome.holdReason } : {}),
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
