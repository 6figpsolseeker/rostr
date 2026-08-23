import { NextResponse } from "next/server";
import { leaguesForUser } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

/**
 * The leagues you are in.
 *
 * Scoped to **you**, from the session cookie — which is why it lives under
 * `/api/me` rather than `/api/leagues/[id]`, and why it needs no
 * `leagueReadForbidden`. Every row it can return is a league this account holds
 * a membership in, and a member may read their own league whatever its
 * visibility.
 *
 * A signed-out caller gets an empty list rather than a 401, so the hub can ask
 * without putting an error in the console of every logged-out visit.
 */
export async function GET(): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ leagues: [] });

  const leagues = await leaguesForUser(db(), user.id);

  return NextResponse.json({
    leagues: leagues.map((league) => ({
      id: league.leagueId,
      name: league.name,
      state: league.state,
      teamCount: league.teamCount,
      teamName: league.teamName,
      /** Unix seconds, rendered against the reader's own clock. */
      draftScheduledAt: league.draftScheduledAt,
      draftStatus: league.draftStatus,
      rounds: league.rounds,
      currentRound: league.currentRound,
      onTheClock: league.onTheClock,
    })),
  });
}
