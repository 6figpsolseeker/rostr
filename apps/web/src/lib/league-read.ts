import "server-only";

import { NextResponse } from "next/server";
import { leagueReadAccess } from "./visibility";

/**
 * The API half of the visibility gate.
 *
 * Returns a response to send, or `null` to carry on. Split from
 * `leagueReadAccess` so a server component can ask the same question and answer
 * it its own way — a page renders a notice, a route returns a status, and
 * neither should have to know about the other's return type.
 *
 * **404 for a private league, not 403.** A 403 confirms the league exists, which
 * is the one fact an unguessable id is protecting. The distinction costs nothing
 * to a member, who never sees either.
 */
export async function leagueReadForbidden(leagueId: string): Promise<NextResponse | null> {
  const access = await leagueReadAccess(leagueId);
  if (access.ok) return null;

  return NextResponse.json({ error: "League not found" }, { status: 404 });
}
