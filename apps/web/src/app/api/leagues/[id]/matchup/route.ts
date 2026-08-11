import { NextResponse } from "next/server";
import { NFL } from "@rostr/core";
import { currentWeek, loadWeekMatchups, MatchupError } from "@rostr/db";
import type { MatchupSide } from "@rostr/db";
import { db } from "@/lib/db";
import { leagueReadForbidden } from "@/lib/league-read";
import { draftContext, DraftContextError } from "@/lib/draft-context";

/**
 * A week's matchups, scored.
 *
 * The week may be supplied — browsing back through the season is the point of
 * having a week selector — because **nothing here is a rule**. This route only
 * reads. The one place a client-supplied week would be dangerous is the trade
 * deadline, and that route derives its own.
 */
function requestedWeek(request: Request): number | null {
  const raw = new URL(request.url).searchParams.get("week");
  if (raw === null) return null;

  const week = Number.parseInt(raw, 10);
  return Number.isFinite(week) && week > 0 ? week : null;
}

function side(value: MatchupSide) {
  return {
    teamId: value.teamId,
    name: value.teamName,
    isBot: value.isBot,
    milliPoints: value.milliPoints,
    restatedMilliPoints: value.restatedMilliPoints,
    yetToPlay: value.yetToPlay,
    inProgress: value.inProgress,
    starters: value.starters.map(line),
    bench: value.bench.map(line),
  };
}

function line(value: MatchupSide["starters"][number]) {
  return {
    playerId: value.playerId,
    name: value.name,
    position: value.position,
    slot: value.slot,
    milliPoints: value.milliPoints,
    gameState: value.gameState,
    kickoffAt: value.kickoffAt?.toISOString() ?? null,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  // `visibility` is a frozen, member-signed rule. See `lib/visibility.ts`.
  const forbidden = await leagueReadForbidden(id);
  if (forbidden) return forbidden;

  try {
    const context = await draftContext(id);
    const client = db();
    const now = new Date();

    // Default to the week being played, from the schedule rather than a
    // calendar guess. Week 1 before kickoff, so a league in preseason opens on
    // something rather than on nothing.
    const week = requestedWeek(request) ?? (await currentWeek(client, NFL.key, now)) ?? 1;

    const views = await loadWeekMatchups(client, id, week, now);

    return NextResponse.json({
      week,
      myTeamId: context.myTeamId,
      regularSeasonWeeks: context.rules.schedule.regularSeasonWeeks,
      matchups: views.map((view) => ({
        week: view.week,
        phase: view.phase,
        finalized: view.finalized,
        home: side(view.home),
        away: view.away ? side(view.away) : null,
      })),
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof MatchupError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    throw error;
  }
}
