import { NextResponse } from "next/server";
import { leagueReadForbidden } from "@/lib/league-read";
import { draftBoard, draftContext, DraftContextError } from "@/lib/draft-context";

/**
 * The full player pool, once.
 *
 * Roughly 1,600 players is around 150 KB, and it changes only when the stats
 * sync runs. Sending it on every poll of the draft state would be wasteful, so
 * it is fetched separately and the client subtracts drafted players itself.
 *
 * It was ~1,000 players and ~80 KB until 2026-09-16, when players their clubs
 * had released stopped being filtered out and started sorting last instead. That
 * tail is not bounded — nothing prunes `players` and it carries no season — so
 * this number is a measurement with a date on it rather than a budget.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  // `visibility` is a frozen, member-signed rule. See `lib/visibility.ts`.
  const forbidden = await leagueReadForbidden(id);
  if (forbidden) return forbidden;

  try {
    const context = await draftContext(id);
    const board = await draftBoard(context.season, context.rules);

    return NextResponse.json({
      players: board.entries.map((entry) => ({
        id: entry.playerId,
        name: entry.fullName,
        positions: entry.positions,
        rank: entry.rank,
        // Whether his NFL club still has him. The array already arrives with
        // the cut players last, but the room re-sorts for itself, so the
        // server's ordering does not survive the trip unless this column does.
        // Nothing expires a ranking — `player_rankings_current` is the latest
        // ADP ever recorded — so a star cut in September keeps July's ADP and
        // would sort to the *top* without it. Do not drop this from the payload
        // to save bytes. See `byDraftValue` in `lib/draft-board.ts`.
        active: entry.active,
        // Milli-points, scored with *this league's* rules. Null where the
        // provider has no projection — a deep-bench flier is still draftable,
        // and showing a confident zero would be worse than showing nothing.
        projectedMilliPoints: board.projected.get(entry.playerId) ?? null,
        // A face, a club, a bye and a designation. Display only — the draft
        // engine reads none of it, and every field can be null on a pool
        // that has not been synced since the profile columns landed.
        imageUrl: entry.summary.imageUrl,
        teamRef: entry.summary.teamRef,
        byeWeek: entry.summary.byeWeek,
        injuryDesignation: entry.summary.injuryDesignation,
      })),
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
