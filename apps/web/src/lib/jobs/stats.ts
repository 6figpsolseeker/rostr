import { NextResponse } from "next/server";
import { NFL } from "@rostr/core";
import { recordCronRun, seasonsInPlay, syncBoxScores } from "@rostr/db";
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
    inserted?: number;
    revised?: number;
    retracted?: number;
    /** Named rather than counted — a bare count once hid "every kicker". */
    unmatched?: readonly string[];
    failures?: readonly { gameRef: string; reason: string }[];
    error?: string;
  }[] = [];

  for (const season of seasons) {
    try {
      const outcome = await syncBoxScores(client, provider, NFL.key, season);
      runs.push({
        season,
        games: outcome.games,
        inserted: outcome.inserted,
        revised: outcome.revised,
        retracted: outcome.retracted,
        unmatched: outcome.unmatched,
        failures: outcome.failures,
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

  const problem =
    brokenSeasons > 0
      ? `${brokenSeasons} of ${seasons.length} seasons failed`
      : gameFailures > 0
        ? `${gameFailures} game(s) failed to ingest`
        : null;

  await recordCronRun(client, "stats", problem);

  return NextResponse.json({ at: now.toISOString(), seasons: seasons.length, runs });
}
