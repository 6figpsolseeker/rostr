import { NextResponse } from "next/server";
import { indexScoringRules, scorePlayer, slotLocksAt, startingSlots } from "@rostr/core";
import { buildRosterShape, NFL } from "@rostr/core";
import type { LineupAssignment } from "@rostr/core";
import {
  LineupError,
  loadLineup,
  loadRosterForWeek,
  loadWeekStats,
  setLineup,
} from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";

const STATUS: Record<string, number> = {
  LEAGUE_NOT_FOUND: 404,
  TEAM_NOT_IN_LEAGUE: 403,
  INVALID_LINEUP: 422,
  SLOT_TYPE_UNKNOWN: 500,
};

function weekOf(request: Request): number {
  const raw = new URL(request.url).searchParams.get("week");
  const week = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(week) && week > 0 ? week : 1;
}

/**
 * Your lineup for a week, with everything needed to edit it.
 *
 * Locks are computed and sent per slot rather than left to the client, so the
 * screen and the server cannot disagree about what has kicked off. The server
 * checks again on write regardless — this is for showing, not for deciding.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const week = weekOf(request);

  try {
    const context = await draftContext(id);
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    const client = db();
    const roster = await loadRosterForWeek(client, context.myTeamId, context.season, week);
    const assignments = await loadLineup(client, context.myTeamId, week, context.rules);

    // Points so far this week, so a manager can see what their lineup is doing
    // while it is doing it.
    const stats = await loadWeekStats(client, NFL.key, context.season, week);
    const scoring = indexScoringRules(context.rules.scoring);

    const now = Math.floor(Date.now() / 1000);

    return NextResponse.json({
      week,
      slots: startingSlots(buildRosterShape(context.rules.roster, NFL)).map((slot) => {
        const assignment = assignments.find(
          (entry) => entry.slotType === slot.slotType && entry.slotIndex === slot.slotIndex,
        ) ?? { slotType: slot.slotType, slotIndex: slot.slotIndex, playerId: null };

        const locksAt = slotLocksAt(assignment, roster);

        return {
          slotType: slot.slotType,
          slotIndex: slot.slotIndex,
          eligiblePositions: slot.eligiblePositions,
          playerId: assignment.playerId,
          locksAt,
          locked: locksAt !== null && now >= locksAt,
        };
      }),
      roster: [...roster.values()].map((player) => ({
        playerId: player.playerId,
        name: player.fullName,
        positions: player.positions,
        status: player.status,
        kickoffAt: player.kickoffAt,
        milliPoints: scorePlayer(stats.get(player.playerId) ?? [], scoring),
      })),
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof LineupError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    throw error;
  }
}

/**
 * Replace your lineup.
 *
 * The team comes from the session. Legality and locks are decided by
 * `setLineup`, against what is currently stored — never against anything the
 * client claims about its own state.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.userId) {
      return NextResponse.json({ error: "Sign in to set a lineup" }, { status: 401 });
    }
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    const body = (await request.json()) as {
      week?: number;
      assignments?: LineupAssignment[];
    };

    if (!body.week || !Array.isArray(body.assignments)) {
      return NextResponse.json({ error: "week and assignments are required" }, { status: 400 });
    }

    const saved = await setLineup(db(), {
      leagueId: id,
      teamId: context.myTeamId,
      week: body.week,
      assignments: body.assignments,
      now: Math.floor(Date.now() / 1000),
    });

    return NextResponse.json({ week: body.week, assignments: saved });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof LineupError) {
      return NextResponse.json(
        { error: error.message, code: error.code, problems: error.problems },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    throw error;
  }
}
