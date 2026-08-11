import { NextResponse } from "next/server";
import { buildRosterShape, NFL } from "@rostr/core";
import {
  catchUpExpiredPicks,
  draftsWithExpiredPicks,
  getLeagueRules,
  purgeExpiredSessions,
  purgeIdleRateLimits,
} from "@rostr/db";
import { db } from "@/lib/db";
import { cronForbidden } from "@/lib/cron";
import { draftBoard } from "@/lib/draft-context";

/**
 * Advance every draft whose clock has run out.
 *
 * Until this existed, expiry only happened when somebody *read* a draft — so a
 * draft nobody had open did not advance, and a manager who went to bed could
 * come back to find their clock had never actually run. "You had to keep the tab
 * open" is not a rule anyone agreed to.
 *
 * Idempotent and deterministic: it makes exactly the picks the clock says are
 * overdue, stamped at the deadlines they missed. Running it twice, or alongside
 * somebody loading the room, changes nothing — because `recordPick` re-checks
 * the pick number and the deadline inside its lock, so a tick that overlaps a
 * page load records nothing rather than taking the next manager's pick. It is
 * not idempotent by virtue of the picks being deterministic; it is idempotent
 * because a caller that loses the race writes nothing. See
 * `catchUpExpiredPicks`.
 *
 * Wire it to a scheduler that fires **at least as often as the shortest pick
 * clock** — a minute is right, given the 90-second minimum. On Vercel that is
 * `vercel.json`; anywhere else, cron hitting this URL.
 */
export async function GET(request: Request): Promise<NextResponse> {
  // Not a security boundary in the usual sense — this endpoint only does what
  // the clock already permits, so an unauthorised call cannot make a wrong pick.
  // It guards against someone hammering it for the database load.
  //
  // That first sentence is only true because of the guards inside `recordPick`.
  // Hammering an unguarded catch-up at the instant of a real expiry is how you
  // turn one legitimate auto-pick into several, and the draft read route is
  // public and does the same work, so the secret was never what stood between an
  // attacker and that. If you are tempted to remove those guards, this comment
  // becomes a lie first.
  const forbidden = cronForbidden(request);
  if (forbidden) return forbidden;

  const client = db();
  const now = new Date();
  const overdue = await draftsWithExpiredPicks(client, now);

  const advanced: { leagueId: string; picks: number; error?: string }[] = [];

  for (const leagueId of overdue) {
    try {
      const stored = await getLeagueRules(client, leagueId);
      if (!stored) continue;

      const [league] = await client.query<{ season: number }>(
        "SELECT season FROM leagues WHERE id = $1",
        [leagueId],
      );
      if (!league) continue;

      const board = await draftBoard(Number(league.season), stored.rules);

      const picks = await catchUpExpiredPicks(client, {
        leagueId,
        pool: board.pool,
        shape: buildRosterShape(stored.rules.roster, NFL),
        now,
      });

      advanced.push({ leagueId, picks });
    } catch (error) {
      // One broken league must not stop every other draft from advancing. The
      // failure is reported rather than swallowed, so a monitoring page or a log
      // shows it instead of a draft mysteriously stalling.
      advanced.push({
        leagueId,
        picks: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Housekeeping, here because it needs a scheduler and nothing else does.
  // Cheap, and keeping expired sessions or stale hashed IPs around serves
  // nothing.
  const sessions = await purgeExpiredSessions(client, now);
  const buckets = await purgeIdleRateLimits(
    client,
    new Date(now.getTime() - 24 * 60 * 60 * 1000),
  );

  return NextResponse.json({
    at: now.toISOString(),
    draftsChecked: overdue.length,
    advanced,
    purged: { sessions, rateLimitBuckets: buckets },
  });
}
