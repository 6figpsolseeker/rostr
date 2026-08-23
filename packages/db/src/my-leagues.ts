/**
 * The leagues you are in.
 *
 * The gap drop 8 named, and it has been open since the commissioner's checklist
 * landed: nothing anywhere listed the leagues you had already joined, so a
 * returning manager's only route back was browser history. `/leagues` browsed
 * *public* leagues, which are by definition the ones you are not in.
 *
 * ## What this returns and what it deliberately does not
 *
 * Every field here is one cheap join away from `league_memberships`. The design
 * also draws a record, a standings position, and whether your lineup is set —
 * all three are real facts, and all three cost a standings computation or a
 * kickoff lookup **per league** on a page that renders on every visit.
 *
 * They are left out rather than approximated. A hub that showed a stale or
 * guessed record would be worse than one that shows none: the standings screen
 * is one click away and is the thing that owns that number.
 *
 * What is here is what the row needs to be useful — which league, what state,
 * how big, and the single most pressing thing about it.
 */

import { pickPosition } from "@rostr/core";
import type { SqlClient } from "./client.js";

export interface MyLeague {
  readonly leagueId: string;
  readonly name: string;
  readonly season: number;
  /** `FORMING`, `DRAFTING`, `IN_SEASON`, `PLAYOFFS`, `SETTLED`, `DISSOLVED`. */
  readonly state: string;
  readonly teamCount: number;
  /** This user's team in that league. */
  readonly teamId: string;
  readonly teamName: string;
  /** Unix seconds, from the frozen rules by way of the draft row. */
  readonly draftScheduledAt: number | null;
  readonly draftStatus: string | null;
  readonly rounds: number | null;
  /** 1-based, or null when the draft has not started. */
  readonly currentRound: number | null;
  /**
   * Whether the pick on the clock is this user's.
   *
   * The one urgent fact on this page with a real source behind it. The design's
   * urgent strip also wants "veto window closing", "lineup unset near kickoff"
   * and "waivers running"; none of those has a route today, and this one does —
   * so it is the only one built.
   */
  readonly onTheClock: boolean;
}

/**
 * Whether the pick on the clock belongs to this team.
 *
 * **Asked of `pickPosition`, never worked out here.** The draft has one
 * implementation of the snake and it lives in `@rostr/core`; a second one — in
 * SQL or in this file — is the failure this repo names by hand, because the
 * first time the two disagreed a hub would tell somebody their pick was live
 * while the draft room said otherwise.
 *
 * `draft_position` is 1-based and `orderIndex` is 0-based, which is the only
 * arithmetic here.
 */
function onTheClock(
  status: string | null,
  picksMade: number | null,
  teamCount: number,
  draftPosition: number | null,
): boolean {
  if (status !== "IN_PROGRESS") return false;
  if (picksMade === null || draftPosition === null || teamCount === 0) return false;

  const { orderIndex } = pickPosition(picksMade + 1, teamCount);
  return orderIndex === draftPosition - 1;
}

/**
 * Leagues this user has joined, most recently joined first.
 *
 * Membership rather than team ownership is the source: a `league_memberships`
 * row is the record of consent — the signature over the rules hash — and it is
 * what every other league-scoped read keys on. A team with an `owner_id` and no
 * membership row is not a state this app can produce.
 */
export async function leaguesForUser(
  db: SqlClient,
  userId: string,
): Promise<readonly MyLeague[]> {
  const rows = await db.query<{
    league_id: string;
    name: string;
    season: number;
    state: string;
    team_count: number;
    team_id: string;
    team_name: string;
    scheduled_at: string | null;
    draft_status: string | null;
    rounds: number | null;
    picks_made: number | null;
    draft_position: number | null;
  }>(
    `SELECT l.id AS league_id,
            l.name,
            l.season,
            l.state,
            (SELECT count(*)::int FROM teams t WHERE t.league_id = l.id) AS team_count,
            m.team_id,
            mt.name AS team_name,
            d.scheduled_at,
            d.status AS draft_status,
            d.rounds,
            -- The round is derived from how many picks exist, not stored. One
            -- fewer thing that can disagree with the picks themselves.
            (SELECT count(*)::int FROM draft_picks p WHERE p.draft_id = d.id) AS picks_made,
            mt.draft_position
       FROM league_memberships m
       JOIN leagues l ON l.id = m.league_id
       JOIN teams mt ON mt.id = m.team_id
       LEFT JOIN drafts d ON d.league_id = l.id
      WHERE m.user_id = $1
      ORDER BY m.joined_at DESC`,
    [userId],
  );

  return rows.map((row) => {
    const teamCount = Number(row.team_count);
    const picksMade = row.picks_made === null ? null : Number(row.picks_made);
    const rounds = row.rounds === null ? null : Number(row.rounds);

    return {
      leagueId: row.league_id,
      name: row.name,
      season: Number(row.season),
      state: row.state,
      teamCount,
      teamId: row.team_id,
      teamName: row.team_name,
      draftScheduledAt: row.scheduled_at
        ? Math.floor(new Date(row.scheduled_at).getTime() / 1000)
        : null,
      draftStatus: row.draft_status,
      rounds,
      // The engine's answer for the pick about to be made, rather than
      // arithmetic repeated here. Guarded on a non-empty field: `pickPosition`
      // throws below one team, and a league whose seats were all removed before
      // the draw should read as "no round yet" rather than raise.
      currentRound:
        picksMade === null || teamCount === 0 || row.draft_status !== "IN_PROGRESS"
          ? null
          : pickPosition(picksMade + 1, teamCount).round,
      onTheClock: onTheClock(row.draft_status, picksMade, teamCount, row.draft_position),
    };
  });
}
