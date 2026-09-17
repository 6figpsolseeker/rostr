import { NextResponse } from "next/server";
import { leaguesWithDueTrades, recordCronRun, resolveDueTrades, TradeError } from "@rostr/db";
import type { SqlClient } from "@rostr/db";
import { db } from "@/lib/db";
import { cronForbidden } from "@/lib/cron";

/**
 * Settle every trade whose veto window has closed.
 *
 * Without this nothing ever executes: acceptance only opens the window, and the
 * swap happens when it shuts. A trade cannot resolve on a page load the way a
 * draft pick expires, because the two managers involved have no reason to be
 * looking — the whole point of the window is that it runs while they wait.
 *
 * Hourly is enough for a 48-hour window, and running more often is harmless:
 * `resolveDueTrades` skips open windows and a resolved trade leaves the
 * `ACCEPTED` state, so it is never settled twice.
 *
 * **On the half hour, not the hour, and that is deliberate.** Execution takes
 * `leagues … FOR SHARE` (#277), which conflicts with the `FOR UPDATE` a waiver
 * run holds — and `/api/cron/waivers` is hourly on the hour. Scheduling both at
 * the same instant meant one waited for the other every hour, for no reason:
 * nothing orders these two. `RULES.md` ties trade execution to the veto window
 * and to the trade deadline's *week*, never to a waiver run, and the window is
 * 48 hours, so half an hour of offset is not a rule anyone can notice.
 *
 * It shares the minute with `/api/cron/stats`, which is fine — that job writes
 * `stat_lines` and `games` and takes no league lock, so there is nothing for
 * them to contend on. The collision worth avoiding was the one on a row lock.
 *
 * That last clause was true of one run at a time and false under overlap, which
 * is what a sentence inviting more frequent runs ought not to be. Two runs could
 * both select the same trade; one executed it and the other, finding the assets
 * moved, recorded it `EXPIRED` over the top — "rosters untouched", written about
 * rosters that had just moved. Every state write is now conditional on the state
 * it expects, so the loser of that race writes nothing.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const forbidden = cronForbidden(request);
  if (forbidden) return forbidden;

  const client = db();
  const now = new Date();

  try {
    return await run(client, now);
  } catch (error) {
    // Stamped and rethrown, so the response is exactly what it was before. A
    // route that throws on every invocation is worse than one that never fires,
    // and without this both read as a stale row.
    await recordCronRun(
      client,
      "trades",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

async function run(client: SqlClient, now: Date): Promise<NextResponse> {
  const due = await leaguesWithDueTrades(client, now);

  const runs: {
    leagueId: string;
    executed?: number;
    vetoed?: number;
    expired?: number;
    /**
     * Trades this run could not settle. They are still ACCEPTED and will be
     * retried next hour — reported because a trade that can never execute would
     * otherwise look healthy forever, the same reason `bracketProblem` exists.
     */
    failures?: { tradeId: string; reason: string }[];
    error?: string;
  }[] = [];

  for (const leagueId of due) {
    try {
      const { resolutions, failures } = await resolveDueTrades(client, leagueId, now);
      runs.push({
        leagueId,
        executed: resolutions.filter((r) => r.outcome === "EXECUTED").length,
        vetoed: resolutions.filter((r) => r.outcome === "VETOED").length,
        expired: resolutions.filter((r) => r.outcome === "EXPIRED").length,
        ...(failures.length > 0 ? { failures: [...failures] } : {}),
      });
    } catch (error) {
      // One league's bad state must not hold up everyone else's trades.
      runs.push({
        leagueId,
        error:
          error instanceof TradeError
            ? error.code
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }

  // The outcome, not merely the fact of running: a league that failed is
  // already reported in `runs`, and a row saying "ran, all fine" while three
  // leagues threw would be the healthy face this record exists to remove.
  const failed = runs.filter((entry) => entry.error).length;
  await recordCronRun(
    client,
    "trades",
    failed > 0 ? `${failed} of ${due.length} leagues failed` : null,
  );

  return NextResponse.json({ at: now.toISOString(), due: due.length, runs });
}
