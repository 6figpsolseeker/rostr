import { NextResponse } from "next/server";
import { recordCronRun } from "@rostr/db";
import { Tank01Provider } from "@rostr/stats";
import { db } from "@/lib/db";
import { cronForbidden } from "@/lib/cron";
import { runStatsJob } from "@/lib/jobs/stats";

/**
 * Box scores into `stat_lines`. **This is the Sep 9 blocker.**
 *
 * `syncBoxScores` was written, exported and tested, and nothing called it. So
 * `stat_lines` was empty on any real deployment, every player scored zero, and
 * every week finalised 0–0 — permanently, because a finalised week is never
 * rescored. `docs/LIVE-SCORING.md` describes this job in the present tense and
 * it did not exist. This route is the caller.
 *
 * The work itself is `runStatsJob`, because a `route.ts` may not export anything
 * but handlers and segment config. See that file.
 *
 * ## Ten minutes, and why that is the whole cadence
 *
 * `RULES.md` settles per-game updates rather than real time, and the ten-minute
 * tick is `score-week`'s already. This runs on the same one deliberately: stats
 * are written here and read there, so a slower stats job means `score-week`
 * scoring a snapshot it could have had, and a faster one means work nothing
 * consumes. `score-week` is offset by five minutes so it reads this run rather
 * than the previous one.
 *
 * The bounds that make a ten-minute cadence affordable are all in
 * `syncBoxScores` and were sized for it — `LIVE_WINDOW_HOURS` stops a game whose
 * status never advances being re-read for the rest of the season,
 * `MAX_GAMES_PER_RUN` caps the spend of one run, and the query's `ORDER BY`
 * puts games with no box score first, then live ones, then the newest — so a
 * backlog of older failures cannot starve the current slate. (It ordered
 * oldest-first until the #140 re-audit, at which point #227's promotion of
 * failed games to the front tier had turned that into the starvation this
 * sentence claimed to prevent.)
 */
export async function GET(request: Request): Promise<NextResponse> {
  const forbidden = cronForbidden(request);
  if (forbidden) return forbidden;

  const client = db();
  const now = new Date();

  const apiKey = process.env["TANK01_API_KEY"];
  if (!apiKey) {
    // Refused rather than reported as an empty success. Without a key there is
    // no way to read a box score, so "ran, ingested nothing" is exactly the
    // healthy face that a missing credential must not be allowed to wear — and
    // the heartbeat is the only thing anyone will look at.
    await recordCronRun(client, "stats", "TANK01_API_KEY is not set");
    return NextResponse.json(
      {
        error:
          "TANK01_API_KEY is not set, so no box score can be read. Every player " +
          "scores zero until it is. See docs/SETUP-REQUIRED.md.",
      },
      { status: 503 },
    );
  }

  try {
    return await runStatsJob(client, new Tank01Provider({ apiKey }), now);
  } catch (error) {
    await recordCronRun(
      client,
      "stats",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
