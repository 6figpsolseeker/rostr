import { NextResponse } from "next/server";
import { NFL } from "@rostr/core";
import {
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
      const outcome = await syncBoxScores(client, provider, NFL.key, season);
      runs.push({
        season,
        games: outcome.games,
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

  // Everything unresolved, not only what this run happened to touch. A run that
  // fetched nothing is the normal case on a Tuesday and would otherwise report
  // itself clean over a game that has been failing since Sunday.
  const outstanding = await unresolvedStatsProblems(client, NFL.key);

  // **Every reason, joined — not the first one.** This was a chain of ternaries,
  // so a run with a broken season announced only that and said nothing about the
  // twelve games that also failed. A heartbeat is read once and acted on once.
  const problem =
    [
      brokenSeasons > 0 ? `${brokenSeasons} of ${seasons.length} seasons failed` : null,
      gameFailures > 0 ? `${gameFailures} game(s) failed to ingest` : null,
      gameWarnings > 0 ? `${gameWarnings} warning(s) from games that did ingest` : null,
      // Only when this run raised none of its own, or the two counts read as
      // separate incidents when the second is a superset of the first.
      gameWarnings === 0 && gameFailures === 0 && outstanding.total > 0
        ? `${outstanding.total} game(s) still carry an unresolved problem`
        : null,
    ]
      .filter((part) => part !== null)
      .join("; ") || null;

  await recordCronRun(client, "stats", problem);

  return NextResponse.json({
    at: now.toISOString(),
    seasons: seasons.length,
    runs,
    outstanding,
  });
}
