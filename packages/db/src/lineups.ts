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

/**
 * The provider whose stats decide scores.
 *
 * `stat_lines` records the source on every row and the view keys on it, so two
 * providers reporting the same stat produce two rows. Everything that scores
 * must therefore say which one it means; nothing may read across them.
 *
 * **This is not the agreement gate.** `docs/RULES.md` §7 requires two
 * independent providers to agree before a paying week finalises — that check
 * (G4/G5) reads the same view *without* a source filter, compares the two, and
 * freezes the week on disagreement. This constant only decides which one is
 * scored in the meantime. If it ever becomes the answer to "which provider is
 * right", the second provider has stopped being a check.
 *
 * A constant rather than league rules, env, or a table:
 *
 *   - **Not rules.** They are hashed, signed and frozen for the life of a
 *     league, so a provider that shut down mid-season would leave every existing
 *     league permanently unscoreable. The rules already hold the right
 *     abstraction — `settlement.requiredOracleSources` says *how many* must
 *     agree, not which.
 *   - **Not env.** The scoring cron and the web app are separate processes; a
 *     drifted value would give two different scores for one week, silently.
 *   - **Not a table yet.** That is administrable state with no administrator,
 *     and G5 needs its own shape regardless.
 *
 * So: a line of code, changed by a reviewed commit, identical everywhere.
 */
export const PRIMARY_STAT_SOURCE = "tank01";
/**
 * The provider whose *projections* rank the autofill.
 *
 * Deliberately separate from `PRIMARY_STAT_SOURCE`, even though one vendor
 * satisfies both today. The two choices have opposite drivers: a stats source is
 * chosen for factual accuracy and sits under the two-provider agreement gate in
 * `docs/RULES.md` §7; a projections source is chosen for model quality and is
 * **exempt** from that gate — §7 is explicit that a projection is an opinion, and
 * opinions could never pass an agreement test. Coupling them would mean that
 * swapping the stats oracle silently re-ranks every autolineup.
 *
 * The filter itself is not optional. `player_projections` is keyed on
 * `(player, season, week, source, stat_key)` precisely so a second opinion does
 * not overwrite the first (migration 0013), and `scorePlayer` folds over every
 * row it is handed — so reading unfiltered projects a dual-covered player at
 * roughly double and leaves single-covered players alone. That is a *reordering*,
 * not a scale, and the ranking is what decides who starts.
 *
 * `DECISIONS.md` puts it best: store the projection used, **with its source**,
 * and the decision is as reproducible as anything else in the system. A number
 * summed across two vendors is reproducible from neither.
 */
export const PRIMARY_PROJECTION_SOURCE = "tank01";

export class LineupError extends Error {
  constructor(
    message: string,
    readonly code:
      | "LEAGUE_NOT_FOUND"
      | "TEAM_NOT_IN_LEAGUE"
      | "INVALID_LINEUP"
      | "SLOT_TYPE_UNKNOWN"
      | "SCHEDULE_MISSING",
    readonly problems: readonly LineupProblem[] = [],
  ) {
    super(message);
    this.name = "LineupError";
  }
}

/**
 * Whether the week's schedule has been ingested.
 *
 * Every lock in the system is derived from `games.kickoff_at`, so a week with no
 * game rows has no locks at all — not "locks that have not fired yet", none.
 * A manager could set their whole lineup on Monday night having watched every
 * result, and it would be accepted.
 *
 * That makes the presence of the schedule a security precondition, not a data
 * detail, which is why `setLineup` refuses without it rather than proceeding.
 * Refusing to accept a lineup is a visible, recoverable failure; accepting one
 * that cannot be locked is a silent one that decides matchups.
 */
