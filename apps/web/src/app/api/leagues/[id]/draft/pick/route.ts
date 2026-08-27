import { NextResponse } from "next/server";
import { DraftPersistenceError, recordPick } from "@rostr/db";
import { db } from "@/lib/db";
import { draftBoard, draftContext, DraftContextError } from "@/lib/draft-context";

const STATUS: Record<string, number> = {
  DRAFT_NOT_FOUND: 404,
  NOT_IN_PROGRESS: 409,
  PICK_RACE_LOST: 409,
  CLOCK_EXPIRED: 409,
  NOT_ON_CLOCK: 409,
  PLAYER_UNAVAILABLE: 409,
  ROSTER_FULL: 409,
  ALREADY_ROSTERED: 409,
  ORDER_NOT_DRAWN: 409,
  // Both mean the engine was handed a pool that does not contain this draft's
  // own picks. Not a conflict a manager can retry out of, so not the 409 the
  // fallback below would give it.
  POOL_INCOMPLETE: 500,
  PICK_PLAYER_MISSING: 500,
};

/**
 * Make a pick.
 *
 * The team comes from the session, never from the body. Everything else — whose
 * turn it is, whether the player is available, whether the roster can take him,
 * and whether the clock has already run out — is decided by the engine and the
 * database. This route only carries the request.
 *
 * **A late pick is refused, `CLOCK_EXPIRED`, not accepted.** The deadline passed
 * means the pick belongs to the auto-pick, stamped at that deadline; accepting a
 * click that arrives afterwards would stamp the next clock at whenever it landed
 * and hand every manager below the overrun. The room disables the button when
 * the countdown reads zero, so reaching this is a click racing its own clock —
 * but the button is a courtesy and this is the rule.
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

    const board = await draftBoard(context.season, context.rules);

    const pick = await recordPick(db(), {
      leagueId: id,
      teamId: context.myTeamId,
      playerId: body.playerId,
      pool: board.pool,
      shape: context.shape,
      now: new Date(),
    });

    if (!pick) {
      // `null` means the pick this request meant had already been made. A manual
      // pick names no `expectedPickNumber`, so it is unreachable from here today
      // — reported rather than asserted away, because the alternative is a `!`
      // that becomes a crash the day this route does name one.
      return NextResponse.json(
        { error: "That pick has already been made", code: "PICK_RACE_LOST" },
        { status: 409 },
      );
    }

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
