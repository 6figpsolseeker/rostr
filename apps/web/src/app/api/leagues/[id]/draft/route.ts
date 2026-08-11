import { NextResponse } from "next/server";
import {
  catchUpExpiredPicks,
  draftProgress,
  draftsWithExpiredPicks,
  loadDraft,
  getQueue,
} from "@rostr/db";
import { teamOnClock, totalPicks } from "@rostr/core";
import { db } from "@/lib/db";
import { leagueReadForbidden } from "@/lib/league-read";
import { draftBoard, draftContext, DraftContextError } from "@/lib/draft-context";

/** The team picking after `pickNumber`, or `null` if that is the last pick. */
function nextTeamOnClock(
  order: readonly string[],
  pickNumber: number,
  rounds: number,
): string | null {
  const next = pickNumber + 1;
  if (order.length === 0 || next > totalPicks(order.length, rounds)) return null;
  return teamOnClock(next, order);
}

/**
 * The live draft state.
 *
 * **Advances the clock as a side effect.** Expiry has to happen somewhere, and
 * `/api/cron/draft-tick` only fires once a minute — so any read of the draft
 * first auto-picks anything already overdue.
 *
 * **This route needs no session, and every open tab polls it at one second while
 * its manager is on the clock or on deck.** So the catch-up runs from many
 * callers at once, none of them coordinated, at the exact instant a deadline
 * passes. That is safe because `recordPick` re-checks the pick number and the
 * deadline inside its lock and records nothing if either moved — it is not safe
 * merely because the picks are deterministic. See `catchUpExpiredPicks`.
 *
 * **It must also stay a no-op rather than a throw when it loses that race**,
 * which is what `catchUpExpiredPicks` promises. The catch below handles
 * `DraftContextError` and rethrows everything else, so anything else surfaces as
 * a 500 in a polling tab at the moment the draft advances — the worst possible
 * moment for the room to go blank. That includes the race where the winner made
 * the *final* pick and completed the draft, which is why `recordPick` answers a
 * named caller with `null` rather than `NOT_IN_PROGRESS`.
 *
 * The limitation is real and worth stating: **between cron ticks, a draft nobody
 * is looking at does not advance.** For a slow draft with a 24-hour timer that
 * is irrelevant; for a fast one, a minute is the worst case and the room is open
 * and polling anyway.
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
    const client = db();

    let draft = await loadDraft(client, id);
    if (!draft) return NextResponse.json({ draft: null });

    // Catch the clock up before reporting anything.
    if (draft.status === "IN_PROGRESS") {
      const board = await draftBoard(context.season, context.rules);
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

    // Who picks after this one. Sent so the client can poll faster when your
    // turn is imminent — computing the snake in the browser would duplicate
    // logic that already exists here, and a divergence would show up as the
    // room disagreeing with itself about whose pick it is.
    const onDeckTeamId =
      progress.currentPickNumber !== null && !progress.complete
        ? nextTeamOnClock(draft.order, progress.currentPickNumber, draft.rounds)
        : null;

    return NextResponse.json({
      // The server clock, so the room can measure the pick clock without
      // trusting the browser's absolute time. A machine whose clock is more
      // than one pick ahead would otherwise compute every deadline as already
      // passed and be locked out of manually picking for the whole draft.
      now: new Date().toISOString(),
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
        onDeckTeamId,
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