export async function weekHasSchedule(
  db: SqlClient,
  season: number,
  week: number,
): Promise<boolean> {
  const [row] = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM games WHERE season = $1 AND week = $2",
    [season, week],
  );
  return Number(row?.count ?? 0) > 0;
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
 *
 * ## "No game row" means three different things, and only one of them is a bye
 *
 * The lock is derived entirely from `games.kickoff_at`, so a missing row reads
 * as "never locks". That is right for a bye and catastrophic for the other two:
 *
 *   1. **A bye.** The player's team is scheduled this season but not this week.
 *      Correctly unlockable — he cannot score, so nothing can be acted on.
 *   2. **The schedule was never ingested.** No game rows exist for the week at
 *      all, so *nobody* locks and the entire lock system is silently off. See
 *      `weekHasSchedule`, which is what `setLineup` refuses on.
 *   3. **The player's `team_ref` matches nothing all season** — stale after a
 *      trade, blank, or a provider rename. He never locks, while `loadWeekStats`
 *      keys on `player_id` alone and scores him regardless. That is the exploit:
 *      start him on Monday night having watched him play.
 *
 * Case 3 is resolved here rather than in `@rostr/core`, by giving such a player
 * the **week's first kickoff** instead of `null`. Every existing lock rule then
 * applies unchanged: he is freely movable until the week begins and frozen after,
 * which is the conservative reading of "we do not know when this player plays".
 *
 * A genuine bye keeps `null` and keeps the documented behaviour, because his team
 * *is* in the schedule — just not this week.
 */
/**
 * When each of these players' games kick off this week.
 *
 * Keyed on the **player**, not on a roster, and that separation is the whole of
 * the fix for the lock bypass. A lock is a fact about a game that has started;
 * asking a roster about it meant that cutting the player in a locked slot made
 * the slot's occupant vanish from the map, and an absent player read as
 * "never locked". Callers pass the union of the roster and whoever is standing
 * in the stored lineup, so a released player still locks the slot he was
 * started in.
 *
 * A player present with `null` is on a bye. A player **absent** from the result
 * is one this function was not asked about — `isSlotLocked` treats that as
 * locked rather than guessing, so an under-populated map produces refusals
 * rather than a silent bypass.
 *
 * The three "no game row" cases are the same ones `loadRosterForWeek` documents,
 * and they are resolved here so there is one definition of when a player locks.
 */
export async function loadKickoffs(
  db: SqlClient,
  playerIds: readonly string[],
  season: number,
  week: number,
): Promise<ReadonlyMap<string, number | null>> {
  if (playerIds.length === 0) return new Map();

  const rows = await db.query<{
    player_id: string;
    kickoff_at: string | null;
    team_scheduled: boolean;
  }>(
    `SELECT p.id AS player_id,
            g.kickoff_at,
            EXISTS (
              SELECT 1 FROM games sg
               WHERE sg.sport_id = p.sport_id
                 AND sg.season = $2
                 AND (sg.home_team_ref = p.team_ref OR sg.away_team_ref = p.team_ref)
            ) AS team_scheduled
       FROM players p
       LEFT JOIN games g
         ON g.sport_id = p.sport_id
        AND g.season = $2
        AND g.week = $3
        AND (g.home_team_ref = p.team_ref OR g.away_team_ref = p.team_ref)
      WHERE p.id = ANY($1)`,
    [[...playerIds], season, week],
  );

  const weekStartsAt = await weekFirstKickoff(db, season, week);

  return new Map(
    rows.map((row) => [
      row.player_id,
      row.kickoff_at
        ? Math.floor(new Date(row.kickoff_at).getTime() / 1000)
        : row.team_scheduled
          ? null
          : weekStartsAt,
    ]),
  );
}

/**
 * Each of these players' bye week this season, `null` where it is not recorded.
 *
 * ## Why this is not part of `loadKickoffs`
 *
 * That function is the single definition of when a slot freezes, and its own
 * docstring is emphatic that widening it is how the lock bypass happened. A bye
 * week decides nothing about locking — it only separates "resting" from "not yet
 * dated" for the screen — so it is loaded alongside rather than folded in.
 * Keeping them apart means a bug here can mislabel a row and cannot unlock one.
 *
 * Absent from the result means absent from `player_seasons`, which
 * `gameAvailability` reads as a bye rather than as a fixture still to come.
 */
