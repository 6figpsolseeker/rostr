import { NextResponse } from "next/server";
import { leaguesDueForWaivers, processWaivers, WaiverError } from "@rostr/db";
import { db } from "@/lib/db";
import { cronForbidden } from "@/lib/cron";

/**
 * Run every league's waivers that are due.
 *
 * The Wednesday 03:00 ET run, from each league's own frozen rules — so a league
 * is processed on its own schedule rather than whenever this job happens to
 * fire. `leaguesDueForWaivers` decides who is due; this only carries it out.
 *
 * Hourly is enough. Running more often is harmless — a league with no due claims
 * is skipped, and a processed claim is never processed twice.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const forbidden = cronForbidden(request);
  if (forbidden) return forbidden;

  const client = db();
  const now = new Date();
  const due = await leaguesDueForWaivers(client, now);

  const runs: {
    leagueId: string;
    awarded?: number;
    failed?: number;
    /** Claims whose player has not cleared waivers yet. Left PENDING on purpose. */
    deferred?: number;
    cleared?: number;
    error?: string;
  }[] = [];

  for (const leagueId of due) {
    try {
      const outcome = await processWaivers(client, leagueId, now);
      runs.push({
        leagueId,
        awarded: outcome.awarded,
        failed: outcome.failed,
        // Reported rather than collapsed into a zero-everything run. A league
        // waiting on a player to clear and a league with nothing to do are
        // different states, and only this tells them apart.
        deferred: outcome.deferred,
        cleared: outcome.cleared,
      });
    } catch (error) {
      // One league's bad state must not hold up everyone else's waivers.
      runs.push({
        leagueId,
        error:
          error instanceof WaiverError
            ? error.code
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }

  return NextResponse.json({ at: now.toISOString(), due: due.length, runs });
}
