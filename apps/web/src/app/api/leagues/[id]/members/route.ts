import { NextResponse } from "next/server";
import { JoinError, removeMember } from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";

const STATUS: Record<string, number> = {
  LEAGUE_NOT_FOUND: 404,
  RULES_MISSING: 500,
  NOT_COMMISSIONER: 403,
  TEAM_NOT_IN_LEAGUE: 404,
  CANNOT_REMOVE_COMMISSIONER: 422,
  IS_A_BOT: 422,
  POT_LEAGUE: 409,
  DRAFT_ALREADY_DRAWN: 409,
  FIELD_LOCKED: 409,
};

/**
 * Remove a member, before the league drafts.
 *
 * **Commissioner only**, which is also the gate `league-read.test.ts` sweeps
 * for. The check here produces a usable 403; `removeMember` checks again against
 * the league's own `commissioner_id` and is what actually decides, because this
 * route knows only what `draftContext` told it.
 *
 * The team comes from the body and the league from the path, and
 * `removeMember`'s `DELETE` is scoped by both — so a commissioner cannot reach
 * into another league by guessing a team UUID.
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

    const body = (await request.json().catch(() => ({}))) as { teamId?: string };
    if (typeof body.teamId !== "string") {
      return NextResponse.json({ error: "teamId is required" }, { status: 400 });
    }

    // `userId` is non-null: `isCommissioner` is false for a signed-out caller.
    await removeMember(db(), {
      leagueId: id,
      teamId: body.teamId,
      actingUserId: context.userId!,
    });

    return NextResponse.json({ removed: body.teamId });
  } catch (error) {
    if (error instanceof JoinError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    if (error instanceof DraftContextError) {
      return NextResponse.json(
        { error: error.message, code: "CONTEXT" },
        { status: error.status },
      );
    }
    throw error;
  }
}
