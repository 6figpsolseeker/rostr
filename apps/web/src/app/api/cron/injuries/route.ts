import { NextResponse } from "next/server";
import { NFL } from "@rostr/core";
import { recordCronRun, syncInjuries } from "@rostr/db";
import { Tank01Provider } from "@rostr/stats";
import { db } from "@/lib/db";
import { cronForbidden } from "@/lib/cron";

/**
 * Injury designations, hourly.
 *
 * `docs/LIVE-SCORING.md` lists this job in a table of six and marks it **❌ does
 * not exist**, then argues at length that it is the timely feed that matters
 * most: it changes what a manager *does* — whether to bench a questionable
 * starter — where a live score only changes what they watch.
 *
 * Designations reached the database only through `season-sync`, which runs once
 * a day at 09:20 UTC. So a player ruled out on a Sunday morning would surface
 * the following morning: after his game, after the lock, after the week scored.
 *
 * ## Hourly, and not faster
 *
 * Tank01 refreshes rosters **hourly** and this reads the roster endpoint, so a
 * ten-minute cadence would spend ten calls to learn what one call already knew.
 * The provider's refresh rate is the binding constraint, not ours — the same
 * point `LIVE-SCORING.md` makes about gameday inactives, where hourly is
 * genuinely not good enough and a different endpoint is needed.
 *
 * **This job is not that one.** It does not solve inactives. The T-90 inactive
 * list is a separate feed with two properties nobody has been able to verify —
 * what a populated entry contains, and when it fills — and both are answerable
 * only on a real gameday. Do not let this job's existence read as that problem
 * being closed.
 *
 * One provider call per run, whole-league.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const forbidden = cronForbidden(request);
  if (forbidden) return forbidden;

  const client = db();

  const apiKey = process.env["TANK01_API_KEY"];
  if (!apiKey) {
    // Refused rather than reported as an empty success, exactly as the stats
    // job refuses. "Ran, changed nothing" is the healthy face a missing
    // credential must not be allowed to wear, and the heartbeat is the only
    // thing anybody looks at.
    await recordCronRun(client, "injuries", "TANK01_API_KEY is not set");
    return NextResponse.json(
      {
        error:
          "TANK01_API_KEY is not set, so injury designations cannot refresh. " +
          "See docs/SETUP-REQUIRED.md.",
      },
      { status: 503 },
    );
  }

  try {
    const result = await syncInjuries(client, new Tank01Provider({ apiKey }), NFL.key);

    /*
      Only an **empty provider list** is reported, never a quiet run.

      Any non-null `last_outcome` makes `cron:status` read FAILING, so an
      hourly job that reported "nothing changed" would show red for most of the
      offseason and all of a quiet Tuesday. That is the crying-wolf failure this
      repo already warns about for the cluster banner: a warning people learn to
      dismiss is worse than no warning, because it takes the real one with it.

      An empty list is a different fact and genuinely alarming.
      `syncInjuries` refuses to apply one — clearing every designation at once
      would empty every injured reserve in every league — so nothing is damaged,
      and the heartbeat is the only place that refusal is visible.
    */
    await recordCronRun(
      client,
      "injuries",
      result.providerReturned === 0
        ? "the provider returned no injuries at all — refused rather than clearing every designation"
        : null,
    );

    return NextResponse.json({ ...result });
  } catch (error) {
    await recordCronRun(
      client,
      "injuries",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
