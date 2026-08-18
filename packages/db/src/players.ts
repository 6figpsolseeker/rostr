/**
 * One player, in as much detail as a screen ever needs.
 *
 * Everything here is display data. **Nothing in this file is read by scoring, by
 * the draft engine, by a lineup lock or by settlement**, and that is a property
 * worth keeping rather than a coincidence: the profile columns are refreshed
 * wholesale on every sync with no revision history, so a rule that came to
 * depend on one would be depending on a value that can change silently. Numbers
 * that decide anything come from `stat_lines_current`, which is versioned and
 * sourced — and which is why the weekly lines below are handed back raw rather
 * than as points.
 *
 * The split from `loadDraftBoard` is deliberate. The board sends a thousand
 * players on one request and carries only what a row shows; this is the
 * click-through, one player at a time, and can afford the joins.
 */

import type { StatLine } from "@rostr/core";
import type { SqlClient } from "./client.js";
// One source, and the same constant the scoring cron reads. See its docstring
// there for why the projections source is a separate choice from this one.
import { PRIMARY_STAT_SOURCE } from "./lineups.js";

/** A player's biography. Every field is nullable — see migration `0032`. */
export interface PlayerBio {
  readonly jerseyNumber: string | null;
  readonly heightInches: number | null;
  readonly weightPounds: number | null;
  /**
   * ISO `YYYY-MM-DD`.
   *
   * The date rather than an age, so the number a screen prints is computed
   * against the day somebody is reading it. An age column would be wrong from
   * the day after it was written and nothing would ever notice.
   */
  readonly birthDate: string | null;
  readonly college: string | null;
  readonly draft: {
    readonly year: number;
    readonly round: number;
    readonly pick: number;
  } | null;
}

/** What the provider says about a player's fitness. Never a lineup rule. */
export interface PlayerInjury {
  readonly designation: string;
  readonly description: string | null;
  readonly returnDate: string | null;
}

/** One week's raw stat line, for a caller that will score it with league rules. */
export interface PlayerWeek {
  readonly week: number;
  readonly stats: readonly StatLine[];
  /** The opponent's club, prefixed `@` when away. Null when no game was found. */
  readonly opponent: string | null;
  /** `SCHEDULED`, `IN_PROGRESS`, `FINAL`… Null when no game was found. */
  readonly gameStatus: string | null;
}

export interface PlayerProfile {
  readonly playerId: string;
  readonly fullName: string;
  readonly positions: readonly string[];
  /** The club, not the fantasy team. */
  readonly teamRef: string | null;
  readonly imageUrl: string | null;
  readonly byeWeek: number | null;
  readonly bio: PlayerBio;
  readonly injury: PlayerInjury | null;
  /**
   * Every week with a stat line, ascending.
   *
   * **Raw stats, never points.** Two managers in two leagues looking at the same
   * player must each see him scored by their own frozen rules, and the surest
   * way to guarantee that is for this layer to hold no scoring table at all.
   * The caller folds `scorePlayer` over these with the rules it already has.
   */
  readonly weeks: readonly PlayerWeek[];
}

/**
 * Load one player, or `null` if there is no such player.
 *
 * `null` rather than a throw: the id arrives from a URL, and a stale link is an
 * ordinary event that deserves a 404 rather than a 500.
 */
