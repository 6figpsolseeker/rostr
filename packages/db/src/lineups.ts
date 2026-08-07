/**
 * Lineups, persisted.
 *
 * The rules live in `@rostr/core` — what is legal, what is locked, what the
 * autolineup picks. This module supplies them with facts out of Postgres and
 * writes back the result. It decides nothing.
 *
 * ## The lock is enforced here, not just displayed
 *
 * A UI that greys out a locked slot is a courtesy. The check that matters is
 * this one, because it is the one a crafted request has to get past. `setLineup`
 * loads what is currently stored, works out which slots have kicked off, and
 * refuses any change to them — so starting a player after seeing him score is
 * rejected regardless of what the client believed.
 *
 * ## A team always has a lineup by kickoff
 *
 * `resolveWeek` throws if a scheduled team has no lineup, deliberately: scoring
 * a missing team as zero would hand its opponent a free win. `ensureLineups`
 * is what makes that condition true — it fills anything unset with the
 * deterministic autolineup before the week is scored.
 */

import {
  autolineup,
  buildRosterShape,
  indexScoringRules,
  lockedAssignments,
  NFL,
  scorePlayer,
  seasonAverage,
  startingSlots,
  validateLineup,
} from "@rostr/core";
import type {
  AutolineupCandidate,
  LeagueRules,
  LineupAssignment,
  LineupPlayer,
  LineupProblem,
  StatLine,
  TeamLineup,
} from "@rostr/core";
import type { SqlClient } from "./client.js";
import { getLeagueRules } from "./leagues.js";
import { withTransaction } from "./transaction.js";

export class LineupError extends Error {
  constructor(
    message: string,
    readonly code:
      "LEAGUE_NOT_FOUND" | "TEAM_NOT_IN_LEAGUE" | "INVALID_LINEUP" | "SLOT_TYPE_UNKNOWN",
    readonly problems: readonly LineupProblem[] = [],
  ) {
    super(message);
    this.name = "LineupError";
  }
}

// ---------------------------------------------------------------------------
// Reading the roster
// ---------------------------------------------------------------------------

/**
 * A team's active roster for a week, with each player's kickoff.
 *
 * `kickoffAt` is `null` when the player's NFL team has no game that week — a
 * bye. That is what stops the slot ever locking, since there is no game to have
 * started.
 */
