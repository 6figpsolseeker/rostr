import { NextResponse } from "next/server";
import { lastWaiverRun } from "@rostr/db";
import { db } from "@/lib/db";
import { leagueReadForbidden } from "@/lib/league-read";

/**
 * What the last waiver run decided.
 *
 * **The whole league's claims, not the caller's.** Waivers are decided *between*
 * teams — "somebody with better priority claimed him first" is an unverifiable
 * assertion if you can only see your own row, and `RULES.md` makes the
 * resolution public within the league precisely so it can be checked rather than
 * trusted. Which is also why this is gated by `leagueReadForbidden` like the
 * standings and not by membership: a private league reports how it is going only
 * to people entitled to know, and everyone entitled to see the standings is
 * entitled to see how a player changed hands.
 *
 * `null` before the first run of a season, which is not an error and must not be
 * a 404 — the league exists and the answer is "nothing yet".
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const forbidden = await leagueReadForbidden(id);
  if (forbidden) return forbidden;

  const run = await lastWaiverRun(db(), id);

  return NextResponse.json({ run });
}
