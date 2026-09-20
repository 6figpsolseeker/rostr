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
 * **That read is taken before the transaction opens, and it is worth being exact
 * about what follows from it.** The lock decision is made against a snapshot,
 * not against rows the request holds a lock on; what closes the gap is the
 * per-slot compare on the way out, which refuses a slot that moved in between
 * (`LINEUP_MOVED`) and skips one the request asserted nothing about. So a
 * crafted request gets the same answer as the screen for every rule the lock
 * expresses — and can additionally be told to try again, which the screen never
 * is. Issue #100, and its re-audit.
 *
 * ## A team always has a lineup by kickoff
 *
 * `resolveWeek` throws if a scheduled team has no lineup, deliberately: scoring
 * a missing team as zero would hand its opponent a free win. `ensureLineups`
 * is what makes that condition true — it fills anything unset with the
 * deterministic autolineup before the week is scored.
 */

import {
  autolineupChoices,
  buildRosterShape,
  indexScoringRules,
  lockedAssignments,
  NFL,
  scorePlayer,
  seasonAverage,
  startingSlots,
  unlikelyToPlay,
  validateLineup,
} from "@rostr/core";
import type { AutolineupChoice } from "@rostr/core";
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
import { overageFor, overLimitNotice } from "./roster-capacity.js";
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

/**
 * Week 0 is the season aggregate.
 *
 * The draft board asks "who is worth picking for the year"; the autofill asks
 * "who scores most this Sunday". Same table, same shape, different question —
 * and a sentinel rather than a nullable column, because Postgres treats NULLs
 * as distinct and the primary key would then permit two season projections from
 * one source for the same player.
 *
 * Declared here rather than in `sync.ts` because both files need it and
 * `sync.ts` already imports `PRIMARY_PROJECTION_SOURCE` from this one. Putting
 * it there and reading it here would close an import cycle around a
 * module-level constant, which is a temporal-dead-zone hazard settled by
 * whichever file the bundler happens to load first.
 */
export const SEASON_AGGREGATE_WEEK = 0;