export async function loadByeWeeks(
  db: SqlClient,
  playerIds: readonly string[],
  season: number,
): Promise<ReadonlyMap<string, number | null>> {
  if (playerIds.length === 0) return new Map();

  const rows = await db.query<{ player_id: string; bye_week: number | null }>(
    `SELECT player_id, bye_week
       FROM player_seasons
      WHERE season = $2 AND player_id = ANY($1)`,
    [[...playerIds], season],
  );

  return new Map(
    rows.map((row) => [row.player_id, row.bye_week === null ? null : Number(row.bye_week)]),
  );
}

/**
 * Which of these players' games this week carry a provisional kickoff.
 *
 * `games.kickoff_tbd`: the fixture and its date are known, the hour is not, and
 * `kickoff_at` holds the earliest time it could start. Separate from
 * `loadKickoffs` for the same reason `loadByeWeeks` is — that function is the
 * lock oracle, and this one only decides what a screen says. The lock *should*
 * use the conservative time exactly as stored, which is why it needs to know
 * nothing about this.
 */
export async function loadTbdKickoffs(
  db: SqlClient,
  playerIds: readonly string[],
  season: number,
  week: number,
): Promise<ReadonlySet<string>> {
  if (playerIds.length === 0) return new Set();

  const rows = await db.query<{ player_id: string }>(
    `SELECT p.id AS player_id
       FROM players p
       JOIN games g
         ON g.sport_id = p.sport_id
        AND g.season = $2
        AND g.week = $3
        AND (g.home_team_ref = p.team_ref OR g.away_team_ref = p.team_ref)
      WHERE p.id = ANY($1) AND g.kickoff_tbd`,
    [[...playerIds], season, week],
  );

  return new Set(rows.map((row) => row.player_id));
}

/**
 * The earliest kickoff of the week, or `null` when the week has no games.
 *
 * The conservative lock time for a player whose team is nowhere in the schedule:
 * he freezes when the week begins rather than never.
 */
async function weekFirstKickoff(
  db: SqlClient,
  season: number,
  week: number,
): Promise<number | null> {
  const [firstGame] = await db.query<{ kickoff_at: string | null }>(
    `SELECT min(kickoff_at) AS kickoff_at FROM games WHERE season = $1 AND week = $2`,
    [season, week],
  );
  return firstGame?.kickoff_at
    ? Math.floor(new Date(firstGame.kickoff_at).getTime() / 1000)
    : null;
}

/**
 * A rostered player, as the lineup screen needs him.
 *
 * `LineupPlayer` is the part the rules read — the id, the positions, and the
 * kickoff a slot locks on. The three fields added here are the part a person
 * reads, and the separation is worth keeping visible: a face and a club can be
 * missing, stale or wrong without a single point moving, while the fields they
 * sit beside decide whether an edit is legal.
 */
