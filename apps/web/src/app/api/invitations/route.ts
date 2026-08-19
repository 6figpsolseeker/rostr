import { NextResponse } from "next/server";
import { invitationsForUser } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

/**
 * Leagues you have been asked to join.
 *
 * Not under `/api/leagues/[id]/`, because it is not scoped to a league — it is
 * scoped to **you**, and the account comes from the session cookie. That is also
 * why it needs no `leagueReadForbidden`: every row it can return is a league
 * somebody deliberately invited this account to, which is the one case where a
 * private league's name is meant to reach a non-member.
 *
 * A signed-out caller gets an empty list rather than a 401, so the header can
 * ask without putting an error in every logged-out console.
 */
export async function GET(): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ invitations: [] });

  const invitations = await invitationsForUser(db(), user.id);

  return NextResponse.json({
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      leagueId: invitation.leagueId,
      leagueName: invitation.leagueName,
      /**
       * Which identifier the commissioner used.
       *
       * Shown, because they are different assurances: somebody who invited you
       * by wallet address knew an address you had proven, and somebody who used
       * your username knew what you call yourself. If neither is a person you
       * recognise, that is worth being able to see.
       */
      addressedAs: invitation.addressedAs,
      createdAt: invitation.createdAt.toISOString(),
    })),
  });
}