export class LineupError extends Error {
  constructor(
    message: string,
    readonly code:
      | "LEAGUE_NOT_FOUND"
      | "TEAM_NOT_IN_LEAGUE"
      | "INVALID_LINEUP"
      | "SLOT_TYPE_UNKNOWN"
      | "SCHEDULE_MISSING"
      /**
       * The stored lineup moved between validation and the write. **Retryable.**
       *
       * Issue #100. `setLineup` validates against a snapshot taken before its
       * transaction opens — still, deliberately, so that nothing slow is done
       * under a row lock — so a manager whose PUT is in flight while the
       * score-week cron's autofill commits can have their lock check evaluated
       * against a slot that was empty when they looked and is not any more. This
       * is how that is caught, rather than how it was.
       *
       * Distinct from `INVALID_LINEUP` because the two need opposite responses:
       * an illegal lineup must be shown to the person so they can change it, and
       * this one means nothing is wrong except the timing. The client re-reads
       * and submits again.
       */
      | "LINEUP_MOVED"
      /**
       * This team holds more players than the limit, so its lineup is frozen.
       *
       * Not `INVALID_LINEUP`: nothing about the submitted lineup is wrong, and
       * the fix is on a different screen. Not `LINEUP_MOVED` either — that one
       * says "try again", and re-reading changes nothing here until somebody is
       * released.
       */
      | "ROSTER_OVER_LIMIT",
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
 * Which of these players no NFL club currently lists.
 *
 * A sibling loader, for the reason `loadByeWeeks` above gives: `loadKickoffs`
 * is `validateLineup`'s lock oracle and `loadRosterForWeek` is its ownership
 * oracle, and neither may gain a column to serve a label — `CLAUDE.md` states
 * that prohibition and `draft.ts` restates it. Loading alongside means a bug
 * here can mislabel a row and cannot unlock one or widen who may be started.
 *
 * ## Why this cannot be derived from what the lineup already holds
 *
 * The obvious shortcut is `teamRef === null`, and it is wrong in both
 * directions. The adapter maps `team_ref` from the provider's `team` and
 * `active` from its `isFreeAgent`, independently — so a listed player with a
 * blank club reads null, and a released player can keep a club abbreviation.
 *
 * The other shortcut is `kickoffAt === null`, and that is worse, because it is
 * usually **not** null for him. `loadRosterForWeek` gates its fallback on
 * `team_scheduled` — whether the club appears anywhere in the *season's*
 * schedule, not this week's — and hands anyone who fails it the week's first
 * kickoff, deliberately, so his slot still locks. See the test that exists for
 * exactly that trap. It is also why the lineup screen showed no "bye" for him,
 * and why #308's diagnosis missed this screen entirely.
 *
 * "Usually" rather than "never", precisely: it **is** null in a week with no
 * stored games (there is no first kickoff to fall back to), and it follows the
 * old club's fixture — including that club's bye — for a released player who
 * kept his abbreviation. Neither is a state to key a label on.
 *
 * `active` is the column the draft board and the market already key on, so all
 * five surfaces — board, market, scoreboard, player card and this screen — now
 * answer from one fact rather than five approximations.
 */
export async function loadOffNflRoster(
  db: SqlClient,
  playerIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (playerIds.length === 0) return new Set();

  const rows = await db.query<{ id: string }>(
    "SELECT id FROM players WHERE id = ANY($1) AND NOT active",
    [[...playerIds]],
  );

  return new Set(rows.map((row) => row.id));
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
  /**
   * Whether he is stashed on injured reserve.
   *
   * **Unlike `injuryDesignation` this is not display-only.** It is the team's
   * own recorded decision, it decides whether he counts against the roster
   * limit, and `autoFillLineup` must not start him — a stashed player is on the
   * roster and out of the rotation.
   */
  readonly onIr: boolean;
  /**
   * Who he plays this week — "NO", "MIA" — and whether at home.
   *
   * **Derived from the fixture we already store, not fetched.** `games` carries
   * both team refs and `players.team_ref` says which one he is, so the opponent
   * is the other one. No provider call, no new column, and it cannot disagree
   * with the kickoff shown beside it because both come from the same row.
   *
   * Null on a bye, and on a week whose fixture has not been ingested — the two
   * are told apart by `availability`, which is the field that already makes that
   * distinction. Nothing here should be used to infer a bye.
   */
  readonly opponentRef: string | null;
  /** True when his club is the home side. Null whenever `opponentRef` is. */
  readonly isHome: boolean | null;
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
    positions: string[];
    kickoff_at: string | null;
    team_scheduled: boolean;
    image_url: string | null;
    team_ref: string | null;
    injury_designation: string | null;
    on_ir: boolean;
    home_team_ref: string | null;
    away_team_ref: string | null;
  }>(
    `SELECT p.id AS player_id,
            p.full_name,
            -- Display only. A roster row shows a face, a club, and whether the
            -- man is hurt; none of the three is read by a lock, by
            -- validateLineup, or by anything that scores.
            p.image_url,
            p.team_ref,
            p.injury_designation,
            r.on_ir,
            array_agg(DISTINCT pos.key) AS positions,
            g.kickoff_at,
            g.home_team_ref,
            g.away_team_ref,
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
      GROUP BY p.id, p.full_name, g.kickoff_at, p.team_ref, p.sport_id, r.on_ir,
               g.home_team_ref, g.away_team_ref,
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
        positions: row.positions,
        imageUrl: row.image_url,
        teamRef: row.team_ref,
        injuryDesignation: row.injury_designation,
        onIr: row.on_ir,
        // The other side of his own fixture. Both refs are present or neither
        // is, so one null check covers the pair.
        opponentRef:
          row.home_team_ref === null || row.away_team_ref === null
            ? null
            : row.home_team_ref === row.team_ref
              ? row.away_team_ref
              : row.home_team_ref,
        isHome: row.home_team_ref === null ? null : row.home_team_ref === row.team_ref,
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

  /*
    Frozen while the roster is over the limit.

    Before the schedule check below, deliberately: a team over the limit in a
    league whose schedule has not loaded should be told the thing it can act on,
    not handed the operator's problem.

    Read outside the transaction like every other precondition here. The window
    is a manager racing his own drop, and it resolves in his favour the moment
    he retries.
  */
  const overage = await overageFor(db, input.teamId, stored.rules);
  const notice = overLimitNotice(overage);
  if (notice) throw new LineupError(notice, "ROSTER_OVER_LIMIT");

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

  /*
    Everything above validated against `current`, which was read before this
    transaction opened. Issue #100: that snapshot can go stale under the manager,
    and the thing it goes stale about is the **lock**.

    `current` is the sole input to both lock guards — `SLOT_LOCKED` compares
    against it, `PLAYER_LOCKED` uses it to decide whether a slot is even
    changing — and an empty slot never locks. So the sequence is: the manager's
    PUT reads RB1 as empty; the score-week cron's autofill commits a mid-game
    player into RB1; the manager's write lands and neither guard fires, because
    both were evaluated against a slot that was empty when it was read.

    That is a **lock bypass**, not a lost update. It is the thing
    `season/lineup.ts` names as the whole point of the lock: "someone starts a
    player after seeing him score." No second human is needed — the manager
    races the cron.

    Two things close it, and both are needed:

    - The row lock stops an existing row moving under us. It cannot help for a
      slot that has **no row yet**, which is exactly the autofill's case: it
      INSERTs where the manager saw nothing.
    - So the write also carries a compare-and-swap against the value validated
      against. `0016` predicted this in writing and closed only the duplicate
      half with a unique index.

    **Scoped to slots this request actually changes.** `LineupEditor` posts the
    entire slot list on every dropdown change, from a snapshot up to 30 s old, so
    a whole-lineup compare would fail every save issued within thirty seconds of
    an autofill pass — reintroducing from the other side the exact failure #99
    removed. An unchanged slot is not a claim about anything and must never
    refuse.
  */
  return withTransaction(db, async (tx) => {
    // Locks the rows that exist. See above for why that is half the answer.
    await tx.query(`SELECT 1 FROM lineups WHERE team_id = $1 AND week = $2 FOR UPDATE`, [
      input.teamId,
      input.week,
    ]);

    const byKey = new Map(
      current.map((slot) => [`${slot.slotType}#${slot.slotIndex}`, slot.playerId]),
    );

    for (const assignment of input.assignments) {
      const slotTypeId = slotTypeIds.get(assignment.slotType);
      if (!slotTypeId) {
        throw new LineupError(
          `Slot type ${assignment.slotType} is not in the sport registry`,
          "SLOT_TYPE_UNKNOWN",
        );
      }

      const key = `${assignment.slotType}#${assignment.slotIndex}`;
      const expected = byKey.get(key) ?? null;

      /*
        An unchanged slot is **skipped**, not written.

        The principle was already right here and the code did the opposite of it.
        The comment read "they assert nothing about the state, so a concurrent
        write to one is not a conflict" — and then wrote the value anyway, with
        no `WHERE`, which is precisely how you assert something about the state:
        it reverted whatever another writer had put there in the meantime.

        The common instance is `null === null`, because the editor posts every
        slot on every change. So the sequence the whole fix was written for —
        read the lineup, the autofill commits a player into an empty slot, write
        — clobbered that slot back to empty. And it did so **past the lock**: the
        `FOR UPDATE` above had by then locked a row holding a player whose game
        had kicked off, and `validateLineup` had already passed, because the
        snapshot it judged said the slot was empty and an empty slot never locks.
        That is the "a locked slot may not be emptied" bypass this module names
        two hundred lines up, arriving through the write loop instead of the
        validator.

        Skipping rather than guarding, and the reason is not the one the
        original comment gave. It said a whole-lineup compare "would refuse every
        save issued within thirty seconds of an autofill pass", which is false:
        the CAS baseline is not the client's snapshot but `current`, the server's
        own read taken milliseconds earlier in the same request. A compare on
        every slot would refuse only when something moved inside that window.

        The real reason is smaller and holds: refusing the manager's whole save
        because a slot they never touched moved is charging them for another
        writer's timing. They asserted nothing about it, so we write nothing to
        it, and whatever the other writer decided stands.

        Nothing depends on the row existing. `loadLineup` synthesises an entry
        for every starting slot whether or not a row is there, and `resolveWeek`
        is preceded by `ensureLineups`, which materialises them.
      */
      if (expected === assignment.playerId) continue;

      const written = await tx.query<{ slot_index: number }>(
        `INSERT INTO lineups (team_id, week, slot_type_id, slot_index, player_id, locked_at)
         VALUES ($1, $2, $3, $4, $5, NULL)
         ON CONFLICT (team_id, week, slot_type_id, slot_index)
         DO UPDATE SET player_id = EXCLUDED.player_id
          WHERE lineups.player_id IS NOT DISTINCT FROM $6
        RETURNING slot_index`,
        [
          input.teamId,
          input.week,
          slotTypeId,
          assignment.slotIndex,
          assignment.playerId,
          expected,
        ],
      );

      if (written.length === 0) {
        /*
          The slot holds something other than what we validated against, so the
          lock decision above was made about a state that no longer exists.

          Refused rather than reconciled here: what belongs in that slot now
          depends on whether the new occupant's game has started, which is the
          question `validateLineup` answers, and answering it a second time
          inside the write loop would be a second implementation of the lock.
          The caller re-reads and submits against the truth.
        */
        throw new LineupError(
          `${assignment.slotType} slot ${assignment.slotIndex + 1} changed while you were ` +
            `editing — reload and try again`,
          "LINEUP_MOVED",
        );
      }
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
 *
 * **Falls back to the season projection when the week has none at all**, and the
 * all-or-nothing part is the whole of it. A season total is a much larger number
 * than a week's, so a map holding both would rank every player who happened to
 * have a weekly row below every player who did not — which is not a fallback, it
 * is a corruption. Either the week has projections and they are used, or it has
 * none and the season totals rank everybody consistently.
 *
 * That case is not hypothetical and was not rare. Issue #287: no production
 * caller ever passed a week to `syncProjections`, so only the season aggregate
 * was ever written and this query returned nothing, every week, all season. A
 * league whose signed rules say `WEEKLY_PROJECTION` silently ranked on season
 * averages instead — and in week 1, where {@link loadAverages} has no prior week
 * to average either, every candidate ranked `null` and the autolineup fell
 * through to its last tie-break, which compares player UUIDs. Launch weekend
 * would have been decided by `gen_random_uuid()`.
 *
 * The ingest is fixed too, so this is the safety net rather than the mechanism.
 * It still earns its place: it covers the week before a provider publishes, and
 * any week whose pull failed.
 */
export async function loadProjectedPoints(
  db: SqlClient,
  season: number,
  week: number,
  rules: LeagueRules,
  source: string = PRIMARY_PROJECTION_SOURCE,
): Promise<ReadonlyMap<string, number>> {
  const weekly = await db.query<{ player_id: string; key: string; value: number }>(
    `SELECT p.player_id, k.key, p.value
       FROM player_projections p
       JOIN stat_keys k ON k.id = p.stat_key_id
      WHERE p.season = $1 AND p.week = $2 AND p.source = $3`,
    [season, week, source],
  );

  const rows =
    weekly.length > 0 || week === SEASON_AGGREGATE_WEEK
      ? weekly
      : await db.query<{ player_id: string; key: string; value: number }>(
          `SELECT p.player_id, k.key, p.value
             FROM player_projections p
             JOIN stat_keys k ON k.id = p.stat_key_id
            WHERE p.season = $1 AND p.week = $2 AND p.source = $3`,
          [season, SEASON_AGGREGATE_WEEK, source],
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

/**
 * One roster row, as the autofill sees it.
 *
 * **Exported so the preview cannot describe a different player from the write.**
 * The lineup route has every input already loaded and would otherwise restate
 * the `unavailable` rule inline — a bye and an out designation both meaning
 * "will not appear", neither being a hard exclusion. That rule sitting in two
 * files is how a screen ends up promising one starter while Sunday produces
 * another.
 */
export function autolineupCandidate(
  player: {
    readonly playerId: string;
    readonly positions: readonly string[];
    readonly kickoffAt: number | null;
    readonly teamRef: string | null;
    readonly injuryDesignation: string | null;
  },
  ranking: {
    readonly averageMilliPoints: number | null;
    readonly projectedMilliPoints: number | null;
  },
  /**
   * Who no NFL club lists, from `loadOffNflRoster`. Membership means *off*.
   *
   * **Required rather than optional, and that is deliberate.** Under
   * `exactOptionalPropertyTypes` an omitted argument cannot even be passed as
   * `undefined` — but more importantly, the permissive value here is precisely
   * the bug: a caller who omitted it would silently rank every released player
   * as available. `autolineup.ts` makes the same argument about `now`: a fact
   * with no conservative default must be supplied, not defaulted.
   *
   * A set rather than a boolean because this function is exported *so the
   * preview and the write cannot describe different players*. A boolean moves
   * the lookup into both call sites, where one of them can look up the wrong
   * id and compile clean.
   */
  offNflRoster: ReadonlySet<string>,
): AutolineupCandidate {
  return {
    playerId: player.playerId,
    positions: player.positions,
    kickoffAt: player.kickoffAt,
    averageMilliPoints: ranking.averageMilliPoints,
    projectedMilliPoints: ranking.projectedMilliPoints,
    /*
      A bye and a designation that means he will not appear are the same fact to
      a ranking: no points either way. Neither is a hard exclusion — a team with
      nobody else still has to field somebody, and `defaultPositionCaps` puts
      QB, K and DEF at one apiece, so excluding would empty those slots outright.

      This used to test `players.status` against a set of short codes. Nothing in
      this repo has ever written that column — 271 inserts and 59 updates across
      the whole of its history, none of them naming it — so the comparison was
      `"ACTIVE"` against out-codes and never matched once. `RULES.md` §8 has
      promised this behaviour to every member who signed, and it did nothing.
      Issue #269.

      **Three separate facts, not one checked three ways.** Each answers a
      different question and none implies another:

      - `offNflRoster` — **no NFL club employs him.** From `players.active`, the
        column the board, the market, the card and the lineup screen all key on.
      - `teamRef === null` — **we cannot locate his game.** His kickoff is then a
        synthesised stand-in rather than a real one, so we do not know when or
        whether he plays.
      - `kickoffAt === null` — **his club has no game this week.** An ordinary
        bye. Alive and common; do not read #308 as having killed this clause.

      **A null kickoff does not imply the others**, which is the trap this block
      has always been about. It reads as though it should: no club, no fixture,
      no kickoff. But `loadKickoffs` is the *lock* oracle and fails **closed** —
      a player whose club has no games in the season gets the week's first
      kickoff rather than null, so an unknown player's slot freezes rather than
      staying open all Sunday. Right for a lock, exactly wrong here.

      **And `teamRef` alone was not enough**, which is #327. A player released
      mid-season who keeps his club abbreviation takes that club's *real*
      fixture, so his kickoff is genuine and `teamRef` never fires — he read as
      fully **available**, and was then ranked on a season average nothing
      expires. A receiver cut in week 6 after two good games carries it into
      week 7 and is started over a fit bench player, for a guaranteed zero, on a
      team whose results move other people's playoff seeds.

      **Why both `offNflRoster` and `teamRef`, when `active` is the repo's
      answer everywhere else.** Because the two disagree in opposite directions
      and the *defaults* are not symmetric: the adapter maps a missing `team` to
      null — unavailable — and a missing `isFreeAgent` to `active: true` —
      available. Keying on `active` alone would swap a fail-closed predicate for
      a fail-open one, in a module whose siblings advertise failing closed.
      Keeping both is strictly the more conservative answer, and it costs a
      demotion rather than an exclusion.

      `CLAUDE.md`'s "never `team_ref`" rule is about *labelling* a player as
      having no club — where it is exactly right, and where this file no longer
      does it. Using it as a second demotion term in a ranking is a different
      thing, and this paragraph exists so the next reader does not read the two
      as a contradiction.

      Latent while a cut player could only arrive by being cut *while* rostered.
      Not latent since 2026-09-16, when he became someone a manager can go and
      sign on purpose.

      Still a sort key rather than an exclusion, like everything else here: a
      team with nobody else at the position fields him and scores the zero it
      would have scored with an empty slot.
    */
    unavailable:
      offNflRoster.has(player.playerId) ||
      player.kickoffAt === null ||
      player.teamRef === null ||
      unlikelyToPlay(player.injuryDesignation),
  };
}

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
  options?: {
    /**
     * Tidy the lineup but pick nobody. Defaults to filling.
     *
     * For a team over the roster limit. The autofill does two jobs — it takes
     * players the team no longer owns *out* of the lineup, and it puts players
     * *into* empty slots — and only the second is a courtesy. Withholding the
     * first would be a scoring bug rather than a penalty: the manager over the
     * limit is required to release somebody, releasing a starter is the obvious
     * move, and a released player left standing in a slot goes on scoring for
     * the team that cut him while being addable by everybody else.
     *
     * ESPN behaves the same way in both halves: it never fills a slot for you,
     * and it never leaves a player you dropped in your lineup.
     */
    readonly fillEmptySlots?: boolean;
  },
): Promise<readonly LineupAssignment[]> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new LineupError("League has no rules", "LEAGUE_NOT_FOUND");

  const season = stored.rules.seasonYear;
  const roster = await loadRosterForWeek(db, teamId, season, week);

  const averages = await loadAverages(db, [...roster.keys()], season, week, stored.rules);

  // Over the same id list the candidates are built from, deliberately: the set
  // means "off an NFL roster" by *membership*, so a set built over a narrower
  // list would silently exonerate everybody missing from it. Loaded outside the
  // transaction with the rest — it is not derived from the stored lineup.
  const offNflRoster = await loadOffNflRoster(db, [...roster.keys()]);

  // Only fetched when the league ranks on them. A league set to SEASON_AVERAGE
  // should not pay for a query whose result it ignores.
  const mode = stored.rules.roster.autofill;
  const projected =
    mode === "WEEKLY_PROJECTION"
      ? await loadProjectedPoints(db, season, week, stored.rules)
      : new Map<string, number>();

  /*
    Stashed players are not candidates.

    A player on injured reserve is on the roster and out of the rotation — that
    is what the slot is for. Leaving him in the pool would let the autofill start
    the very player his manager put aside as unable to play, and it would do it
    on a Sunday morning with nobody watching. He is also exempt from the roster
    limit while he sits there, so starting him would be having it both ways.
  */
  const candidates: AutolineupCandidate[] = [...roster.values()]
    .filter((player) => !player.onIr)
    .map((player) =>
      autolineupCandidate(
        player,
        {
          averageMilliPoints: averages.get(player.playerId) ?? null,
          projectedMilliPoints: projected.get(player.playerId) ?? null,
        },
        offNflRoster,
      ),
    );

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

    /*
      An empty candidate pool is how "tidy but pick nobody" is expressed, and it
      is not a trick. `autolineupChoices` copies every locked or kept slot
      through untouched and only consults the pool for the ones still open, so an
      empty pool leaves exactly the slots the manager set — minus anyone who has
      left the roster — and materialises the rest as empty.

      Materialising them matters as much as the tidying: `resolveWeek` throws on
      a team with no lineup at all, on the grounds that scoring it as zero would
      silently hand its opponent a free win. A team that is simply skipped here
      would take its whole league's week down with it.
    */
    const fillable = options?.fillEmptySlots === false ? [] : candidates;

    // `autolineupChoices`, not `autolineup`: the same fill, and it carries the
    // number each pick was ranked on, which is what 0047 records.
    const filled = autolineupChoices({
      shape: buildRosterShape(stored.rules.roster, NFL),
      roster: fillable,
      mode,
      locked: [...keep.values()],
      // The same clock the lock check above already used. A player whose game
      // has begun is not a candidate for a slot that is still open: writing him
      // there locks the slot around him, and the manager who was entitled to
      // decide it for another three hours is then refused by SLOT_LOCKED.
      //
      // Read inside the transaction, like everything else here. Hoisting the
      // pool out to save a read would make it a function of a pre-transaction
      // clock, which is the stale-snapshot shape #224 closed.
      now,
    });

    return setLineupUnchecked(
      tx,
      teamId,
      week,
      filled,
      current,
      slotTypeIds,
      stored.rules,
      now,
    );
  });
}

/**
 * Write a lineup without validating it.
 *
 * Only for the autolineup, whose output is already produced from this league's
 * own shape and this team's own roster, and which must succeed even when a
 * manager's own lineup would be rejected — an abandoned team still has to be
 * given one, and `requireFull` is the check it has to be exempt from.
 *
 * **That exemption covers shape, ownership and empty slots. It has never covered
 * locks.** `validateLineup` refuses to move a player into a slot once his own
 * game has kicked off, and every path through here skips that refusal — so the
 * caller owns the lock on both sides: `autoFillLineup` preserves an
 * already-locked slot by passing it in `locked`, and `autolineup` keeps a
 * started player out of the candidate pool with the `now` it requires. Neither
 * half is optional, and nothing below this line will catch a caller who forgets
 * one: the write is a compare-and-swap on the previous value, and a
 * compare-and-swap cannot tell a legal fill from an illegal one.
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
 * not fill on an earlier pass. The `::uuid` cast is kept for explicitness, not because it is required. This was
 * described here as load-bearing — "beside a uuid column a bare parameter is
 * unknown on the null path and Postgres cannot resolve the operator" — and
 * `setLineup`'s copy of this compare omits it and resolves against both PGlite
 * and Postgres. One of the two had to be wrong; measured, it was this sentence.
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
  assignments: readonly AutolineupChoice[],
  snapshot: readonly LineupAssignment[],
  slotTypeIds: ReadonlyMap<string, string>,
  rules: LeagueRules,
  now: number,
): Promise<readonly LineupAssignment[]> {
  const expected = new Map(
    snapshot.map((slot) => [`${slot.slotType}#${slot.slotIndex}`, slot.playerId]),
  );

  for (const assignment of assignments) {
    const slotTypeId = slotTypeIds.get(assignment.slotType);
    if (!slotTypeId) continue;

    /*
      The decision is stored beside the slot (issue #267, migration 0047).

      **Only where the autofill actually chose**, which `chosen` answers: a
      slot copied through because it was locked or already filled was not
      decided here, and writing nulls over it would erase the record of the pass
      that did decide it. A player with no record at all is chosen with both
      values null, and that is not the same thing — but it writes the same
      nulls, and stamping `autofilled_at` is what tells the two apart.

      `ranked_source` is the projections source only when a projection is what
      ranked him. A season average is computed from this league's own stat
      lines, which carry their own source per row.
    */
    const decided = assignment.chosen;

