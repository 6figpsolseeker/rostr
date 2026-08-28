import { NextResponse } from "next/server";
import { activateFromIr, IrError, moveToIr } from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";

/**
 * Injured reserve, on and off.
 *
 * **Your own team only.** The team is derived from the caller's membership, not
 * taken from the request — a caller with no way to *name* another team has no
 * way to act on one. Same shape as the lineup route beside it, and the same
 * reason.
 *
 * The rules half lives in `@rostr/core`; the transaction half in `@rostr/db`.
 * This route does nothing but establish who is asking and map a refusal to a
 * status, which is why there is no capacity arithmetic anywhere in it.
 */

const STATUS: Record<string, number> = {
  LEAGUE_NOT_FOUND: 404,
  NOT_ON_ROSTER: 404,
  NOT_ON_IR: 404,
  // The league's own frozen rules refuse it. Well-formed requests against a
  // state that does not permit them, so 409 rather than 422.
  NOT_INJURED: 409,
  IR_FULL: 409,
  GAME_STARTED: 409,
  // Bringing him back would breach the roster limit, or a trade is holding the
  // room. Same family as the three above, and without these the fallback below
  // would report a state conflict as a malformed request.
  ROSTER_WOULD_OVERFLOW: 409,
  SLOT_HELD_FOR_TRADE: 409,
};

function fail(error: unknown): NextResponse {
  if (error instanceof IrError) {
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      playerId?: unknown;
      week?: unknown;
      action?: unknown;
    };
    if (typeof body.playerId !== "string") {
      return NextResponse.json({ error: "playerId is required" }, { status: 400 });
    }

    if (body.action === "ACTIVATE") {
      const result = await activateFromIr(db(), {
        leagueId: id,
        teamId: context.myTeamId,
        playerId: body.playerId,
      });
      return NextResponse.json(result);
    }

    /*
      The week comes from the client here, and that is safe in a way it is not
      on the trades route.

      It selects which fixture the kickoff check looks at, and the check only
      ever *refuses*. Naming a week with no fixture finds no kickoff and lets
      the move through — which is the same answer a bye gives, and a bye is a
      legitimate time to stash somebody. Nothing here is a deadline a wrong week
      could move.
    */
    const week = typeof body.week === "number" && body.week > 0 ? body.week : 1;

    const result = await moveToIr(db(), {
      leagueId: id,
      teamId: context.myTeamId,
      playerId: body.playerId,
      week,
      now: new Date(),
    });
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
