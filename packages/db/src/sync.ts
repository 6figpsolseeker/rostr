/**
 * Provider data into Postgres.
 *
 * Every function here takes a `StatsProvider` rather than a concrete client, so
 * the sync logic is tested against a fake and never learns which provider is
 * behind it.
 *
 * All of it is idempotent. Syncs run on a schedule and re-run after failures;
 * anything that accumulated duplicates on a retry would corrupt a player pool
 * quietly.
 */

import type { StatsProvider } from "@rostr/stats";
import type { SqlClient } from "./client.js";
import { loadSportIds } from "./sports.js";

export interface SyncResult {
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
}

/** A provider that can also supply a draft board. Optional on the interface. */
export interface AdpCapableProvider extends StatsProvider {
  listAdp(rankingType?: string): Promise<{
    asOf: string;
    rankingType: string;
    entries: readonly {
      externalRef: string;
      fullName: string;
      overallMilli: number;
      positionRank: string | null;
    }[];
  }>;
}

/**
 * Insert or update players.
 *
 * A player already known is updated rather than duplicated — team changes and
 * retirements are the normal case across a season.
 *
 * Players whose position the sport does not define are skipped rather than
 * failing the whole sync. A provider adding a position we do not model should
 * not stop the other 500 players from updating.
 */
export async function syncPlayers(
  db: SqlClient,
  provider: StatsProvider,
  sportKey: string,
  season: number,
): Promise<SyncResult> {
  const ids = await loadSportIds(db, sportKey);
  const players = await provider.listPlayers(season);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const player of players) {
    const primary = player.positions[0];
    const positionId = primary ? ids.positionIds.get(primary) : undefined;

    if (!positionId || !player.fullName) {
      skipped++;
      continue;
    }

    const rows = await db.query<{ inserted: boolean }>(
      `INSERT INTO players
         (sport_id, external_ref, full_name, primary_position_id, team_ref, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (sport_id, external_ref) DO UPDATE
         SET full_name = EXCLUDED.full_name,
             primary_position_id = EXCLUDED.primary_position_id,
             team_ref = EXCLUDED.team_ref,
             active = EXCLUDED.active,
             updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        ids.sportId,
        player.externalRef,
        player.fullName,
        positionId,
        player.teamRef,
        player.active,
      ],
    );

    if (rows[0]?.inserted) inserted++;
    else updated++;

    // Eligibility is append-only; a player never loses a position they held.
    for (const position of player.positions) {
      const eligibleId = ids.positionIds.get(position);
      if (!eligibleId) continue;

      await db.query(
        `INSERT INTO player_eligible_positions (player_id, position_id)
         SELECT id, $3 FROM players WHERE sport_id = $1 AND external_ref = $2
         ON CONFLICT DO NOTHING`,
        [ids.sportId, player.externalRef, eligibleId],
      );
    }
  }

  return { inserted, updated, skipped };
}

/** Bye weeks for a season, keyed by team abbreviation. */
export async function syncByeWeeks(
  db: SqlClient,
  sportKey: string,
  season: number,
  byeWeeks: ReadonlyMap<string, number>,
): Promise<number> {
  const ids = await loadSportIds(db, sportKey);
  let written = 0;

  for (const [teamRef, week] of byeWeeks) {
    const rows = await db.query(
      `INSERT INTO player_seasons (player_id, season, team_ref, bye_week)
       SELECT id, $2, $3, $4 FROM players WHERE sport_id = $1 AND team_ref = $3
       ON CONFLICT (player_id, season) DO UPDATE
         SET team_ref = EXCLUDED.team_ref, bye_week = EXCLUDED.bye_week
       RETURNING id`,
      [ids.sportId, season, teamRef, week],
    );
    written += rows.length;
  }

  return written;
}

/**
 * Schedule.
 *
 * `kickoffAt` is the load-bearing field: lineup locks, the inactives job, and
 * the game watcher are all derived from it. A game whose kickoff the provider
 * did not supply is skipped rather than stored with a zero, which would lock
 * lineups at the epoch.
 */
export async function syncGames(
  db: SqlClient,
  provider: StatsProvider,
  sportKey: string,
  season: number,
  week?: number,
): Promise<SyncResult> {
  const ids = await loadSportIds(db, sportKey);
  const games = await provider.listGames(season, week);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const game of games) {
    if (!game.kickoffAt || !game.homeTeamRef || !game.awayTeamRef) {
      skipped++;
      continue;
    }

    const rows = await db.query<{ inserted: boolean }>(
      `INSERT INTO games
         (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at, status, final_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), $8, $9)
       ON CONFLICT (sport_id, external_ref) DO UPDATE
         SET week = EXCLUDED.week,
             kickoff_at = EXCLUDED.kickoff_at,
             status = EXCLUDED.status,
             final_at = COALESCE(games.final_at, EXCLUDED.final_at)
       RETURNING (xmax = 0) AS inserted`,
      [
        ids.sportId,
        game.externalRef,
        game.season,
        game.week,
        game.homeTeamRef,
        game.awayTeamRef,
        game.kickoffAt,
        game.status,
        game.status === "FINAL" ? new Date().toISOString() : null,
      ],
    );

    if (rows[0]?.inserted) inserted++;
    else updated++;
  }

  return { inserted, updated, skipped };
}

/**
 * The draft board.
 *
 * Rankings are stored per date rather than overwritten, so a draft stays
 * explicable from the board as it stood on the day it happened.
 *
 * A ranked player we have never seen is skipped: the provider ranks players the
 * player list may not carry yet, and inventing a row from a ranking would create
 * a draftable player with no position.
 */
export async function syncRankings(
  db: SqlClient,
  provider: AdpCapableProvider,
  sportKey: string,
  season: number,
  rankingType = "PPR",
): Promise<SyncResult & { asOf: string; unmatched: readonly string[] }> {
  const ids = await loadSportIds(db, sportKey);
  const board = await provider.listAdp(rankingType);

  let inserted = 0;
  let skipped = 0;
  // Named, not just counted. A count of 36 looked unremarkable; the names were
  // "every kicker in the league", which was a position-mapping bug that would
  // have shipped a draft board no team could field a lineup from.
  const unmatched: string[] = [];

  for (const entry of board.entries) {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO player_rankings
         (player_id, season, source, ranking_type, overall_milli, position_rank, as_of)
       SELECT id, $3, $4, $5, $6, $7, $8::date
         FROM players WHERE sport_id = $1 AND external_ref = $2
       ON CONFLICT (player_id, season, source, ranking_type, as_of) DO UPDATE
         SET overall_milli = EXCLUDED.overall_milli,
             position_rank = EXCLUDED.position_rank
       RETURNING id`,
      [
        ids.sportId,
        entry.externalRef,
        season,
        provider.name,
        board.rankingType,
        entry.overallMilli,
        entry.positionRank,
        board.asOf,
      ],
    );

    if (rows.length > 0) {
      inserted++;
    } else {
      skipped++;
      unmatched.push(`${entry.fullName} (${entry.positionRank ?? "?"})`);
    }
  }

  return { inserted, updated: 0, skipped, asOf: board.asOf, unmatched };
}