export async function loadPlayerProfile(
  db: SqlClient,
  playerId: string,
  season: number,
  source: string = PRIMARY_STAT_SOURCE,
): Promise<PlayerProfile | null> {
  const rows = await db.query<{
    id: string;
    full_name: string;
    positions: string[];
    team_ref: string | null;
    image_url: string | null;
    jersey_number: string | null;
    height_inches: number | null;
    weight_pounds: number | null;
    birth_date: string | Date | null;
    college: string | null;
    draft_year: number | null;
    draft_round: number | null;
    draft_pick: number | null;
    injury_designation: string | null;
    injury_description: string | null;
    injury_return_date: string | Date | null;
    bye_week: number | null;
  }>(
    `SELECT p.id,
            p.full_name,
            array_agg(DISTINCT pos.key) AS positions,
            p.team_ref,
            p.image_url,
            p.jersey_number,
            p.height_inches,
            p.weight_pounds,
            p.birth_date,
            p.college,
            p.draft_year,
            p.draft_round,
            p.draft_pick,
            p.injury_designation,
            p.injury_description,
            p.injury_return_date,
            ps.bye_week
       FROM players p
       JOIN positions pos
         ON pos.id = p.primary_position_id
         OR pos.id IN (SELECT position_id FROM player_eligible_positions WHERE player_id = p.id)
       LEFT JOIN player_seasons ps
         ON ps.player_id = p.id
        AND ps.season = $2
      WHERE p.id = $1
      GROUP BY p.id, ps.bye_week`,
    [playerId, season],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    playerId: row.id,
    fullName: row.full_name,
    positions: row.positions,
    teamRef: row.team_ref,
    imageUrl: row.image_url,
    byeWeek: row.bye_week === null ? null : Number(row.bye_week),
    bio: {
      jerseyNumber: row.jersey_number,
      heightInches: row.height_inches === null ? null : Number(row.height_inches),
      weightPounds: row.weight_pounds === null ? null : Number(row.weight_pounds),
      birthDate: isoDay(row.birth_date),
      college: row.college,
      draft:
        row.draft_year === null || row.draft_round === null || row.draft_pick === null
          ? null
          : {
              year: Number(row.draft_year),
              round: Number(row.draft_round),
              pick: Number(row.draft_pick),
            },
    },
    injury:
      row.injury_designation === null
        ? null
        : {
            designation: row.injury_designation,
            description: row.injury_description,
            returnDate: isoDay(row.injury_return_date),
          },
    weeks: await loadPlayerWeeks(db, playerId, season, source),
  };
}

/**
 * A `date` column as `YYYY-MM-DD`, whatever shape the driver handed back.
 *
 * PGlite gives a `Date`, node-postgres gives a string, and only the calendar day
 * is ever wanted — so this trims rather than routing through a timezone, where
 * a birthday one hour into the morning UTC would render as the day before for
 * anyone west of it.
 */
function isoDay(value: string | Date | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

/**
 * The season to date, week by week.
 *
 * Reads `stat_lines_current`, so a correction that arrived as a new revision is
 * what shows and the superseded one is not — the same view the scoring cron
 * reads, for the same reason.
 *
 * **Filtered to one source.** The view keys on source as well as revision, so
 * two providers covering the same player are two rows, and an unfiltered read
 * would show him having caught every pass twice.
 */
async function loadPlayerWeeks(
  db: SqlClient,
  playerId: string,
  season: number,
  source: string,
): Promise<readonly PlayerWeek[]> {
  const rows = await db.query<{
    week: number;
    key: string;
    value: number;
    opponent: string | null;
    game_status: string | null;
  }>(
    `SELECT s.week,
            k.key,
            s.value,
            CASE
              WHEN g.home_team_ref = p.team_ref THEN g.away_team_ref
              WHEN g.away_team_ref = p.team_ref THEN '@' || g.home_team_ref
            END AS opponent,
            g.status AS game_status
       FROM stat_lines_current s
       JOIN players p ON p.id = s.player_id
       JOIN stat_keys k ON k.id = s.stat_key_id
       LEFT JOIN games g
         ON g.sport_id = p.sport_id
        AND g.season = s.season
        AND g.week = s.week
        AND (g.home_team_ref = p.team_ref OR g.away_team_ref = p.team_ref)
      WHERE s.player_id = $1 AND s.season = $2 AND s.source = $3
      ORDER BY s.week`,
    [playerId, season, source],
  );

  const byWeek = new Map<
    number,
    { stats: StatLine[]; opponent: string | null; status: string | null }
  >();

  for (const row of rows) {
    const week = Number(row.week);
    const entry = byWeek.get(week) ?? {
      stats: [],
      opponent: row.opponent,
      status: row.game_status,
    };
    entry.stats.push({ statKey: row.key, value: Number(row.value) });
    byWeek.set(week, entry);
  }

  return [...byWeek.entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, entry]) => ({
      week,
      stats: entry.stats,
      opponent: entry.opponent,
      gameStatus: entry.status,
    }));
}
