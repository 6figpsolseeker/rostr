import { NextResponse } from "next/server";
import { NFL } from "@rostr/core";
import {
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
    ranked?: number;
    projections?: number;
    error?: string;
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
      let games = 0;
      for (let week = 1; week <= NFL.seasonWeeks; week++) {
        const result = await syncGames(client, provider, NFL.key, season, week);
        games += result.inserted + result.updated;
      }

      const rankings = await syncRankings(client, provider, NFL.key, season);
      const projections = await syncProjections(client, provider, NFL.key, season);

      runs.push({
        season,
        players: players.inserted + players.updated,
        byeWeeks,
        games,
        ranked: rankings.inserted,
        projections: projections.inserted,
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

  const failed = runs.filter((entry) => entry.error).length;
  await recordCronRun(
    client,
    "season-sync",
    failed > 0 ? `${failed} of ${seasons.length} seasons failed` : null,
  );

  return NextResponse.json({ at: now.toISOString(), seasons: seasons.length, runs });
}
