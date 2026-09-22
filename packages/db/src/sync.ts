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

import type { ProviderGame, StatsProvider } from "@rostr/stats";
import type { SqlClient } from "./client.js";
import { PRIMARY_PROJECTION_SOURCE, SEASON_AGGREGATE_WEEK } from "./lineups.js";
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

/**
 * A provider's ranking board for one scoring format.
 *
 * **One value, because the two halves are not independent.** A `ranking_type`
 * is a string in *that provider's* vocabulary: ours reads `"PPR"` because
 * Tank01's `adpType` does, and nothing obliges the next vendor to spell it the
 * same way or to publish a format split at all. A source without its format, or
 * a format without its source, names nothing.
 *
 * It is also the only shape that survives being handed to a reader. Two
 * adjacent `string` parameters typecheck when transposed and answer with an
 * empty board when they are — silently, because an empty board is a legal
 * board: 1,022 of 1,589 players carry no ADP at all. One argument cannot be
 * swapped with itself.
 */
export interface RankingBoard {
  /** The provider that published the ADP. Matched against `player_rankings.source`. */
  readonly source: string;
  /** The scoring format it assumes — `PPR`, `HALF`, `STANDARD`. */
  readonly rankingType: string;
}

/**
 * The board the draft room is ordered by.
 *
 * **Separate from `PRIMARY_PROJECTION_SOURCE` and `PRIMARY_STAT_SOURCE`, even
 * though one vendor satisfies all three today.** `lineups.ts` makes that
 * argument for the first pair and it goes a step further here: those two are
 * chosen for factual accuracy and for model quality. An ADP is neither. It is a
 * measurement of a crowd — whichever drafting population the provider happens
 * to observe — and the owner's 2026-09-21 ruling is what makes that the driver,
 * since the board is ordered by ADP precisely because a manager arrives with a
 * public board already in his head. The right vendor is the one whose rooms
 * look like the rooms our managers read, which is not a question about accuracy
 * and not a question about models.
 *
 * Coupling would cost in both directions. Tied to the projections source,
 * swapping model vendors for a better autofill would silently reorder every
 * draft board. Tied to the stats source, the board would inherit `RULES.md` §7's
 * two-provider agreement gate, which §7 is explicit an opinion can never pass.
 *
 * **Nothing makes this agree with `Tank01Provider.name` by construction.**
 * `@rostr/stats` depends only on `@rostr/core`, so the adapter cannot import
 * this, and no compiler will ever stand between a rename there and a blank
 * board here. `sync.test.ts` asserts the equality instead; that test is the
 * whole guard.
 */
export const PRIMARY_RANKING_BOARD: RankingBoard = {
  source: "tank01",
  rankingType: "PPR",
};

