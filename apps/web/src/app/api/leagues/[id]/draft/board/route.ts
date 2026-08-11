import { NextResponse } from "next/server";
import { leagueReadForbidden } from "@/lib/league-read";
import { draftBoard, draftContext, DraftContextError } from "@/lib/draft-context";

/**
 * The full player pool, once.
 *
 * A thousand players is around 80 KB, and it changes only when the stats sync
 * runs. Sending it on every poll of the draft state would be wasteful, so it is
 * fetched separately and the client subtracts drafted players itself.
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
        // Milli-points, scored with *this league's* rules. Null where the
        // provider has no projection — a deep-bench flier is still draftable,
        // and showing a confident zero would be worse than showing nothing.
        projectedMilliPoints: board.projected.get(entry.playerId) ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
