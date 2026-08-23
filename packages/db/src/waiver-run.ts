import type { SqlClient } from "./client.js";

/**
 * What happened in the last waiver run.
 *
 * `processWaivers` runs hourly, resolves every claim, moves priority and rewrites
 * rosters — and told nobody. A manager filed three claims on Monday and on
 * Wednesday found a player on their roster, or did not, with no account of
 * which claim won, which lost, or why. The rules make a specific promise about
 * how contests are decided; a promise nobody can watch being kept is the thing
 * this whole product exists to replace.
 *
 * **Read-only, and it computes nothing.** Every value here was written by the
 * run itself — the state, the reason, the priority the claim was filed at. A
 * screen that re-derived any of it would be re-deciding a settled outcome
 * against rosters that have since moved on.
 */

export interface WaiverRunClaim {
  readonly claimId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly addPlayerId: string;
  readonly addPlayerName: string;
  readonly dropPlayerId: string | null;
  readonly dropPlayerName: string | null;
  /** Where this team stood when the run began. Recorded, never recomputed. */
  readonly priorityAtClaim: number | null;
  readonly awarded: boolean;
  /** `null` on a winner, and on a loser from before `0039` recorded reasons. */
  readonly failureReason: string | null;
  readonly filedAt: string;
}

export interface WaiverRun {
  /** When the run settled. */
  readonly processedAt: string;
  readonly claims: readonly WaiverRunClaim[];
}

/**
 * The most recent settled run in this league.
 *
 * **Grouped by `processed_at`, not by date.** A run is one transaction and every
 * claim it settles carries the same timestamp, so this returns exactly one run
 * rather than "everything that happened on Wednesday" — which would merge a
 * re-run, and merging two runs would show a player awarded twice.
 *
 * `null` when the league has never had one, which is the ordinary state before
 * the first Wednesday of a season and is not an error.
 *
 * The whole league's claims, not just one team's. Waivers are decided *between*
 * teams — "somebody with better priority took him" is unverifiable if you can
 * only see your own row — and `RULES.md` makes the resolution public by design.
 * Who may look at all is `leagueReadAccess`'s question, asked by the route.
 */
export async function lastWaiverRun(
  db: SqlClient,
  leagueId: string,
): Promise<WaiverRun | null> {
  const [latest] = await db.query<{ processed_at: string }>(
    `SELECT processed_at FROM waiver_claims
      WHERE league_id = $1 AND processed_at IS NOT NULL
      ORDER BY processed_at DESC LIMIT 1`,
    [leagueId],
  );
  if (!latest) return null;

  const rows = await db.query<{
    id: string;
    team_id: string;
    team_name: string;
    add_player_id: string;
    add_player_name: string;
    drop_player_id: string | null;
    drop_player_name: string | null;
    priority_at_claim: number | null;
    state: string;
    failure_reason: string | null;
    created_at: string;
  }>(
    `SELECT c.id, c.team_id, t.name AS team_name,
            c.add_player_id, ap.full_name AS add_player_name,
            c.drop_player_id, dp.full_name AS drop_player_name,
            c.priority_at_claim, c.state, c.failure_reason, c.created_at
       FROM waiver_claims c
       JOIN teams t ON t.id = c.team_id
       JOIN players ap ON ap.id = c.add_player_id
       LEFT JOIN players dp ON dp.id = c.drop_player_id
      WHERE c.league_id = $1 AND c.processed_at = $2
      ORDER BY c.priority_at_claim NULLS LAST, c.created_at`,
    [leagueId, latest.processed_at],
  );

  return {
    processedAt: latest.processed_at,
    claims: rows.map((row) => ({
      claimId: row.id,
      teamId: row.team_id,
      teamName: row.team_name,
      addPlayerId: row.add_player_id,
      addPlayerName: row.add_player_name,
      dropPlayerId: row.drop_player_id,
      dropPlayerName: row.drop_player_name,
      priorityAtClaim: row.priority_at_claim,
      awarded: row.state === "AWARDED",
      failureReason: row.failure_reason,
      filedAt: row.created_at,
    })),
  };
}
