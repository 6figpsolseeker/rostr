import { NextResponse } from "next/server";
import {
  catchUpExpiredPicks,
  draftProgress,
  draftsWithExpiredPicks,
  loadDraft,
  getQueue,
} from "@rostr/db";
import { db } from "@/lib/db";
import { draftBoard, draftContext, DraftContextError } from "@/lib/draft-context";

/**
 * The live draft state.
 *
 * **Advances the clock as a side effect.** Expiry has to happen somewhere, and
 * there is no scheduled worker yet — so any read of the draft first auto-picks
 * anything already overdue. The auto-pick is deterministic and idempotent, so it
 * does not matter who triggers it or how often.
 *
 * The limitation is real and worth stating: **if nobody looks at a draft, its
 * clock does not advance.** For a slow draft with a 24-hour timer that is
 * harmless; for a fast one, the room is open and being polled. It should still
 * become a scheduled job calling `draftsWithExpiredPicks()` before the season —
 * a draft that stalls because everyone closed the tab is a bad night.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    const client = db();

    let draft = await loadDraft(client, id);
    if (!draft) return NextResponse.json({ draft: null });

    // Catch the clock up before reporting anything.
    if (draft.status === "IN_PROGRESS") {
      const board = await draftBoard(context.season);
      const made = await catchUpExpiredPicks(client, {
        leagueId: id,
        pool: board.pool,
        shape: context.shape,
        now: new Date(),
      });
      if (made > 0) draft = (await loadDraft(client, id))!;
    }

    const teams = await client.query<{
      id: string;
      name: string;
      is_bot: boolean;
      draft_position: number | null;
    }>(
      `SELECT id, name, is_bot, draft_position FROM teams
        WHERE league_id = $1 ORDER BY COALESCE(draft_position, slot)`,
      [id],
    );

    const progress = draftProgress(draft);

    return NextResponse.json({
      draft: {
        status: draft.status,
        rounds: draft.rounds,
        pickSeconds: draft.pickSeconds,
        scheduledAt: draft.scheduledAt.toISOString(),
        clockStartedAt: draft.clockStartedAt?.toISOString() ?? null,
        draw: draft.draw
          ? {
              slot: draft.draw.slot,
              blockhash: draft.draw.blockhash,
              seed: draft.draw.seed,
              drawnAt: draft.draw.drawnAt.toISOString(),
            }
          : null,
        order: draft.order,
        picks: draft.state.picks,
        ...progress,
      },
      teams: teams.map((team) => ({
        id: team.id,
        name: team.name,
        isBot: team.is_bot,
        draftPosition: team.draft_position,
      })),
      me: {
        teamId: context.myTeamId,
        isCommissioner: context.isCommissioner,
        queue: context.myTeamId ? await getQueue(client, context.myTeamId) : [],
      },
      // Handy for a monitoring page later, and free to include.
      overdueLeagues: await draftsWithExpiredPicks(client, new Date()),
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
