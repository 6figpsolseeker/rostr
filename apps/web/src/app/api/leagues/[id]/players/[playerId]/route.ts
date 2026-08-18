import { NextResponse } from "next/server";
import { indexScoringRules, scorePlayer } from "@rostr/core";
import { loadPlayerProfile } from "@rostr/db";
import { db } from "@/lib/db";
import { leagueReadForbidden } from "@/lib/league-read";
import { draftContext, DraftContextError } from "@/lib/draft-context";

/**
 * One player, in full.
 *
 * The click-through behind every name in the app. Separate from the draft board
 * because the board sends a thousand players at once and this sends one, so it
 * can afford the joins and the game log the board could not.
 *
 * **League-scoped rather than global, and not because of the biography.** A
 * player's height is the same in every league; his points are not. Every number
 * on this response is scored with *this* league's frozen rules, so the same man
 * opened from two leagues reads differently — which is the honest answer, and
 * the reason there is no `/api/players/[id]`.
 *
 * It is gated by `leagueReadForbidden` for the same reason the standings are:
 * `visibility` is a frozen, member-signed rule, and a private league's player
 * pages are as much a report of how it is going as its scoreboard.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; playerId: string }> },
): Promise<NextResponse> {
  const { id, playerId } = await params;

  // `visibility` is a frozen, member-signed rule. See `lib/visibility.ts`.
  const forbidden = await leagueReadForbidden(id);
  if (forbidden) return forbidden;

  try {
    const context = await draftContext(id);
    const client = db();

    const profile = await loadPlayerProfile(client, playerId, context.season);
    // A 404 rather than an empty card. The id comes from a URL, so a stale link
    // is ordinary — and a card rendering every field as a dash is
    // indistinguishable from a player whose profile has never been synced.
    if (!profile) {
      return NextResponse.json({ error: "No such player" }, { status: 404 });
    }

    const scoring = indexScoringRules(context.rules.scoring);

    /**
     * Who holds him here, or null if he is free.
     *
     * Read from `roster_entries` rather than from the draft: a player acquired
     * on waivers or in a trade is just as rostered as one who was drafted, and
     * a card that only knew about draft picks would call him free from week 2
     * onwards. `released_at IS NULL` is what makes it current rather than
     * historical — the table is append-only precisely so a past week's roster
     * stays reconstructible.
     */
    const [owner] = await client.query<{ team_id: string; team_name: string }>(
      `SELECT t.id AS team_id, t.name AS team_name
         FROM roster_entries r
         JOIN teams t ON t.id = r.team_id
        WHERE r.league_id = $1 AND r.player_id = $2 AND r.released_at IS NULL
        LIMIT 1`,
      [id, playerId],
    );

    return NextResponse.json({
      player: {
        id: profile.playerId,
        name: profile.fullName,
        positions: profile.positions,
        teamRef: profile.teamRef,
        imageUrl: profile.imageUrl,
        byeWeek: profile.byeWeek,
        bio: profile.bio,
        injury: profile.injury,
      },
      /**
       * The season so far, scored with this league's rules.
       *
       * Points are computed here rather than stored, from the raw stat lines
       * `loadPlayerProfile` hands back. That is the same arithmetic
       * `resolveWeek` runs — one `scorePlayer`, one scoring index — so a card
       * cannot report a week differently from the scoreboard that settled it.
       */
      weeks: profile.weeks.map((week) => ({
        week: week.week,
        opponent: week.opponent,
        gameStatus: week.gameStatus,
        milliPoints: scorePlayer(week.stats, scoring),
        stats: week.stats,
      })),
      ownedBy: owner ? { teamId: owner.team_id, teamName: owner.team_name } : null,
      /** So the card can say "your team" rather than naming you to yourself. */
      myTeamId: context.myTeamId,
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
