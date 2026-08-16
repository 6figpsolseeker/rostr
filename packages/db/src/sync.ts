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
import { PRIMARY_PROJECTION_SOURCE } from "./lineups.js";
import { loadSportIds } from "./sports.js";

export interface SyncResult {
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
}

/**
 * A provider that can supply bye weeks. Optional, like ADP and projections.
 *
 * `syncByeWeeks` takes the map rather than the provider, so this interface had
 * no reason to exist while `cli.ts` was the only caller — it holds a concrete
 * `Tank01Provider` and could simply call the method. `/api/cron/season-sync`
 * cannot: naming the concrete class there would undo the property that makes
 * every other sync provider-agnostic, which is what keeps swapping providers a
 * one-file change.
 */
export interface ByeCapableProvider {
  readonly name: string;
  listByeWeeks(season: number): Promise<ReadonlyMap<string, number>>;
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

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

type ProviderProjectionRow = {
  readonly externalRef: string;
  readonly fullName: string;
  readonly position: string;
  readonly stats: readonly { readonly statKey: string; readonly value: number }[];
};

export interface ProjectionCapableProvider {
  readonly name: string;
  listSeasonProjections(season: number): Promise<readonly ProviderProjectionRow[]>;
  listWeekProjections(season: number, week: number): Promise<readonly ProviderProjectionRow[]>;
}

/**
 * Week 0 is the season aggregate.
 *
 * The draft board asks "who is worth picking for the year"; the autofill asks
 * "who scores most this Sunday". Same table, same shape, different question —
 * and a sentinel rather than a nullable column, because Postgres treats NULLs
 * as distinct and the primary key would then permit two season projections from
 * one source for the same player.
 */
export const SEASON_AGGREGATE_WEEK = 0;

/**
 * Pull projections.
 *
 * Stored as **raw stats, never points** — see the migration. One provider call
 * covers every player and every team defense.
 *
 * `week` omitted, or `SEASON_AGGREGATE_WEEK`, pulls projected season totals for
 * the draft board. A real week pulls that week alone, which is what the autofill
 * ranks on.
 */
export async function syncProjections(
  db: SqlClient,
  provider: ProjectionCapableProvider,
  sportKey: string,
  season: number,
  week: number = SEASON_AGGREGATE_WEEK,
): Promise<SyncResult & { unmatched: readonly string[] }> {
  const ids = await loadSportIds(db, sportKey);
  const projections =
    week === SEASON_AGGREGATE_WEEK
      ? await provider.listSeasonProjections(season)
      : await provider.listWeekProjections(season, week);

  const statKeyIds = new Map(
    (
      await db.query<{ id: string; key: string }>(
        "SELECT id, key FROM stat_keys WHERE sport_id = $1",
        [ids.sportId],
      )
    ).map((row) => [row.key, row.id]),
  );

  // Every player in one query, not one query per player.
  //
  // A projection sync touches ~620 players and ~5,000 stat lines. Done a row at
  // a time against a hosted database that is 5,600 round trips at roughly 75ms
  // each — seven minutes, and it did not finish: the connection was dropped
  // partway through. Batched, it is a handful of statements.
  const playerIds = new Map(
    (
      await db.query<{ id: string; external_ref: string }>(
        "SELECT id, external_ref FROM players WHERE sport_id = $1",
        [ids.sportId],
      )
    ).map((row) => [row.external_ref, row.id]),
  );

  let skipped = 0;
  // Named rather than counted, for the same reason as the ranking sync: a bare
  // count of unmatched players once hid "every kicker in the league".
  const unmatched: string[] = [];

  const rows: { playerId: string; statKeyId: string; value: number }[] = [];

  for (const projection of projections) {
    const playerId = playerIds.get(projection.externalRef);
    if (!playerId) {
      unmatched.push(projection.fullName || projection.externalRef);
      skipped++;
      continue;
    }

    for (const stat of projection.stats) {
      const statKeyId = statKeyIds.get(stat.statKey);
      if (!statKeyId) {
        throw new Error(
          `Projection references unknown stat key "${stat.statKey}". ` +
            `The registry and the provider map have diverged.`,
        );
      }
      rows.push({ playerId, statKeyId, value: stat.value });
    }
  }

  let inserted = 0;
  let updated = 0;

  // Chunked rather than one enormous statement: Postgres caps a query at 65535
  // bind parameters, and five per row puts the ceiling around 13,000.
  const CHUNK = 500;

  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);

    const values = chunk
      .map((_, index) => {
        const base = index * 6;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
      })
      .join(", ");

    const params = chunk.flatMap((row) => [
      row.playerId,
      season,
      week,
      provider.name,
      row.statKeyId,
      row.value,
    ]);

