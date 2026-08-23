import { NextResponse } from "next/server";
import { declineInvitation, invitationsForUser } from "@rostr/db";
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

/**
 * Refuse an invitation.
 *
 * **Scoped to you, like the GET above**, and that is the whole authorisation
 * story: the account comes from the session cookie and `declineInvitation` is
 * scoped by the invitee, so a caller has no way to *name* another person and
 * therefore no way to act as them. The mirror of `withdrawInvitation`, which is
 * scoped by league because a commissioner acts on their league's invitations.
 *
 * A 401 for a signed-out caller rather than the GET's empty list: reading
 * nothing is a reasonable answer to "what am I invited to", and declining
 * nothing is not a request that can succeed.
 *
 * `declined: false` is returned with a 200, not an error. It means the row was
 * already declined, already withdrawn, or was never this caller's — and all
 * three end with the invitation gone from their list, which is what they asked
 * for. Distinguishing them in the response would report on invitations
 * belonging to other people.
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in first" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { invitationId?: unknown };
  if (typeof body.invitationId !== "string") {
    return NextResponse.json({ error: "invitationId is required" }, { status: 400 });
  }

  const result = await declineInvitation(db(), body.invitationId, user.id);

  return NextResponse.json(result);
}