    await tx.query(
      `INSERT INTO lineups (
         team_id, week, slot_type_id, slot_index, player_id,
         autofilled_at, ranked_milli_points, ranked_on, ranked_source
       )
       VALUES ($1, $2, $3, $4, $5, $7, $8, $9, $10)
       ON CONFLICT (team_id, week, slot_type_id, slot_index)
       DO UPDATE SET player_id = EXCLUDED.player_id,
                     autofilled_at = CASE WHEN $11 THEN EXCLUDED.autofilled_at
                                          ELSE lineups.autofilled_at END,
                     ranked_milli_points = CASE WHEN $11 THEN EXCLUDED.ranked_milli_points
                                                ELSE lineups.ranked_milli_points END,
                     ranked_on = CASE WHEN $11 THEN EXCLUDED.ranked_on
                                      ELSE lineups.ranked_on END,
                     ranked_source = CASE WHEN $11 THEN EXCLUDED.ranked_source
                                          ELSE lineups.ranked_source END
        WHERE lineups.player_id IS NOT DISTINCT FROM $6::uuid`,
      [
        teamId,
        week,
        slotTypeId,
        assignment.slotIndex,
        assignment.playerId,
        expected.get(`${assignment.slotType}#${assignment.slotIndex}`) ?? null,
        decided ? new Date(now * 1000).toISOString() : null,
        decided ? assignment.rankedMilliPoints : null,
        decided ? assignment.rankedOn : null,
        decided && assignment.rankedOn === "PROJECTION" ? PRIMARY_PROJECTION_SOURCE : null,
        decided,
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
  options: {
    /**
     * What to do about teams that turned the autofill off.
     *
     * `"write"` materialises their empty slots, which is what scoring needs:
     * `resolveWeek` throws on a team with no lineup rows at all, and scoring a
     * missing team as zero hands its opponent a free win off our own bug.
     *
     * `"skip"` leaves them alone, and is for filling a week **before** its games
     * — where there is nothing to score yet and the rows would do harm: the
     * "empty slots, and autofill is off" notice counts every null row a member
     * has, in any week (`unsetLineups` in `notifications.ts`, no week predicate),
     * so writing them days early tells a manager they are late for a deadline
     * that has not arrived, for the one group the early fill cannot help.
     */
    readonly optedOutRows?: "write" | "skip";
  } = {},
): Promise<{
  teamsFilled: number;
  teamsOptedOut: number;
  /**
   * Teams whose roster is over the limit, so nobody was picked for them.
   *
   * Ids rather than a count, because a number in a cron body cannot be acted
   * on and the whole point is that an operator can name the team without
   * opening a database session.
   */
  teamsOverLimit: readonly string[];
}> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new LineupError("League has no rules", "LEAGUE_NOT_FOUND");

  const teams = await db.query<{ id: string; autofill_enabled: boolean; is_bot: boolean }>(
    "SELECT id, autofill_enabled, is_bot FROM teams WHERE league_id = $1 ORDER BY slot",
    [leagueId],
  );

  let teamsFilled = 0;
  let teamsOptedOut = 0;
  const teamsOverLimit: string[] = [];

  for (const team of teams) {
    /*
      Over the limit: tidied, never filled.

      Not a `continue`. A team skipped here gets no lineup rows at all, and
      `resolveWeek` throws on a team with none — so one manager's over-full
      roster would stop the whole league's week from scoring, and in a pot
      league block its settlement. The punishment would land on everybody
      except the person who caused it.

      Tidied rather than left alone because the autofill is the only thing that
      takes a released player out of a stored lineup. This manager is required
      to release somebody; leaving the lineup untouched would let the player
      they cut go on scoring for them, while being addable by anyone else.
    */
    const overage = await overageFor(db, team.id, stored.rules);
    if (overage.over) {
      // Tidying materialises the rest of the slots as empty, so on an early pass
      // it reaches the same manager the skip above protects — an autofill-off
      // team, over the limit, would be told days early that it has nine empty
      // slots. Their scoring-time pass still tidies, which is the one that
      // matters: nothing has kicked off yet here.
      const tidy = options.optedOutRows !== "skip" || team.is_bot || team.autofill_enabled;
      if (tidy) {
        await autoFillLineup(db, leagueId, team.id, week, now, { fillEmptySlots: false });
      }
      teamsOverLimit.push(team.id);
      continue;
    }

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
    //
    // Unless this is an early pass, which scores nothing and would only make
    // their "empty slots" notice fire days before the deadline — see `options`.
    if (options.optedOutRows !== "skip") await writeEmptySlots(db, leagueId, team.id, week);
    teamsOptedOut++;
  }

  return { teamsFilled, teamsOptedOut, teamsOverLimit };
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

/**
 * How many teams still have lineup work for `week` — none means an early pass
 * would write nothing, so it can be skipped.
 *
 * The early pass (issue #288) runs on every ten-minute tick from the Wednesday
 * until the week's first kickoff — around 250 runs — and each one otherwise does
 * the full autofill per team: the roster, the averages, a whole-week projections
 * scan and a locking transaction each. This turns the quiet ones into a query.
 *
 * Three things count as work, and the third is the one worth explaining:
 *
 * - **No rows at all**, which is every team on the first pass of a week.
 * - **An empty starting slot**, which the fill may be able to close now even if
 *   it could not before — a waiver claim or a trade has landed since.
 * - **A player in the lineup who is no longer on the roster.** `autoFillLineup`
 *   evicts him, and nothing else does. Leaving him there is not merely untidy:
 *   his slot locks at his kickoff around a player nobody rosters, and he goes on
 *   scoring for the team that cut him.
 *
 * That third clause is why this is not simply "has any row". For weeks 1-14 the
 * scoring-time fill would catch a Saturday drop anyway, since it runs from the
 * week's first kickoff — but **week 15 cannot be scored until week 14 finalises
 * on the Monday**, which is the whole of #288, so nothing else would reach it
 * before that week's slate had been played.
 *
 * The cost of being exact: a team whose roster genuinely cannot fill a slot —
 * one quarterback, nine starting slots — counts every time, so its league keeps
 * doing the work each tick. That is what every league did before this guard
 * existed, so it is never worse than the alternative, and it is rare in a league
 * that drafted.
 */
export async function teamsWithLineupWork(
  db: SqlClient,
  leagueId: string,
  week: number,
): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM teams t
      WHERE t.league_id = $1
        AND (t.is_bot OR t.autofill_enabled)
        AND (
          NOT EXISTS (SELECT 1 FROM lineups ln WHERE ln.team_id = t.id AND ln.week = $2)
          OR EXISTS (
            SELECT 1 FROM lineups ln
             WHERE ln.team_id = t.id AND ln.week = $2 AND ln.player_id IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM lineups ln
             WHERE ln.team_id = t.id AND ln.week = $2 AND ln.player_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM roster_entries re
                  WHERE re.team_id = t.id
                    AND re.player_id = ln.player_id
                    AND re.released_at IS NULL
               )
          )
        )`,
    [leagueId, week],
  );
  return Number(row?.n ?? 0);
}

/**
 * Empty every slot still holding a player this team has just released.
 *
 * **Releasing a player and standing him in a lineup are two different records,
 * and only one of them was being written.** `roster_entries.released_at` marks
 * him gone; the `lineups` row naming him stays exactly as it was. Scoring reads
 * the stored lineup and never asks who owns the player (`loadWeekLineups`), and
 * the slot locks at *his* kickoff with him still in it — so a manager could drop
 * a player on the Friday, keep him in Sunday's lineup, and be paid his points by
 * a team that no longer rostered him while everyone else was free to sign him.
 *
 * `autoFillLineup` already evicts him, which is why this was invisible: it
 * covers every team with the autofill on. A team that turned it off got
 * `writeEmptySlots`, which only materialises missing rows and evicts nobody — so
 * for those teams nothing ever removed him, in any week. Fixing it at the moment
 * of release covers both, and covers the weeks the autofill has not reached yet.
 *
 * ## What it may not touch
 *
 * **A week whose game he has already played.** That lineup is history — in a
 * finalised week it has decided a result, and in a live one the slot locked at
 * his kickoff, which is the rule that stops a manager reacting to a performance.
 * Releasing is refused after his own game starts (`GAME_STARTED`), so the week
 * being played is always safe to clear; what this excludes is the weeks behind
 * it. Hence both conditions: the week is not in the past, and no game of his
 * club's in that week has kicked off.
 *
 * The slot is left **empty**, never refilled. Filling it is the autofill's
 * decision to make on its own next pass, under its own rules, and a team that
 * turned the autofill off has said it wants neither.
 */
export async function clearReleasedFromLineups(
  db: SqlClient,
  teamId: string,
  playerId: string,
  season: number,
  fromWeek: number,
  now: Date,
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE lineups ln
        SET player_id = NULL
      WHERE ln.team_id = $1
        AND ln.player_id = $2
        AND ln.week >= $4
        AND NOT EXISTS (
          SELECT 1
            FROM games g
            JOIN players p ON p.id = $2
           WHERE g.sport_id = p.sport_id
             AND g.season = $3
             AND g.week = ln.week
             AND (g.home_team_ref = p.team_ref OR g.away_team_ref = p.team_ref)
             AND g.kickoff_at <= $5
        )
      RETURNING ln.id`,
    [teamId, playerId, season, fromWeek, now.toISOString()],
  );
  return rows.length;
}