export async function loadRosterForWeek(
  db: SqlClient,
  teamId: string,
  season: number,
  week: number,
): Promise<ReadonlyMap<string, LineupPlayer & { fullName: string; status: string }>> {
  const rows = await db.query<{
    player_id: string;
    full_name: string;
    status: string;
    positions: string[];
    kickoff_at: string | null;
  }>(
    `SELECT p.id AS player_id,
            p.full_name,
            p.status,
            array_agg(DISTINCT pos.key) AS positions,
            g.kickoff_at
       FROM roster_entries r
       JOIN players p ON p.id = r.player_id
       JOIN positions pos
         ON pos.id = p.primary_position_id
         OR pos.id IN (SELECT position_id FROM player_eligible_positions WHERE player_id = p.id)
       LEFT JOIN games g
         ON g.sport_id = p.sport_id
        AND g.season = $2
        AND g.week = $3
        AND (g.home_team_ref = p.team_ref OR g.away_team_ref = p.team_ref)
      WHERE r.team_id = $1 AND r.released_at IS NULL
      GROUP BY p.id, p.full_name, p.status, g.kickoff_at`,
    [teamId, season, week],
  );

  return new Map(
    rows.map((row) => [
      row.player_id,
      {
        playerId: row.player_id,
        fullName: row.full_name,
        status: row.status,
        positions: row.positions,
        kickoffAt: row.kickoff_at
          ? Math.floor(new Date(row.kickoff_at).getTime() / 1000)
          : null,
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Reading and writing a lineup
// ---------------------------------------------------------------------------

/**
 * A team's stored lineup for a week.
 *
 * Returns an entry for **every** starting slot, empty ones included, so a caller
 * always sees the shape of the lineup rather than only the parts somebody filled.
 */
export async function loadLineup(
  db: SqlClient,
  teamId: string,
  week: number,
  rules: LeagueRules,
): Promise<readonly LineupAssignment[]> {
  const rows = await db.query<{
    slot_type: string;
    slot_index: number;
    player_id: string | null;
  }>(
    `SELECT st.key AS slot_type, l.slot_index, l.player_id
       FROM lineups l
       JOIN slot_types st ON st.id = l.slot_type_id
      WHERE l.team_id = $1 AND l.week = $2`,
    [teamId, week],
  );

  const stored = new Map(
    rows.map((row) => [`${row.slot_type}#${row.slot_index}`, row.player_id]),
  );

  return startingSlots(buildRosterShape(rules.roster, NFL)).map((slot) => ({
    slotType: slot.slotType,
    slotIndex: slot.slotIndex,
    playerId: stored.get(`${slot.slotType}#${slot.slotIndex}`) ?? null,
  }));
}

export interface SetLineupInput {
  readonly leagueId: string;
  readonly teamId: string;
  readonly week: number;
  readonly assignments: readonly LineupAssignment[];
  /** Unix seconds. Drives the lock check. */
  readonly now: number;
}

/**
 * Replace a team's lineup for a week.
 *
 * Validated against the league's own rules and the team's own roster, with locks
 * enforced against what is **currently stored** — not against anything the
 * client sent. The whole write is one transaction, so a rejected lineup leaves
 * the previous one intact rather than half-applied.
 */
export async function setLineup(
  db: SqlClient,
  input: SetLineupInput,
): Promise<readonly LineupAssignment[]> {
  const stored = await getLeagueRules(db, input.leagueId);
  if (!stored) throw new LineupError("League has no rules", "LEAGUE_NOT_FOUND");

  const [team] = await db.query<{ id: string }>(
    "SELECT id FROM teams WHERE id = $1 AND league_id = $2",
    [input.teamId, input.leagueId],
  );
  if (!team) throw new LineupError("Team is not in this league", "TEAM_NOT_IN_LEAGUE");

  const season = stored.rules.seasonYear;
  const roster = await loadRosterForWeek(db, input.teamId, season, input.week);
  const current = await loadLineup(db, input.teamId, input.week, stored.rules);

  const problems = validateLineup({
    assignments: input.assignments,
    shape: buildRosterShape(stored.rules.roster, NFL),
    roster,
    current,
    now: input.now,
  });

  if (problems.length > 0) {
    throw new LineupError(
      `That lineup is not legal: ${problems.map((p) => p.message).join("; ")}`,
      "INVALID_LINEUP",
      problems,
    );
  }

  const slotTypeIds = await loadSlotTypeIds(db, stored.rules);

  return withTransaction(db, async (tx) => {
    for (const assignment of input.assignments) {
      const slotTypeId = slotTypeIds.get(assignment.slotType);
      if (!slotTypeId) {
        throw new LineupError(
          `Slot type ${assignment.slotType} is not in the sport registry`,
          "SLOT_TYPE_UNKNOWN",
        );
      }

      await tx.query(
        `INSERT INTO lineups (team_id, week, slot_type_id, slot_index, player_id, locked_at)
         VALUES ($1, $2, $3, $4, $5, NULL)
         ON CONFLICT (team_id, week, slot_type_id, slot_index)
         DO UPDATE SET player_id = EXCLUDED.player_id`,
        [input.teamId, input.week, slotTypeId, assignment.slotIndex, assignment.playerId],
      );
    }

    return loadLineup(tx, input.teamId, input.week, stored.rules);
  });
}

async function loadSlotTypeIds(
  db: SqlClient,
  rules: LeagueRules,
): Promise<ReadonlyMap<string, string>> {
  const rows = await db.query<{ id: string; key: string }>(
    `SELECT st.id, st.key FROM slot_types st
       JOIN sports s ON s.id = st.sport_id
      WHERE s.key = $1`,
    [rules.sportKey],
  );

  return new Map(rows.map((row) => [row.key, row.id]));
}

// ---------------------------------------------------------------------------
// The autolineup
// ---------------------------------------------------------------------------

/**
 * Season-to-date average for each player on a roster, in milli-points.
 *
 * Scored with **this league's** rules, because the average feeds a decision this
 * league is making. Two leagues with different scoring will rank the same player
 * differently, and both are right.
 *
 * Only weeks before `week` count — including the current week would rank players
 * on a game that has not finished, or has not started.
 */
async function loadAverages(
  db: SqlClient,
  playerIds: readonly string[],
  season: number,
  week: number,
  rules: LeagueRules,
): Promise<ReadonlyMap<string, number | null>> {
  if (playerIds.length === 0 || week <= 1) {
    return new Map(playerIds.map((id) => [id, null]));
  }

  const rows = await db.query<{ player_id: string; week: number; key: string; value: number }>(
    `SELECT s.player_id, s.week, k.key, s.value
       FROM stat_lines_current s
       JOIN stat_keys k ON k.id = s.stat_key_id
      WHERE s.player_id = ANY($1) AND s.season = $2 AND s.week < $3`,
    [playerIds, season, week],
  );

  // Group by player and week before scoring: a stat line is per-key, and a
  // player's points for a week come from all of them together.
  const byPlayerWeek = new Map<string, Map<number, StatLine[]>>();
  for (const row of rows) {
    const weeks = byPlayerWeek.get(row.player_id) ?? new Map<number, StatLine[]>();
    const lines = weeks.get(row.week) ?? [];
    lines.push({ statKey: row.key, value: Number(row.value) });
    weeks.set(row.week, lines);
    byPlayerWeek.set(row.player_id, weeks);
  }

  const scoring = indexScoringRules(rules.scoring);

  return new Map(
    playerIds.map((playerId) => {
      const weeks = byPlayerWeek.get(playerId);
      if (!weeks || weeks.size === 0) return [playerId, null];

      const weekly = [...weeks.values()].map((lines) => scorePlayer(lines, scoring));
      return [playerId, seasonAverage(weekly)];
    }),
  );
}

/** Injury designations that mean a player will not appear. */
const OUT_STATUSES = new Set(["OUT", "IR", "INACTIVE", "SUSPENDED", "DOUBTFUL", "PUP", "NFI"]);

/**
 * Fill a team's lineup automatically.
 *
 * Preserves any slot that has already locked, and writes only what is missing —
 * so calling this on a team whose manager set a full lineup changes nothing.
 */
export async function autoFillLineup(
  db: SqlClient,
  leagueId: string,
  teamId: string,
  week: number,
  now: number,
): Promise<readonly LineupAssignment[]> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new LineupError("League has no rules", "LEAGUE_NOT_FOUND");

  const season = stored.rules.seasonYear;
  const roster = await loadRosterForWeek(db, teamId, season, week);
  const current = await loadLineup(db, teamId, week, stored.rules);

  const averages = await loadAverages(db, [...roster.keys()], season, week, stored.rules);

  const candidates: AutolineupCandidate[] = [...roster.values()].map((player) => ({
    playerId: player.playerId,
    positions: player.positions,
    kickoffAt: player.kickoffAt,
    averageMilliPoints: averages.get(player.playerId) ?? null,
    // A bye and an injury designation both mean "will not appear". Neither is a
    // hard exclusion — a team with nobody else still has to field someone.
    unavailable: player.kickoffAt === null || OUT_STATUSES.has(player.status.toUpperCase()),
  }));

  // Anything already locked is a fixed point, and anything already set by the
  // manager is left alone: this fills gaps, it does not second-guess.
  const keep = new Map<string, LineupAssignment>();
  for (const assignment of lockedAssignments(current, roster, now)) {
    keep.set(`${assignment.slotType}#${assignment.slotIndex}`, assignment);
  }
  for (const assignment of current) {
    if (assignment.playerId !== null) {
      keep.set(`${assignment.slotType}#${assignment.slotIndex}`, assignment);
    }
  }

  const filled = autolineup({
    shape: buildRosterShape(stored.rules.roster, NFL),
    roster: candidates,
    locked: [...keep.values()],
  });

  return setLineupUnchecked(db, teamId, week, filled, stored.rules);
}

/**
 * Write a lineup without validating it.
 *
 * Only for the autolineup, whose output is already produced from this league's
 * own shape and this team's own roster, and which must succeed even when a
 * manager's own lineup would be rejected — an abandoned team still has to be
 * given one.
 */
async function setLineupUnchecked(
  db: SqlClient,
  teamId: string,
  week: number,
  assignments: readonly LineupAssignment[],
  rules: LeagueRules,
): Promise<readonly LineupAssignment[]> {
  const slotTypeIds = await loadSlotTypeIds(db, rules);

  return withTransaction(db, async (tx) => {
    for (const assignment of assignments) {
      const slotTypeId = slotTypeIds.get(assignment.slotType);
      if (!slotTypeId) continue;

      await tx.query(
        `INSERT INTO lineups (team_id, week, slot_type_id, slot_index, player_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (team_id, week, slot_type_id, slot_index)
         DO UPDATE SET player_id = EXCLUDED.player_id`,
        [teamId, week, slotTypeId, assignment.slotIndex, assignment.playerId],
      );
    }

    return loadLineup(tx, teamId, week, rules);
  });
}

/**
 * Give every team in a league a lineup for a week.
 *
 * What makes `resolveWeek`'s precondition true. It throws if a scheduled team
 * has no lineup — correctly, because scoring a missing team as zero hands its
 * opponent a free win — so this runs first.
 */
export async function ensureLineups(
  db: SqlClient,
  leagueId: string,
  week: number,
  now: number,
): Promise<{ teamsFilled: number }> {
  const teams = await db.query<{ id: string }>(
    "SELECT id FROM teams WHERE league_id = $1 ORDER BY slot",
    [leagueId],
  );

  let teamsFilled = 0;
  for (const team of teams) {
    await autoFillLineup(db, leagueId, team.id, week, now);
    teamsFilled++;
  }

  return { teamsFilled };
}

// ---------------------------------------------------------------------------
// Scoring inputs
// ---------------------------------------------------------------------------

/**
 * Every team's lineup for a week, shaped for `resolveWeek`.
 *
 * Bench is everyone rostered who is not starting — scored and shown so a manager
 * can see what they left out, never added to the total.
 */
export async function loadWeekLineups(
  db: SqlClient,
  leagueId: string,
  week: number,
): Promise<readonly TeamLineup[]> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new LineupError("League has no rules", "LEAGUE_NOT_FOUND");

  const teams = await db.query<{ id: string }>(
    "SELECT id FROM teams WHERE league_id = $1 ORDER BY slot",
    [leagueId],
  );

  const lineups: TeamLineup[] = [];

  for (const team of teams) {
    const assignments = await loadLineup(db, team.id, week, stored.rules);
    const starting = new Set(
      assignments.map((a) => a.playerId).filter((id): id is string => id !== null),
    );

    const rostered = await db.query<{ player_id: string }>(
      "SELECT player_id FROM roster_entries WHERE team_id = $1 AND released_at IS NULL",
      [team.id],
    );

    lineups.push({
      teamId: team.id,
      assignments,
      bench: rostered.map((row) => row.player_id).filter((id) => !starting.has(id)),
    });
  }

  return lineups;
}

/**
 * A week's stat lines, keyed by player, ready for `resolveWeek`.
 *
 * Reads `stat_lines_current`, so a stat correction that arrived as a new
 * revision is picked up and the superseded one is not.
 */
export async function loadWeekStats(
  db: SqlClient,
  sportKey: string,
  season: number,
  week: number,
): Promise<ReadonlyMap<string, readonly StatLine[]>> {
  const rows = await db.query<{ player_id: string; key: string; value: number }>(
    `SELECT s.player_id, k.key, s.value
       FROM stat_lines_current s
       JOIN stat_keys k ON k.id = s.stat_key_id
       JOIN sports sp ON sp.id = k.sport_id
      WHERE sp.key = $1 AND s.season = $2 AND s.week = $3`,
    [sportKey, season, week],
  );

  const byPlayer = new Map<string, StatLine[]>();
  for (const row of rows) {
    const lines = byPlayer.get(row.player_id) ?? [];
    lines.push({ statKey: row.key, value: Number(row.value) });
    byPlayer.set(row.player_id, lines);
  }

  return byPlayer;
}