export type RosterPlayer = LineupPlayer & {
  readonly fullName: string;
  readonly status: string;
  /** Provider-published headshot, or a crest for a team unit. Null renders as initials. */
  readonly imageUrl: string | null;
  /** The club, not the fantasy team — "PHI". */
  readonly teamRef: string | null;
  /**
   * The provider's own wording, or null when fit.
   *
   * **Shown, never enforced.** §6 locks a slot at that player's own kickoff and
   * says nothing about whether he is fit to play it — starting a doubtful
   * player is a manager's call, and a designation arriving on the Sunday must
   * not be able to invalidate a lineup that was legal when it was set.
   */
  readonly injuryDesignation: string | null;
};
export async function loadRosterForWeek(
  db: SqlClient,
  teamId: string,
  season: number,
  week: number,
): Promise<ReadonlyMap<string, RosterPlayer>> {
  const rows = await db.query<{
    player_id: string;
    full_name: string;
    status: string;
    positions: string[];
    kickoff_at: string | null;
    team_scheduled: boolean;
    image_url: string | null;
    team_ref: string | null;
    injury_designation: string | null;
  }>(
    `SELECT p.id AS player_id,
            p.full_name,
            p.status,
            -- Display only. A roster row shows a face, a club, and whether the
            -- man is hurt; none of the three is read by a lock, by
            -- validateLineup, or by anything that scores.
            p.image_url,
            p.team_ref,
            p.injury_designation,
            array_agg(DISTINCT pos.key) AS positions,
            g.kickoff_at,
            -- Does this player's team appear anywhere in the season's schedule?
            -- Distinguishes a bye (scheduled, just not this week) from a
            -- team_ref that matches nothing at all.
            EXISTS (
              SELECT 1 FROM games sg
               WHERE sg.sport_id = p.sport_id
                 AND sg.season = $2
                 AND (sg.home_team_ref = p.team_ref OR sg.away_team_ref = p.team_ref)
            ) AS team_scheduled
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
      GROUP BY p.id, p.full_name, p.status, g.kickoff_at, p.team_ref, p.sport_id,
               p.image_url, p.injury_designation`,
    [teamId, season, week],
  );

  // The conservative lock time for a player whose team is not in the schedule at
  // all. Null when the week has no games — `setLineup` refuses in that case
  // rather than guessing. Shared with `loadKickoffs` so the two cannot disagree.
  const weekStartsAt = await weekFirstKickoff(db, season, week);

  return new Map(
    rows.map((row) => [
      row.player_id,
      {
        playerId: row.player_id,
        fullName: row.full_name,
        status: row.status,
        positions: row.positions,
        imageUrl: row.image_url,
        teamRef: row.team_ref,
        injuryDesignation: row.injury_designation,
        kickoffAt: row.kickoff_at
          ? Math.floor(new Date(row.kickoff_at).getTime() / 1000)
          : // No game this week. A bye keeps null and stays movable; a player
            // whose team is nowhere in the schedule gets the week's first
            // kickoff, so he freezes when the week begins rather than never.
            row.team_scheduled
            ? null
            : weekStartsAt,
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

  // Fail closed. Without the schedule there are no kickoff times, so no lock can
  // fire and every check below silently passes — a manager could set their whole
  // lineup after the last whistle. Refusing is visible and recoverable; the
  // alternative is invisible and decides matchups.
  if (!(await weekHasSchedule(db, season, input.week))) {
    throw new LineupError(
      `Week ${input.week} of ${season} has no schedule loaded, so lineup locks ` +
        `cannot be enforced. Run the games sync before accepting lineups.`,
      "SCHEDULE_MISSING",
    );
  }

  const roster = await loadRosterForWeek(db, input.teamId, season, input.week);
  const current = await loadLineup(db, input.teamId, input.week, stored.rules);

  // The union, and the union is the whole fix.
  //
  // A player dropped after his game kicked off has left the roster and is still
  // sitting in the slot he was started in. Asking the roster when he kicked off
  // answered `undefined`, which read as "never locked" — so cutting the man
  // holding the lock reopened the slot, which is the one thing the lock exists
  // to prevent. Kickoffs are a fact about games, so they are looked up per
  // player over everyone this decision touches: who is rostered, who is already
  // standing in a slot, and who is being submitted into one.
  const kickoffs = await loadKickoffs(
    db,
    [
      ...new Set(
        [
          ...roster.keys(),
          ...current.map((assignment) => assignment.playerId),
          ...input.assignments.map((assignment) => assignment.playerId),
        ].filter((playerId): playerId is string => playerId !== null),
      ),
    ],
    season,
    input.week,
  );

  const problems = [
    ...validateLineup({
      assignments: input.assignments,
      shape: buildRosterShape(stored.rules.roster, NFL),
      roster,
      kickoffs,
      current,
      now: input.now,
    }),
  ];

  // The write touches only the submitted slots, so validateLineup — which sees
  // only those — cannot tell that a submitted player already starts in a slot
  // this update leaves alone. That would persist him in two slots, and the
  // duplicate throws in scoring and stalls the whole league's week. Reject a
  // player who already occupies a different slot this update does not overwrite.
  const submittedSlots = new Set(input.assignments.map((a) => `${a.slotType}#${a.slotIndex}`));
  for (const assignment of input.assignments) {
    if (assignment.playerId === null) continue;
    const here = `${assignment.slotType}#${assignment.slotIndex}`;
    const elsewhere = current.find(
      (slot) =>
        slot.playerId === assignment.playerId &&
        `${slot.slotType}#${slot.slotIndex}` !== here &&
        !submittedSlots.has(`${slot.slotType}#${slot.slotIndex}`),
    );
    if (elsewhere) {
      problems.push({
        code: "PLAYER_TWICE",
        message:
          `${assignment.playerId} is already starting at ${elsewhere.slotType} ` +
          `slot ${elsewhere.slotIndex + 1}`,
        slotType: assignment.slotType,
        slotIndex: assignment.slotIndex,
        playerId: assignment.playerId,
      });
    }
  }

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
export async function loadAverages(
  db: SqlClient,
  playerIds: readonly string[],
  season: number,
  week: number,
  rules: LeagueRules,
  source: string = PRIMARY_STAT_SOURCE,
): Promise<ReadonlyMap<string, number | null>> {
  if (playerIds.length === 0 || week <= 1) {
    return new Map(playerIds.map((id) => [id, null]));
  }

  const rows = await db.query<{ player_id: string; week: number; key: string; value: number }>(
    `SELECT s.player_id, s.week, k.key, s.value
       FROM stat_lines_current s
       JOIN stat_keys k ON k.id = s.stat_key_id
      WHERE s.player_id = ANY($1) AND s.season = $2 AND s.week < $3 AND s.source = $4`,
    [playerIds, season, week, source],
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

/**
 * This week's projections, scored under **this league's** rules.
 *
 * The provider ships its own fantasy point total and it is discarded, here as
 * everywhere: ours pays 4 for a passing touchdown where a provider's default may
 * pay 6. Storing someone else's arithmetic would put a number in front of a
 * manager that disagrees with the number deciding their matchup. Raw stats in,
 * `scorePlayer` out — there is one definition of a point in this system.
 *
 * A player with no projection is simply absent from the map, and the autolineup
 * falls back to his season average for that player alone.
 */
export async function loadProjectedPoints(
  db: SqlClient,
  season: number,
  week: number,
  rules: LeagueRules,
  source: string = PRIMARY_PROJECTION_SOURCE,
): Promise<ReadonlyMap<string, number>> {
  const rows = await db.query<{ player_id: string; key: string; value: number }>(
    `SELECT p.player_id, k.key, p.value
       FROM player_projections p
       JOIN stat_keys k ON k.id = p.stat_key_id
      WHERE p.season = $1 AND p.week = $2 AND p.source = $3`,
    [season, week, source],
  );

  const byPlayer = new Map<string, StatLine[]>();
  for (const row of rows) {
    const lines = byPlayer.get(row.player_id) ?? [];
    lines.push({ statKey: row.key, value: Number(row.value) });
    byPlayer.set(row.player_id, lines);
  }

  const scoring = indexScoringRules(rules.scoring);

  return new Map(
    [...byPlayer].map(([playerId, stats]) => [playerId, scorePlayer(stats, scoring)]),
  );
}

/** Injury designations that mean a player will not appear. */
const OUT_STATUSES = new Set(["OUT", "IR", "INACTIVE", "SUSPENDED", "DOUBTFUL", "PUP", "NFI"]);

/**
 * Fill a team's lineup automatically.
 *
 * Preserves any slot that has already locked and any slot the manager has
 * already filled: this fills gaps, it does not second-guess.
 *
 * **The stored lineup is read inside the transaction, under a row lock, and
 * everything expensive is read before it.** That ordering is the whole of issue
 * #90 and it is the reverse of what this function used to do. It decided from a
 * snapshot taken outside any transaction — roster, lineup, season averages and,
 * on the default rules, a whole-week projections scan — and then wrote every
 * starting slot back, including the ones it had deliberately left alone. A
 * manager who saved a lineup inside that window had their edit written and then
 * silently restored to the snapshot, and `lineups` keeps no history, so nothing
 * anywhere recorded that it happened. `ensureLineups` runs this for every
 * autofill-enabled team every ten minutes, so the exposed surface was the whole
 * lineup rather than the empty slots.
 *
 * Nothing below the lock needs the lineup: `loadAverages` ranks the *roster*,
 * and `loadProjectedPoints` reads neither. So the reads that take a hundred
 * milliseconds stay outside, and the lock covers a `SELECT`, a pure computation
 * and nine writes.
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

  const averages = await loadAverages(db, [...roster.keys()], season, week, stored.rules);

  // Only fetched when the league ranks on them. A league set to SEASON_AVERAGE
  // should not pay for a query whose result it ignores.
  const mode = stored.rules.roster.autofill;
  const projected =
    mode === "WEEKLY_PROJECTION"
      ? await loadProjectedPoints(db, season, week, stored.rules)
      : new Map<string, number>();

  const candidates: AutolineupCandidate[] = [...roster.values()].map((player) => ({
    playerId: player.playerId,
    positions: player.positions,
    kickoffAt: player.kickoffAt,
    averageMilliPoints: averages.get(player.playerId) ?? null,
    projectedMilliPoints: projected.get(player.playerId) ?? null,
    // A bye and an injury designation both mean "will not appear". Neither is a
    // hard exclusion — a team with nobody else still has to field someone.
    unavailable: player.kickoffAt === null || OUT_STATUSES.has(player.status.toUpperCase()),
  }));

  const slotTypeIds = await loadSlotTypeIds(db, stored.rules);

  return withTransaction(db, async (tx) => {
    // The lineup is read here and nowhere earlier. Everything above decided
    // from the roster, which this function does not write and which no manager
    // action moves mid-week; this is the one input a manager can change while
    // the reads above are in flight, so it is taken last and taken locked.
    //
    // `FOR UPDATE` makes `setLineup`'s write wait rather than interleave. It
    // locks the rows that exist, which is not all of them — a slot nobody has
    // ever written has no row to lock — so the write below carries a
    // compare-and-swap as well. Migration `0016` prescribes exactly this pair:
    // the lock is the fast path, and something the lock cannot reach is the
    // backstop.
    await tx.query(`SELECT 1 FROM lineups WHERE team_id = $1 AND week = $2 FOR UPDATE`, [
      teamId,
      week,
    ]);

    const current = await loadLineup(tx, teamId, week, stored.rules);

    // Roster plus whoever is standing in the stored lineup — see `loadKickoffs`.
    // Without the second half a dropped player's slot reads as unlocked here
    // too, and the autofill would quietly replace a starter whose game had
    // begun.
    //
    // **Inside the lock, because it is derived from `current`.** The reads that
    // cost something — the season averages, and on the default rules a
    // whole-week projections scan — stay outside where they belong; this one is
    // a single lookup on `games` keyed by a list the fresh lineup determines,
    // and it cannot be hoisted without reintroducing the stale snapshot the
    // lock exists to prevent.
    const kickoffs = await loadKickoffs(
      tx,
      [
        ...new Set(
          [...roster.keys(), ...current.map((assignment) => assignment.playerId)].filter(
            (playerId): playerId is string => playerId !== null,
          ),
        ),
      ],
      season,
      week,
    );

    // Anything already locked is a fixed point, and anything already set by the
    // manager is left alone: this fills gaps, it does not second-guess.
    //
    // The exception is a player who has **left the roster and is not locked**.
    // He is not a choice the manager made — he is a hole, and leaving him there
    // let his slot lock at his kickoff around a player nobody rosters, who then
    // scored for the team that cut him.
    const locked = new Set(
      lockedAssignments(current, kickoffs, now).map(
        (assignment) => `${assignment.slotType}#${assignment.slotIndex}`,
      ),
    );
    const keep = new Map<string, LineupAssignment>();
    for (const assignment of current) {
      if (assignment.playerId === null) continue;
      const slot = `${assignment.slotType}#${assignment.slotIndex}`;
      if (!roster.has(assignment.playerId) && !locked.has(slot)) continue;
      keep.set(slot, assignment);
    }

    const filled = autolineup({
      shape: buildRosterShape(stored.rules.roster, NFL),
      roster: candidates,
      mode,
      locked: [...keep.values()],
    });

    return setLineupUnchecked(tx, teamId, week, filled, current, slotTypeIds, stored.rules);
  });
}

/**
 * Write a lineup without validating it.
 *
 * Only for the autolineup, whose output is already produced from this league's
 * own shape and this team's own roster, and which must succeed even when a
 * manager's own lineup would be rejected — an abandoned team still has to be
 * given one.
 *
 * **Runs inside a transaction its caller opened**, rather than opening one, so
 * that the lock and the read the write is conditioned on are inside the same
 * one. `withTransaction` issues a real `BEGIN` on whichever client it is given,
 * so opening a second here would make this `COMMIT` commit the caller's work
 * too — the same reason `generateSeasonSchedule` takes a transaction instead of
 * making one.
 *
 * `snapshot` is what the lineup held when `assignments` was decided, and every
 * write compares against it: a slot that has moved since is left as whoever
 * moved it left it. Under the caller's `FOR UPDATE` nothing can move a row that
 * exists, so this is the backstop for the rows the lock could not reach — a slot
 * with no row yet, which is every slot of a team's first pass. Losing that
 * compare writes nothing and raises nothing, which is what makes it safe to
 * apply nine times a run for every team in the league.
 *
 * `IS NOT DISTINCT FROM` rather than `=`, and that is load-bearing rather than
 * tidy. The ordinary case is an empty slot, so the compared value is `NULL`, and
 * `NULL = NULL` is `NULL` rather than true — `=` would refuse to fill any row
 * that had ever been materialised, which is every slot the autofill itself could
 * not fill on an earlier pass. The `::uuid` cast goes with it: beside a `uuid`
 * column a bare parameter is `unknown` on the null path and Postgres cannot
 * resolve the operator.
 *
 * **Not `WHERE lineups.player_id IS NULL`.** "Only ever fill an empty slot" is
 * the tempting simplification and it is wrong twice: it forbids evicting a
 * player who has left the roster — an occupied slot that *must* change — and it
 * turns every legitimate replacement into a silent no-op. The compare says the
 * narrower and truer thing: do not overwrite a decision somebody else took after
 * this one was made.
 */
async function setLineupUnchecked(
  tx: SqlClient,
  teamId: string,
  week: number,
  assignments: readonly LineupAssignment[],
  snapshot: readonly LineupAssignment[],
  slotTypeIds: ReadonlyMap<string, string>,
  rules: LeagueRules,
): Promise<readonly LineupAssignment[]> {
  const expected = new Map(
    snapshot.map((slot) => [`${slot.slotType}#${slot.slotIndex}`, slot.playerId]),
  );

  for (const assignment of assignments) {
    const slotTypeId = slotTypeIds.get(assignment.slotType);
    if (!slotTypeId) continue;

    await tx.query(
      `INSERT INTO lineups (team_id, week, slot_type_id, slot_index, player_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (team_id, week, slot_type_id, slot_index)
       DO UPDATE SET player_id = EXCLUDED.player_id
        WHERE lineups.player_id IS NOT DISTINCT FROM $6::uuid`,
      [
        teamId,
        week,
        slotTypeId,
        assignment.slotIndex,
        assignment.playerId,
        expected.get(`${assignment.slotType}#${assignment.slotIndex}`) ?? null,
      ],
    );
  }

  // Read back inside the transaction, so this returns what was stored rather
  // than what was intended. The two can now differ.
  return loadLineup(tx, teamId, week, rules);
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
): Promise<{ teamsFilled: number; teamsOptedOut: number }> {
  const teams = await db.query<{ id: string; autofill_enabled: boolean; is_bot: boolean }>(
    "SELECT id, autofill_enabled, is_bot FROM teams WHERE league_id = $1 ORDER BY slot",
    [leagueId],
  );

  let teamsFilled = 0;
  let teamsOptedOut = 0;

  for (const team of teams) {
    // A bot has no manager to forget, so the switch is not theirs to hold.
    if (team.is_bot || team.autofill_enabled) {
      await autoFillLineup(db, leagueId, team.id, week, now);
      teamsFilled++;
      continue;
    }

    // Opted out. They still get a lineup row — `resolveWeek` throws on a team
    // with none, and scoring a missing team as zero would hand its opponent a
    // free win off our own bug. Whatever they set stands; anything they left
    // empty stays empty and scores nothing, which is what the switch means.
    await writeEmptySlots(db, leagueId, team.id, week);
    teamsOptedOut++;
  }

  return { teamsFilled, teamsOptedOut };
}

/**
 * Materialise a lineup row for every starting slot, leaving unset slots null.
 *
 * Only for teams that turned the autofill off. It writes nothing over a slot the
 * manager already filled.
 */
async function writeEmptySlots(
  db: SqlClient,
  leagueId: string,
  teamId: string,
  week: number,
): Promise<void> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new LineupError("League has no rules", "LEAGUE_NOT_FOUND");

  const shape = buildRosterShape(stored.rules.roster, NFL);
  const slotTypeIds = await loadSlotTypeIds(db, stored.rules);

  await withTransaction(db, async (tx) => {
    for (const slot of startingSlots(shape)) {
      const slotTypeId = slotTypeIds.get(slot.slotType);
      if (!slotTypeId) continue;

      // DO NOTHING, not DO UPDATE: a slot the manager set themselves must
      // survive this untouched.
      await tx.query(
        `INSERT INTO lineups (team_id, week, slot_type_id, slot_index, player_id)
         VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT (team_id, week, slot_type_id, slot_index) DO NOTHING`,
        [teamId, week, slotTypeId, slot.slotIndex],
      );
    }
  });
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
 *
 * **From one source, and that is not the same thing as ignoring the other.**
 * The view is `DISTINCT ON (player, season, week, stat_key, source)` — one row
 * *per source* — and `scorePlayer` folds over whatever it is handed. Reading it
 * unfiltered means every stat two providers both report is counted twice, and
 * only for the players they both cover, so the distortion is uneven and
 * reorders rankings rather than merely inflating them.
 *
 * `docs/RULES.md` §7 requires two independent providers to *agree* before a
 * paying week finalises, so the second one is coming deliberately. Both rows
 * stay in the view, side by side, which is exactly what that agreement gate
 * (G4/G5) has to read. This picks which one scoring consumes; it does not
 * decide which one is true, and it must not be turned into that.
 */
export async function loadWeekStats(
  db: SqlClient,
  sportKey: string,
  season: number,
  week: number,
  source: string = PRIMARY_STAT_SOURCE,
): Promise<ReadonlyMap<string, readonly StatLine[]>> {
  const rows = await db.query<{ player_id: string; key: string; value: number }>(
    `SELECT s.player_id, k.key, s.value
       FROM stat_lines_current s
       JOIN stat_keys k ON k.id = s.stat_key_id
       JOIN sports sp ON sp.id = k.sport_id
      WHERE sp.key = $1 AND s.season = $2 AND s.week = $3 AND s.source = $4`,
    [sportKey, season, week, source],
  );

  const byPlayer = new Map<string, StatLine[]>();
  for (const row of rows) {
    const lines = byPlayer.get(row.player_id) ?? [];
    lines.push({ statKey: row.key, value: Number(row.value) });
    byPlayer.set(row.player_id, lines);
  }

  return byPlayer;
}

// ---------------------------------------------------------------------------
// The autofill switch
// ---------------------------------------------------------------------------

/**
 * Whether this team gets its empty slots filled at lock.
 *
 * A preference, not a rule: it lives on the team rather than in the frozen rule
 * set, because which *method* the autofill uses decides everyone's playoff seeds
 * and has to be verifiable, while whether yours runs is nobody else's business.
 */
export async function getAutofillEnabled(
  db: SqlClient,
  teamId: string,
): Promise<boolean | null> {
  const [row] = await db.query<{ autofill_enabled: boolean }>(
    "SELECT autofill_enabled FROM teams WHERE id = $1",
    [teamId],
  );
  return row?.autofill_enabled ?? null;
}

/**
 * Turn the autofill on or off for one team.
 *
 * Changeable whenever, including mid-season — it governs what happens at the
 * next lock and rewrites nothing already stored. Turning it off does not clear a
 * lineup that has already been filled.
 */
export async function setAutofillEnabled(
  db: SqlClient,
  teamId: string,
  enabled: boolean,
): Promise<void> {
  await db.query("UPDATE teams SET autofill_enabled = $1 WHERE id = $2", [enabled, teamId]);
}
