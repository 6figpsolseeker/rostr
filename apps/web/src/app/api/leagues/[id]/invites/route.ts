import { NextResponse } from "next/server";
import {
  INVITE_PER_USER,
  InvitationError,
  invitationsForLeague,
  inviteToLeague,
  withdrawInvitation,
} from "@rostr/db";
import { db } from "@/lib/db";
import { enforceRateLimit } from "@/lib/rate-limit";
import { draftContext, DraftContextError } from "@/lib/draft-context";

const STATUS: Record<string, number> = {
  NO_SUCH_USER: 404,
  ALREADY_A_MEMBER: 409,
  SELF: 422,
  LEAGUE_NOT_FOUND: 404,
  LEAGUE_CLOSED: 409,
  EMPTY: 400,
};

/**
 * Who this league has asked.
 *
 * **Commissioner only**, and that is the gate `league-read.test.ts` sweeps for.
 * The list names people — usernames, and whether they have joined — so it is a
 * roster of a private league's invitees, which is exactly the kind of thing the
 * visibility rules exist to keep inside the league.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.isCommissioner) {
      return NextResponse.json({ error: "Not your league" }, { status: 403 });
    }

    const invitations = await invitationsForLeague(db(), id);

    return NextResponse.json({
      invitations: invitations.map((invitation) => ({
        id: invitation.id,
        username: invitation.invitedUsername,
        addressedAs: invitation.addressedAs,
        createdAt: invitation.createdAt.toISOString(),
        withdrawn: invitation.withdrawnAt !== null,
        accepted: invitation.accepted,
      })),
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/**
 * Invite somebody, by username or wallet address.
 *
 * **The commissioner comes from the session, and the identifier is the only
 * thing taken from the body.** A route that accepted a user id would let anyone
 * write an invitation into anyone's list — which is a way to put an unwanted
 * league in a stranger's inbox, and to make it look like a friend sent it.
 *
 * Rate limited per commissioner: an invitation is a message addressed to
 * somebody else, which is the shape of thing that gets used to harass people.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.isCommissioner) {
      return NextResponse.json({ error: "Not your league" }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as { identifier?: string };
    if (typeof body.identifier !== "string") {
      return NextResponse.json({ error: "identifier is required" }, { status: 400 });
    }

    // `userId` is non-null here: `isCommissioner` is false for a signed-out
    // caller, so the guard above has already refused one.
    const limited = await enforceRateLimit([
      { rule: INVITE_PER_USER, subject: context.userId! },
    ]);
    if (limited) return limited;

    const invitation = await inviteToLeague(db(), {
      leagueId: id,
      invitedBy: context.userId!,
      identifier: body.identifier,
    });

    return NextResponse.json({ invitationId: invitation.id });
  } catch (error) {
    if (error instanceof InvitationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/**
 * Take an invitation back.
 *
 * The league id is in the path and is passed to `withdrawInvitation`, which
 * scopes its `UPDATE` by both. Establishing that the caller runs *this* league
 * and then updating by id alone would let a commissioner of any league withdraw
 * any invitation by guessing a UUID.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.isCommissioner) {
      return NextResponse.json({ error: "Not your league" }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as { invitationId?: string };
    if (typeof body.invitationId !== "string") {
      return NextResponse.json({ error: "invitationId is required" }, { status: 400 });
    }

    await withdrawInvitation(db(), id, body.invitationId);
    return NextResponse.json({ withdrawn: true });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