/** A provider that can also supply a draft board. Optional on the interface. */
export interface AdpCapableProvider extends StatsProvider {
  listAdp(rankingType?: string): Promise<{
    asOf: string;
    /** The format the provider spelled back. A check, never a stored value. */
    rankingTypeEcho: string;
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

    // The profile block, or every field null when the provider publishes none.
    //
    // `hasProfile` is what stops the second case erasing the first. A provider
    // that carries no profile data is stating *no opinion*, not "this player has
    // no face and no college" — so a players sync run from a secondary provider
    // must leave what the primary wrote alone. Within a profile, though, a null
    // is an assertion and does overwrite: a designation that clears when a
    // player recovers has to reach the column, or "Out" sticks to him forever.
    const profile = player.profile;
    const hasProfile = profile !== null;

    const rows = await db.query<{ inserted: boolean }>(
      `INSERT INTO players
         (sport_id, external_ref, full_name, primary_position_id, team_ref, active, updated_at,
          image_url, jersey_number, height_inches, weight_pounds, birth_date, college,
          draft_year, draft_round, draft_pick,
          injury_designation, injury_description, injury_return_date,
          second_source_ref)
       VALUES ($1, $2, $3, $4, $5, $6, now(),
               $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $20)
       ON CONFLICT (sport_id, external_ref) DO UPDATE
         SET full_name = EXCLUDED.full_name,
             primary_position_id = EXCLUDED.primary_position_id,
             team_ref = EXCLUDED.team_ref,
             active = EXCLUDED.active,
             updated_at = now(),
             image_url          = CASE WHEN $19 THEN EXCLUDED.image_url          ELSE players.image_url          END,
             jersey_number      = CASE WHEN $19 THEN EXCLUDED.jersey_number      ELSE players.jersey_number      END,
             height_inches      = CASE WHEN $19 THEN EXCLUDED.height_inches      ELSE players.height_inches      END,
             weight_pounds      = CASE WHEN $19 THEN EXCLUDED.weight_pounds      ELSE players.weight_pounds      END,
             birth_date         = CASE WHEN $19 THEN EXCLUDED.birth_date         ELSE players.birth_date         END,
             college            = CASE WHEN $19 THEN EXCLUDED.college            ELSE players.college            END,
             draft_year         = CASE WHEN $19 THEN EXCLUDED.draft_year         ELSE players.draft_year         END,
             draft_round        = CASE WHEN $19 THEN EXCLUDED.draft_round        ELSE players.draft_round        END,
             draft_pick         = CASE WHEN $19 THEN EXCLUDED.draft_pick         ELSE players.draft_pick         END,
             injury_designation = CASE WHEN $19 THEN EXCLUDED.injury_designation ELSE players.injury_designation END,
             injury_description = CASE WHEN $19 THEN EXCLUDED.injury_description ELSE players.injury_description END,
             injury_return_date = CASE WHEN $19 THEN EXCLUDED.injury_return_date ELSE players.injury_return_date END,
             -- Deliberately NOT behind the hasProfile gate the display fields
             -- sit behind. Those are guarded because a response carrying no
             -- profile block would erase a face we already had; this is a
             -- single field on the same response, and a provider that stops
             -- publishing it should stop the comparison rather than leave it
             -- joining on a key nobody asserts any more. Overwritten every
             -- sync, including back to NULL.
             second_source_ref = EXCLUDED.second_source_ref
       RETURNING (xmax = 0) AS inserted`,
      [
        ids.sportId,
        player.externalRef,
        player.fullName,
        positionId,
        player.teamRef,
        player.active,
        profile?.imageUrl ?? null,
        profile?.jerseyNumber ?? null,
        profile?.heightInches ?? null,
        profile?.weightPounds ?? null,
        profile?.birthDate ?? null,
        profile?.college ?? null,
        profile?.draft?.year ?? null,
        profile?.draft?.round ?? null,
        profile?.draft?.pick ?? null,
        profile?.injury?.designation ?? null,
        profile?.injury?.description ?? null,
        profile?.injury?.returnDate ?? null,
        hasProfile,
        player.secondSourceRef ?? null,
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
 * The earliest kickoff already known on each calendar date in a batch.
 *
 * The stand-in for a fixture the NFL has dated but not timed. It is derived from
 * the game's own dated siblings — for 27 December 2026, the 13:00 ET Sunday
 * slot — which is the earliest hour that fixture could possibly start.
 *
 * Derived rather than computed, deliberately. The obvious alternative is
 * midnight on `gameDate` in US Eastern, and that means getting EST against EDT
 * right by hand for a date months away. Hand-rolled calendar arithmetic has
 * already cost this repo a live bug (`latestWeekly`, where a week was assumed to
 * be 168 hours and is not across a clock change), and the sibling games carry
 * the answer with no arithmetic at all.
 *
 * A date whose games are *all* untimed yields nothing, and those fixtures stay
 * skipped. That keeps the change strictly additive: a game is only ever stored
 * when its lock time comes from data.
 */
function earliestKickoffByDate(games: readonly ProviderGame[]): ReadonlyMap<string, number> {
  const earliest = new Map<string, number>();

  for (const game of games) {
    if (game.kickoffTbd || game.gameDate === null || game.kickoffAt <= 0) continue;
    const known = earliest.get(game.gameDate);
    if (known === undefined || game.kickoffAt < known) {
      earliest.set(game.gameDate, game.kickoffAt);
    }
  }

  return earliest;
}

/**
 * Schedule.
 *
 * `kickoffAt` is the load-bearing field: lineup locks, the inactives job, and
 * the game watcher are all derived from it. A game whose kickoff the provider
 * did not supply is never stored with a zero, which would lock every lineup in
 * it at the epoch.
 *
 * ## A missing time is no longer a missing fixture
 *
 * It used to be, and the cost was measured rather than theorised: on 2026-08-17
 * the deployed database held 248 fixtures for weeks 1-17 against a correct 256,
 * four short in **each of weeks 16 and 17** — the playoff and championship
 * weeks. The NFL holds those kickoff times back for flex scheduling, so the
 * provider sends the date and both teams with `gameTime: "TBD"`, and all of it
 * was discarded for want of an hour. Players on those teams had no game, no stat
 * line, and therefore a permanent zero, with `weekHasSchedule` answering true
 * off the twelve games that did exist.
 *
 * Such a fixture is now stored with `kickoff_tbd` set and a **conservative**
 * kickoff from `earliestKickoffByDate`. Locking early is the safe direction: it
 * costs a manager some Sunday-morning flexibility, where the opposite error lets
 * someone start a player after watching him score.
 *
 * Screens must read `kickoff_tbd` and not present that timestamp as fact — in
 * particular, the clock passing it does not mean the game has started.
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
  const earliest = earliestKickoffByDate(games);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const game of games) {
    if (!game.homeTeamRef || !game.awayTeamRef) {
      skipped++;
      continue;
    }

    // A real time wins outright. Otherwise stand in the earliest kickoff known
    // on the same date, and only if there is one.
    const standIn = game.gameDate === null ? undefined : earliest.get(game.gameDate);
    const kickoffAt = game.kickoffAt > 0 ? game.kickoffAt : (standIn ?? 0);
    const kickoffTbd = game.kickoffAt <= 0;

    if (kickoffAt <= 0) {
      skipped++;
      continue;
    }

    const rows = await db.query<{ inserted: boolean }>(
      `INSERT INTO games
         (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at, kickoff_tbd, status, final_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), $8, $9, $10)
       ON CONFLICT (sport_id, external_ref) DO UPDATE
         SET week = EXCLUDED.week,
             kickoff_at = EXCLUDED.kickoff_at,
             kickoff_tbd = EXCLUDED.kickoff_tbd,
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
        kickoffAt,
        kickoffTbd,
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
  // One literal, shared with the reader. Two constants that happen to agree is
  // how a draft board goes blank on a Sunday.
  rankingType: string = PRIMARY_RANKING_BOARD.rankingType,
): Promise<
  SyncResult & {
    asOf: string;
    unmatched: readonly string[];
    /** The provider's spelling when it disagreed with ours. Null when it matched. */
    rankingTypeEcho: string | null;
  }
> {
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
        // **Ours, not the provider's echo — #307.** This used to be
        // `board.rankingType`, i.e. `raw.adpType ?? rankingType` from the
        // adapter, so a key column the draft board matches exactly held a
        // string the vendor controlled. `getNFLADP` answering "ppr" one morning
        // would have split every player across two ranking types, and the
        // loader's `COALESCE` would then have returned each of them twice.
        // The echo is a check now; see the return value.
        rankingType,
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

  return {
    inserted,
    updated: 0,
    skipped,
    asOf: board.asOf,
    unmatched,
    /*
      Reported, because normalising discards information and a vendor that has
      changed its vocabulary is a fact somebody should act on.

      It belongs in `last_outcome` rather than a run note, and the distinction
      matters: migration `0049` rejected a second `cron_runs` column for #323 on
      the grounds that the next tick overwrites it exactly as `last_outcome`
      does. That argument is about a **one-shot** fact. An echo mismatch is not
      one — if the vendor renamed its format today it is still renamed tomorrow,
      so it re-fires every run and survives the overwrite by being true again.

      That also makes it a legitimate red. The rule this repo settled after #325
      is that every note is an alarm, so the test is whether there is something
      a person should go and do. There is: decide whether our constant or the
      vendor's spelling is now right.
    */
    rankingTypeEcho: board.rankingTypeEcho === rankingType ? null : board.rankingTypeEcho,
  };
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

/**
 * The thumbnail a screen needs beside a player's name.
 *
 * Not the whole profile — the board sends a thousand of these on one request,
 * and height, college and draft position are read one player at a time from
 * `loadPlayerProfile` when somebody opens a card. What is here is what a row
 * shows: a face, a shirt, a bye, and whether he is hurt.
 */
export interface PlayerSummary {
  /** Absolute, provider-published. Null renders as initials. */
  readonly imageUrl: string | null;
  /** The club, not the fantasy team — "DAL". Null for a free agent. */
  readonly teamRef: string | null;
  /** This season's bye. Null when the schedule has not been synced. */
  readonly byeWeek: number | null;
  /** The provider's own wording. Null when fit. */
  readonly injuryDesignation: string | null;
}

export interface DraftBoardEntry {
  readonly playerId: string;
  readonly externalRef: string;
  readonly fullName: string;
  readonly positions: readonly string[];
  /**
   * Whether his NFL club still has him.
   *
   * **Not folded into `rank` any more.** It was this query's first sort key
   * from 2026-09-16 until 2026-09-22, on the reasoning that
   * `player_rankings_current` never expires a row, so a cut player keeps the
   * ADP he held while he was playing and un-filtering would float him near the
   * top. Measured against production on 2026-09-22, that top never arrives: the
   * provider goes on ranking a released player and goes on ranking him worse.
   * See `docs/DATA-MODEL.md` for the queries and the numbers.
   *
   * Still selected, still returned, and still required — by the club label, the
   * bye chip, the queue's release note, and by `autoPick`, which re-applies the
   * demotion as an explicit key of its own because its endgame scans one
   * position at a time and has no 180-pick margin to hide behind. Deleting this
   * clause without that guard would have changed what bots draft while changing
   * nothing anybody could see.
   *
   * Deliberately not in `summary`. That block is display-only by contract, and
   * the draft context reads this.
   */
  readonly active: boolean;
  /** Lower is better, as the draft engine expects. */
  readonly rank: number;
  /**
   * The provider's average draft position, in milli-units — `3.2` is `3200`.
   * Null when nobody has published one, which on the 2026 board is 1,022 of
   * 1,589 players.
   *
   * Distinct from `rank`, and the distinction is the point: `rank` is this
   * board's dense index and every unranked player still gets one. Printing it
   * under a column headed "ADP" invented a crowd's opinion for two rows in
   * three.
   */
  readonly adpMilli: number | null;
  /** Display only. Nothing in the draft engine reads it. */
  readonly summary: PlayerSummary;
}

/**
 * The draft pool, ordered.
 *
 * Shaped to drop straight into the draft engine's `DraftablePlayer`. Players
 * with no ranking sort last but are still draftable — a late-round flier on
 * someone unranked is a legitimate pick, not an error.
 *
 * ## A player his club has cut stays on the board, priced where the provider prices him
 *
 * `players.active` is cleared by the daily sync for anyone the provider reports
 * as an NFL free agent. It used to be a **filter**, and that decided a rules
 * question by omission — a drafted player cut overnight vanished from the room
 * rendering his name (#275) and from the pool trying to award him (#238), while
 * `addFreeAgent` went on accepting him, because `availabilityOf` has never read
 * this column. Three doors, three answers. The owner ruled on 2026-09-16: keep
 * him acquirable, and on a draft board put him at the bottom.
 *
 * It was therefore the **first sort key** from 2026-09-16 until 2026-09-22, on
 * the reasoning that `player_rankings_current` is `DISTINCT ON … as_of DESC`
 * and nothing ever expires a row, so a star cut in September still carries
 * July's ADP and un-filtering alone would put him near the *top*.
 *
 * **That top was measured on 2026-09-22 and it does not exist.** The provider
 * does not stop ranking a released player; it keeps ranking him, worse every
 * week. The best ADP held by anyone with no NFL club was 249.0, against a
 * 12-team 15-round draft that ends at pick 180. Tyreek Hill sat at 297.4 with
 * an `as_of` of the previous day — current, not frozen. So the key came out and
 * the `ORDER BY` runs on ADP alone, with `p.full_name` last so a re-run numbers
 * the pool identically. `docs/DATA-MODEL.md` carries the queries; re-run them
 * rather than re-deriving this from the schema, which is how the demotion got
 * argued for twice.
 *
 * **`rank` renumbers for the whole board, and that is new.** The old key made
 * the change an append — active ranks were untouched and cut players took the
 * tail. Removing it moves everybody. `rank` stays a dense index over this array
 * either way, consumed only by comparison, so `OFF_BOARD_RANK` in `draft.ts`
 * still depends only on its finiteness.
 *
 * **What is *not* inherited any more: `autoPick`'s refusal to spend an absent
 * manager's pick on a player with no club.** That rode entirely on this clause
 * — `autopick.ts` sorted on bare `rank` — and its endgame scans one position at
 * a time, where the 180-pick margin that makes the screen safe does not exist.
 * It now demotes explicitly. Do not "simplify" that away on the grounds that
 * the board handles it. The board stopped.
 *
 * **Dense over players, since #307.** It was dense only over *rows*: the
 * ranking join used `COALESCE($3, r.source)`, which filters nothing when the
 * argument is omitted, and all ten call sites omit it — so a player with two
 * ranking sources came back twice, at two different ADPs, and the pool Maps
 * downstream kept whichever landed last. It was measured latent rather than
 * assumed latent (one combination, zero doubled players) and left unfixed
 * because a default that failed to match what `syncRankings` writes would empty
 * every ADP on the live board.
 *
 * What made that safe to fix was removing the way the two could disagree.
 * `syncRankings` stored the provider's echoed `adpType` in `ranking_type` — a
 * key column holding a string the vendor controlled. It now stores the format
 * *we asked for* and reports any disagreement, so the reader's default can only
 * be wrong if `Tank01Provider.name` drifts from `PRIMARY_RANKING_BOARD.source`,
 * which is one string equality and has a test.
 *
 * The residual worth knowing: the filter is exact, so a board synced under some
 * *other* source is invisible here rather than blended in. That is deliberate —
 * `syncRankings`' fifth parameter can write a `HALF` board, and a fallback that
 * surfaced those rows would mix scoring formats into one ADP column with
 * nothing on screen saying so.
 */
export async function loadDraftBoard(
  db: SqlClient,
  sportKey: string,
  season: number,
  /*
    **Defaults to one board, and that is the fix for #307.**

    This used to be `{ source?, rankingType? }` matched with
    `COALESCE($3, r.source)` — so omitting the argument meant *no filter*, and
    all ten call sites in this repo omit it. A player carrying two sources came
    back as two entries, `rank` stopped meaning "the Nth best player", and the
    pool Maps downstream silently kept whichever row landed last. An optional
    filter that defaults to "all" is not a filter; the caller who most needs it
    is the one who forgets. `loadProjections` above carries the same argument,
    having had the same defect.

    **One argument rather than two, because two bare strings transpose
    silently.** `loadDraftBoard(db, "nfl", 2026, "PPR", "tank01")` typechecks,
    matches nothing, and returns a legal board of 1,589 null ADPs.

    The filter is now exact on `(season, source, ranking_type)`, which with the
    join on `player_id` is precisely `player_rankings_current`'s own
    `DISTINCT ON` key — so at most one row can match, by the view's uniqueness
    rather than by this query's care.
  */
  board: RankingBoard = PRIMARY_RANKING_BOARD,
): Promise<readonly DraftBoardEntry[]> {
  const ids = await loadSportIds(db, sportKey);

  const rows = await db.query<{
    id: string;
    external_ref: string;
    full_name: string;
    positions: string[];
    active: boolean;
    overall_milli: number | null;
    image_url: string | null;
    team_ref: string | null;
    bye_week: number | null;
    injury_designation: string | null;
  }>(
    `SELECT p.id,
            p.external_ref,
            p.full_name,
            array_agg(DISTINCT pos.key) AS positions,
            p.active,
            r.overall_milli,
            p.image_url,
            p.team_ref,
            -- A bye is a fact about the club, and player_seasons is where the
            -- sync writes it. Left joined, so a season nobody has synced reads
            -- null rather than dropping every player off the board.
            ps.bye_week,
            p.injury_designation
       FROM players p
       JOIN positions pos
         ON pos.id = p.primary_position_id
         OR pos.id IN (SELECT position_id FROM player_eligible_positions WHERE player_id = p.id)
       LEFT JOIN player_seasons ps
         ON ps.player_id = p.id
        AND ps.season = $2
       LEFT JOIN player_rankings_current r
         ON r.player_id = p.id
        AND r.season = $2
        AND r.source = $3
        AND r.ranking_type = $4
      WHERE p.sport_id = $1
      GROUP BY p.id, p.external_ref, p.full_name, p.active, r.overall_milli,
               p.image_url, p.team_ref, ps.bye_week, p.injury_designation
      ORDER BY r.overall_milli NULLS LAST, p.full_name`,
    [ids.sportId, season, board.source, board.rankingType],
  );

  return rows.map((row, index) => ({
    playerId: row.id,
    externalRef: row.external_ref,
    fullName: row.full_name,
    positions: row.positions,
    active: row.active,
    // Dense 1..n ordering. The engine only compares ranks, so the ADP value
    // does not need to survive for *it* — but the screen prints the real
    // number beside this one, and they are different facts. See `adpMilli`.
    rank: index + 1,
    adpMilli: row.overall_milli === null ? null : Number(row.overall_milli),
    summary: {
      imageUrl: row.image_url,
      teamRef: row.team_ref,
      byeWeek: row.bye_week === null ? null : Number(row.bye_week),
      injuryDesignation: row.injury_designation,
    },
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
