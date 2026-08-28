import { NextResponse } from "next/server";
import {
  addFreeAgent,
  availablePlayers,
  cancelClaim,
  dropPlayer,
  marketClosedReason,
  pendingClaims,
  submitClaim,
  WaiverError,
} from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";

const STATUS: Record<string, number> = {
  LEAGUE_NOT_FOUND: 404,
  TEAM_NOT_IN_LEAGUE: 403,
  NOT_ON_ROSTER: 409,
  PLAYER_TAKEN: 409,
  NOT_A_FREE_AGENT: 409,
  NOT_ON_WAIVERS: 409,
  ROSTER_FULL: 409,
  // Its sibling: the roster has room and a trade has spoken for it. A conflict
  // with the league's state, not a malformed request, and the fallback below
  // would call it 400.
  SLOT_HELD_FOR_TRADE: 409,
  DUPLICATE_CLAIM: 409,
  IN_A_TRADE: 409,
  // The league is not playing. A conflict with its state, like every other 409
  // here, and the fallback below would call it a malformed request.
  LEAGUE_NOT_IN_SEASON: 409,
  // Not new, and not part of #279 — `RULES.md` §6's kickoff refusal has been
  // reaching the client as a 400 since it was written, because it was never
  // added here. Fixed alongside rather than left as the odd one out in a map
  // this change already edits.
  GAME_STARTED: 409,
};

/** Everyone unrostered, with whether they can be added now or only claimed. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    const client = db();
    const now = new Date();

    const available = await availablePlayers(client, id, now);
    const roster = await client.query<{
      player_id: string;
      on_ir: boolean;
      full_name: string;
      key: string;
      image_url: string | null;
      team_ref: string | null;
      injury_designation: string | null;
    }>(
      `SELECT r.player_id, r.on_ir, p.full_name, pos.key,
              p.image_url, p.team_ref, p.injury_designation
         FROM roster_entries r
         JOIN players p ON p.id = r.player_id
         JOIN positions pos ON pos.id = p.primary_position_id
        WHERE r.team_id = $1 AND r.released_at IS NULL
        ORDER BY pos.sort_order, p.full_name`,
      [context.myTeamId],
    );

    return NextResponse.json({
      available: available.map((player) => ({
        playerId: player.playerId,
        name: player.fullName,
        positions: player.positions,
        availability: player.availability,
        clearsAt: player.clearsAt?.toISOString() ?? null,
        imageUrl: player.imageUrl,
        teamRef: player.teamRef,
        injuryDesignation: player.injuryDesignation,
      })),
      /*
        `onIr` is here so the drop selector can say so.

        Without it a stashed player sits in that dropdown looking exactly like a
        droppable bench player — and dropping him frees no roster space, which
        is the one mistake #237's fix makes likely rather than rare.
      */
      roster: roster.map((row) => ({
        playerId: row.player_id,
        onIr: row.on_ir,
        name: row.full_name,
        position: row.key,
        imageUrl: row.image_url,
        teamRef: row.team_ref,
        injuryDesignation: row.injury_designation,
      })),
      claims: await pendingClaims(client, id, context.myTeamId),
      /*
        Whether this league is transacting at all, and the sentence if not.

        Composed here rather than in the component, from the same function that
        refuses the write, because the screen and the server must not be able to
        disagree about it — a live Add button over a server that says no is a
        wall rather than an answer. It is also the only way this string gets a
        test: `apps/web` cannot render a component in one.

        The list itself stays. Those players genuinely are unrostered, and
        looking at the pool during a draft is useful.
      */
      market: {
        open: marketClosedReason(context.state, "ACQUIRE") === null,
        notice: marketClosedReason(context.state, "ACQUIRE"),
      },
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/**
 * Add, claim, or drop.
 *
 * One route because they are one decision from a manager's point of view — which
 * of the three happens is decided by the player's availability, not by which
 * button was pressed. A client that could choose would be able to ask for an
 * immediate add on a player who is on waivers.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.userId) {
      return NextResponse.json({ error: "Sign in first" }, { status: 401 });
    }
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    const body = (await request.json()) as {
      action?: "ADD" | "DROP" | "CANCEL_CLAIM";
      playerId?: string;
      dropPlayerId?: string | null;
      claimId?: string;
    };

    const client = db();
    const now = new Date();

    if (body.action === "CANCEL_CLAIM") {
      if (!body.claimId) {
        return NextResponse.json({ error: "claimId is required" }, { status: 400 });
      }
      await cancelClaim(client, id, context.myTeamId, body.claimId);
      return NextResponse.json({ cancelled: true });
    }

    if (!body.playerId) {
      return NextResponse.json({ error: "playerId is required" }, { status: 400 });
    }

    if (body.action === "DROP") {
      const result = await dropPlayer(client, id, context.myTeamId, body.playerId, now);
      return NextResponse.json({
        dropped: true,
        destination: result.destination,
        clearsAt: result.clearsAt?.toISOString() ?? null,
      });
    }

    // An add is a claim or an immediate pickup depending on where the player
    // stands. Trying the immediate path first and falling back keeps that
    // decision on the server.
    try {
      await addFreeAgent(client, {
        leagueId: id,
        teamId: context.myTeamId,
        addPlayerId: body.playerId,
        dropPlayerId: body.dropPlayerId ?? null,
        now,
      });
      return NextResponse.json({ added: true });
    } catch (error) {
      if (!(error instanceof WaiverError) || error.code !== "NOT_A_FREE_AGENT") throw error;

      const { claimId } = await submitClaim(client, {
        leagueId: id,
        teamId: context.myTeamId,
        addPlayerId: body.playerId,
        dropPlayerId: body.dropPlayerId ?? null,
        now,
      });
      return NextResponse.json({ claimed: true, claimId }, { status: 202 });
    }
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof WaiverError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    throw error;
  }
}
