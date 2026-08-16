import { NextResponse } from "next/server";
import { recordCronRun } from "@rostr/db";
import { Tank01Provider } from "@rostr/stats";
import { db } from "@/lib/db";
import { cronForbidden } from "@/lib/cron";
import { runSeasonSyncJob } from "@/lib/jobs/season-sync";

/**
 * Reference data — the schedule, the player pool, byes, rankings, projections.
 *
 * All of it existed and all of it ran only when somebody typed `pnpm db:sync`.
 * That is fine for a seed and wrong for a season: the NFL schedule moves
 * (flexed Sunday-night games), players are signed and cut every week, and the
 * autolineup ranks on projections, so a stale pool is a lineup decision made
 * from last month's facts. Nobody is going to remember to run a command daily
 * from September to January.
 *
 * Daily rather than the stats job's ten minutes, because it is a different job
 * with a different clock: `syncGames` is per week, so one run is eighteen
 * provider calls a season before the other four syncs. The work itself is
 * `runSeasonSyncJob` — a `route.ts` may not export anything but handlers.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const forbidden = cronForbidden(request);
  if (forbidden) return forbidden;

  const client = db();
  const now = new Date();

  const apiKey = process.env["TANK01_API_KEY"];
  if (!apiKey) {
    await recordCronRun(client, "season-sync", "TANK01_API_KEY is not set");
    return NextResponse.json(
      {
        error:
          "TANK01_API_KEY is not set, so no reference data can be read. See " +
          "docs/SETUP-REQUIRED.md.",
      },
      { status: 503 },
    );
  }

  try {
    return await runSeasonSyncJob(client, new Tank01Provider({ apiKey }), now);
  } catch (error) {
    await recordCronRun(
      client,
      "season-sync",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