export interface DraftBoardEntry {
  readonly playerId: string;
  readonly externalRef: string;
  readonly fullName: string;
  readonly positions: readonly string[];
  /** Lower is better, as the draft engine expects. */
  readonly rank: number;
}

/**
 * The draft pool, ordered.
 *
 * Shaped to drop straight into the draft engine's `DraftablePlayer`. Players
 * with no ranking sort last but are still draftable — a late-round flier on
 * someone unranked is a legitimate pick, not an error.
 */
export async function loadDraftBoard(
  db: SqlClient,
  sportKey: string,
  season: number,
  options: { source?: string; rankingType?: string } = {},
): Promise<readonly DraftBoardEntry[]> {
  const ids = await loadSportIds(db, sportKey);

  const rows = await db.query<{
    id: string;
    external_ref: string;
    full_name: string;
    positions: string[];
    overall_milli: number | null;
  }>(
    `SELECT p.id,
            p.external_ref,
            p.full_name,
            array_agg(DISTINCT pos.key) AS positions,
            r.overall_milli
       FROM players p
       JOIN positions pos
         ON pos.id = p.primary_position_id
         OR pos.id IN (SELECT position_id FROM player_eligible_positions WHERE player_id = p.id)
       LEFT JOIN player_rankings_current r
         ON r.player_id = p.id
        AND r.season = $2
        AND r.source = COALESCE($3, r.source)
        AND r.ranking_type = COALESCE($4, r.ranking_type)
      WHERE p.sport_id = $1 AND p.active
      GROUP BY p.id, p.external_ref, p.full_name, r.overall_milli
      ORDER BY r.overall_milli NULLS LAST, p.full_name`,
    [ids.sportId, season, options.source ?? null, options.rankingType ?? null],
  );

  return rows.map((row, index) => ({
    playerId: row.id,
    externalRef: row.external_ref,
    fullName: row.full_name,
    positions: row.positions,
    // Dense 1..n ordering. The engine only compares ranks, so the ADP value
    // itself does not need to survive — but the ordering does.
    rank: index + 1,
  }));
}
