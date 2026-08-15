import { NextResponse } from "next/server";
import { leaguesWithDueTrades, resolveDueTrades, TradeError } from "@rostr/db";
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

  return NextResponse.json({ at: now.toISOString(), due: due.length, runs });
}
