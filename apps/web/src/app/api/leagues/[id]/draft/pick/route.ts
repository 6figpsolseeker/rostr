import { NextResponse } from "next/server";
import { DraftPersistenceError, recordPick } from "@rostr/db";
import { db } from "@/lib/db";
import { draftBoard, draftContext, DraftContextError } from "@/lib/draft-context";

const STATUS: Record<string, number> = {
  DRAFT_NOT_FOUND: 404,
  NOT_IN_PROGRESS: 409,
  PICK_RACE_LOST: 409,
  NOT_ON_CLOCK: 409,
  PLAYER_UNAVAILABLE: 409,
  ROSTER_FULL: 409,
  ALREADY_ROSTERED: 409,
  ORDER_NOT_DRAWN: 409,
};

/**
 * Make a pick.
 *
 * The team comes from the session, never from the body. Everything else — whose
 * turn it is, whether the player is available, whether the roster can take him —
 * is decided by the engine, which the database then arbitrates. This route only
 * carries the request.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.userId) {
      return NextResponse.json({ error: "Sign in to draft" }, { status: 401 });
    }
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    const body = (await request.json()) as { playerId?: string };
    if (!body.playerId) {
      return NextResponse.json({ error: "playerId is required" }, { status: 400 });
    }

    const board = await draftBoard(context.season);

    const pick = await recordPick(db(), {
      leagueId: id,
      teamId: context.myTeamId,
      playerId: body.playerId,
      pool: board.pool,
      shape: context.shape,
      now: new Date(),
    });

    return NextResponse.json({ pick }, { status: 201 });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DraftPersistenceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    // DraftError from the engine — out of turn, player gone, roster full.
    if (error instanceof Error && error.name === "DraftError") {
      const code = (error as Error & { code?: string }).code ?? "";
      return NextResponse.json({ error: error.message, code }, { status: STATUS[code] ?? 409 });
    }
    throw error;
  }
}