    // The conflict target has to match the primary key exactly, and 0015 added
    // `week` to it. A stale target is not a subtle bug — Postgres refuses the
    // statement outright with "no unique or exclusion constraint matching".
    const result = await db.query<{ fresh: boolean }>(
      `INSERT INTO player_projections (player_id, season, week, source, stat_key_id, value)
       VALUES ${values}
       ON CONFLICT (player_id, season, week, source, stat_key_id)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING (xmax = 0) AS fresh`,
      params,
    );

    // `xmax = 0` distinguishes an insert from an update in an upsert, so a
    // re-run reports "refreshed" rather than claiming to have added rows that
    // were already there.
    for (const row of result) {
      if (row.fresh) inserted++;
      else updated++;
    }
  }

  return { inserted, updated, skipped, unmatched };
}

/**
 * Projected stat lines by player, ready for `scorePlayer`.
 *
 * Returns raw stats so the caller scores them with **its own league's rules**.
 * There is one definition of a point in this system and it is the league's.
 */
export async function loadProjections(
  db: SqlClient,
  sportKey: string,
  season: number,
  // **Defaults to one source, and that is a change.** This used to be
  // `COALESCE($3, p.source)` — omitting the argument meant *no filter*, so every
  // vendor's rows came back and the caller summed them. The draft board's only
  // call site omits it, so a second projections provider would have doubled the
  // numbers the board is sorted by. An optional filter that defaults to "all"
  // is not a filter; the caller who most needs it is the one who forgets.
  source: string = PRIMARY_PROJECTION_SOURCE,
  week: number = SEASON_AGGREGATE_WEEK,
): Promise<ReadonlyMap<string, readonly { statKey: string; value: number }[]>> {
  const ids = await loadSportIds(db, sportKey);

  const rows = await db.query<{ player_id: string; key: string; value: number }>(
    `SELECT p.player_id, k.key, p.value
       FROM player_projections p
       JOIN stat_keys k ON k.id = p.stat_key_id
      WHERE p.season = $1
        AND p.week = $4
        AND k.sport_id = $2
        AND p.source = $3`,
    [season, ids.sportId, source, week],
  );

  const byPlayer = new Map<string, { statKey: string; value: number }[]>();
  for (const row of rows) {
    const lines = byPlayer.get(row.player_id) ?? [];
    lines.push({ statKey: row.key, value: Number(row.value) });
    byPlayer.set(row.player_id, lines);
  }

  return byPlayer;
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

/**
 * The seasons the scheduled jobs have to cover.
 *
 * ## Why this is not `new Date().getFullYear()`
 *
 * That is what `cli.ts` does, and it is defensible there because an operator can
 * pass the season as an argument. In a cron there is no argument, and the
 * calendar answer is **wrong for the weeks that matter most**: the 2026 season's
 * championship is Week 17, played on 3 January 2027, inside a 168-hour
 * correction window that closes on the 10th. `getFullYear()` says 2027 for every
 * one of those days, so the stats job would query a season with no games,
 * ingest nothing, and the championship week would finalise on whatever was last
 * written — in a league that pays out on it.
 *
 * A calendar rule ("September to February belongs to the earlier year") would
 * fix that case and is still a rule about football sitting outside
 * `sports/nfl.ts`, invented here, with a boundary nobody has checked against a
 * real schedule.
 *
 * ## So it is read from the leagues themselves
 *
 * `leagues.season` is written at creation from the frozen, member-signed rule
 * set. A season is in play if some league is playing it. That needs no calendar
 * knowledge, is right on 3 January by construction, and — the part worth having
 * — costs nothing when no league exists: the answer is empty and the caller
 * makes no provider call at all. A metered API polled every ten minutes for a
 * season nobody is playing is a bill with no reader.
 *
 * ## Which states count, and why `FORMING` does
 *
 * Everything up to `SETTLED`. A league that has not drafted still needs its
 * schedule ingested — `weekHasSchedule` is false without `games` rows, so
 * `setLineup` refuses every lineup with `SCHEDULE_MISSING`, and the rows have to
 * exist *before* anyone tries. Waiting for `IN_SEASON` would mean the schedule
 * arrives after the first person needs it.
 *
 * `SETTLED` and `DISSOLVED` are excluded: nothing reads a settled league's
 * stats, and a finalised week is never rescored, so continuing to poll one is
 * spend with no effect. Note this means the correction sweep for a league's last
 * week stops when that league settles — which is the same instant its results
 * stop being able to change.
 *
 * Ordered, so a caller iterating them is deterministic and a failure in one
 * season does not reorder the next run's work.
 */
export async function seasonsInPlay(
  db: SqlClient,
  sportKey: string,
): Promise<readonly number[]> {
  const rows = await db.query<{ season: number }>(
    `SELECT DISTINCT l.season
       FROM leagues l
       JOIN sports s ON s.id = l.sport_id
      WHERE s.key = $1
        AND l.state IN ('FORMING', 'DRAFTING', 'IN_SEASON', 'PLAYOFFS')
      ORDER BY l.season`,
    [sportKey],
  );

  return rows.map((row) => Number(row.season));
}
