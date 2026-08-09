import { NextResponse } from "next/server";
import { leaguesWithDueTrades, resolveDueTrades, TradeError } from "@rostr/db";
import { db } from "@/lib/db";

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
  const due = await leaguesWithDueTrades(client, now);

  const runs: {
    leagueId: string;
    executed?: number;
    vetoed?: number;
    expired?: number;
    error?: string;
  }[] = [];

  for (const leagueId of due) {
    try {
      const resolutions = await resolveDueTrades(client, leagueId, now);
      runs.push({
        leagueId,
        executed: resolutions.filter((r) => r.outcome === "EXECUTED").length,
        vetoed: resolutions.filter((r) => r.outcome === "VETOED").length,
        expired: resolutions.filter((r) => r.outcome === "EXPIRED").length,
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
