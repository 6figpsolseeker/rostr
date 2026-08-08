/**
 * Waivers and free agency, persisted.
 *
 * The rules are in `@rostr/core` — when a player clears, who wins a contested
 * claim, how priority moves. This module keeps the state those rules act on and
 * applies what they decide.
 *
 * ## Why a drop is not just a delete
 *
 * Dropping a player puts him somewhere. Held 24 hours or more, he goes to
 * **waivers** and is claimable only by blind claim until the next Wednesday run;
 * held less, he goes straight to **free agency**. That second rule is ESPN's and
 * it exists to stop a manager adding someone, cutting him hours later, and
 * re-adding him to dodge the queue.
 *
 * ## Processing is the part that has to be right
 *
 * `processWaivers` is where contested players are awarded, and it is the moment
 * a league is most likely to feel cheated. Two properties matter:
 *
 *   * **Blind.** Nobody sees anyone else's claims before they resolve, so the
 *     resolution cannot depend on submission order — and `resolveWaiverClaims`
 *     is written so it does not.
 *   * **Replayable.** The resolution is pure. Given the same claims, priority and
 *     rosters, it produces the same outcome, so a disputed run can be re-run
 *     exactly rather than argued about.
 *
 * Everything here does the loading and the writing; none of it decides.
 */

import {
  availabilityAt,
  buildRosterShape,
  dropDestination,
  initialWaiverPriority,
  NFL,
  nextProcessingAt,
  resolveWaiverClaims,
  waiverClearsAt,
} from "@rostr/core";
import type { DraftablePlayer, LeagueRules, WaiverClaim } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { getLeagueRules } from "./leagues.js";
import { loadDraftBoard } from "./sync.js";
import { withTransaction } from "./transaction.js";

export class WaiverError extends Error {
  constructor(
    message: string,
    readonly code:
      | "LEAGUE_NOT_FOUND"
      | "TEAM_NOT_IN_LEAGUE"
      | "NOT_ON_ROSTER"
      | "PLAYER_TAKEN"
      | "NOT_A_FREE_AGENT"
      | "NOT_ON_WAIVERS"
      | "ROSTER_FULL"
      | "DUPLICATE_CLAIM",
  ) {
    super(message);
    this.name = "WaiverError";
  }
}

export type Availability = "ROSTERED" | "ON_WAIVERS" | "FREE_AGENT";

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * Set the opening waiver order: the reverse of the draft order.
 *
 * The team that picked last claims first — the same balancing instinct the snake
 * applies within a round. Called when the draft completes.
 */
export async function seedWaiverPriority(db: SqlClient, leagueId: string): Promise<void> {
  const teams = await db.query<{ id: string }>(
    `SELECT id FROM teams
      WHERE league_id = $1 AND draft_position IS NOT NULL
      ORDER BY draft_position`,
    [leagueId],
  );
  if (teams.length === 0) return;

  const order = initialWaiverPriority(teams.map((team) => team.id));

  for (const [index, teamId] of order.entries()) {
    await db.query("UPDATE teams SET waiver_priority = $1 WHERE id = $2", [index + 1, teamId]);
  }
}

/** Team IDs in waiver priority order, best first. */
export async function loadWaiverPriority(
  db: SqlClient,
  leagueId: string,
): Promise<readonly string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM teams
      WHERE league_id = $1
      ORDER BY waiver_priority NULLS LAST, slot`,
    [leagueId],
  );

  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Where a player stands in a league right now.
 *
 * Three states, and the difference between the last two is the whole system: a
 * free agent is first come first served, a player on waivers is claimable only
 * by blind claim until the next processing run.
 */
export async function availabilityOf(
  db: SqlClient,
  leagueId: string,
  playerId: string,
  now: Date,
): Promise<Availability> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new WaiverError("League has no rules", "LEAGUE_NOT_FOUND");

  const [rostered] = await db.query<{ id: string }>(
    `SELECT r.id FROM roster_entries r
       JOIN teams t ON t.id = r.team_id
      WHERE t.league_id = $1 AND r.player_id = $2 AND r.released_at IS NULL`,
    [leagueId, playerId],
  );
  if (rostered) return "ROSTERED";

  const [wire] = await db.query<{ clears_at: string }>(
    "SELECT clears_at FROM waiver_wire WHERE league_id = $1 AND player_id = $2",
    [leagueId, playerId],
  );
  if (!wire) return "FREE_AGENT";

  // `clears_at` was computed when he landed. Re-deriving from it keeps one
  // definition of "cleared" rather than comparing timestamps in two places.
  return new Date(wire.clears_at) <= now ? "FREE_AGENT" : "ON_WAIVERS";
}

/** Everyone unrostered in a league, with their state and when they clear. */
export async function availablePlayers(
  db: SqlClient,
  leagueId: string,
  now: Date,
): Promise<
  readonly {
    playerId: string;
    fullName: string;
    positions: readonly string[];
    availability: Exclude<Availability, "ROSTERED">;
    clearsAt: Date | null;
  }[]
> {
  const rows = await db.query<{
    id: string;
    full_name: string;
    positions: string[];
    clears_at: string | null;
  }>(
    `SELECT p.id,
            p.full_name,
            array_agg(DISTINCT pos.key) AS positions,
            w.clears_at
       FROM players p
       JOIN positions pos
         ON pos.id = p.primary_position_id
         OR pos.id IN (SELECT position_id FROM player_eligible_positions WHERE player_id = p.id)
       JOIN leagues l ON l.id = $1 AND l.sport_id = p.sport_id
       LEFT JOIN waiver_wire w ON w.league_id = l.id AND w.player_id = p.id
      WHERE p.active
        AND NOT EXISTS (
          SELECT 1 FROM roster_entries r
            JOIN teams t ON t.id = r.team_id
           WHERE t.league_id = l.id AND r.player_id = p.id AND r.released_at IS NULL
        )
      GROUP BY p.id, p.full_name, w.clears_at`,
    [leagueId],
  );

  return rows.map((row) => {
    const clearsAt = row.clears_at ? new Date(row.clears_at) : null;
    return {
      playerId: row.id,
      fullName: row.full_name,
      positions: row.positions,
      availability:
        clearsAt && clearsAt > now ? ("ON_WAIVERS" as const) : ("FREE_AGENT" as const),
      clearsAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Dropping
// ---------------------------------------------------------------------------

/**
 * Release a player.
 *
 * Where he lands depends on how long he was held — see `dropDestination`. A
 * player held briefly goes straight to free agency, which is what stops the
 * add-cut-re-add trick from sidestepping the claim queue.
 */
export async function dropPlayer(
  db: SqlClient,
  leagueId: string,
  teamId: string,
  playerId: string,
  now: Date,
): Promise<{ destination: "WAIVERS" | "FREE_AGENT"; clearsAt: Date | null }> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new WaiverError("League has no rules", "LEAGUE_NOT_FOUND");

  return withTransaction(db, async (tx) => {
    const [entry] = await tx.query<{ id: string; acquired_at: string }>(
      `SELECT r.id, r.acquired_at FROM roster_entries r
         JOIN teams t ON t.id = r.team_id
        WHERE t.league_id = $1 AND r.team_id = $2 AND r.player_id = $3
          AND r.released_at IS NULL`,
      [leagueId, teamId, playerId],
    );
    if (!entry) throw new WaiverError("That player is not on this roster", "NOT_ON_ROSTER");

    await tx.query("UPDATE roster_entries SET released_at = $2 WHERE id = $1", [
      entry.id,
      now.toISOString(),
    ]);

    const destination = dropDestination(new Date(entry.acquired_at), now, stored.rules.waivers);

    if (destination === "FREE_AGENT") {
      // No wire row at all: absent means free, and a row that says "cleared in
      // the past" would mean the same thing twice.
      await tx.query("DELETE FROM waiver_wire WHERE league_id = $1 AND player_id = $2", [
        leagueId,
        playerId,
      ]);
      return { destination, clearsAt: null };
    }

    const clearsAt = waiverClearsAt(now, stored.rules.waivers);
    await tx.query(
      `INSERT INTO waiver_wire (league_id, player_id, clears_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (league_id, player_id) DO UPDATE SET clears_at = EXCLUDED.clears_at`,
      [leagueId, playerId, clearsAt.toISOString()],
    );

    return { destination, clearsAt };
  });
}

// ---------------------------------------------------------------------------
// Free agency
// ---------------------------------------------------------------------------

export interface AddInput {
  readonly leagueId: string;
  readonly teamId: string;
  readonly addPlayerId: string;
  /** Required when the roster is full. */
  readonly dropPlayerId?: string | null;
  readonly now: Date;
}

/**
 * Add a free agent, immediately.
 *
 * First come, first served — that is what "free agent" means. A player still on
 * waivers is refused, with a different code, because the manager needs to know
 * to submit a claim instead of retrying.
 */
export async function addFreeAgent(db: SqlClient, input: AddInput): Promise<void> {
  const stored = await getLeagueRules(db, input.leagueId);
  if (!stored) throw new WaiverError("League has no rules", "LEAGUE_NOT_FOUND");

  const availability = await availabilityOf(db, input.leagueId, input.addPlayerId, input.now);
  if (availability === "ROSTERED") {
    throw new WaiverError("Somebody already has that player", "PLAYER_TAKEN");
  }
  if (availability === "ON_WAIVERS") {
    throw new WaiverError(
      "That player is on waivers. Put in a claim instead — he is awarded by priority, not by who is fastest.",
      "NOT_A_FREE_AGENT",
    );
  }

  await withTransaction(db, async (tx) => {
    if (input.dropPlayerId) {
      // Inside the same transaction, so a full roster never briefly holds one
      // player too many and never briefly holds one too few.
      const [entry] = await tx.query<{ id: string }>(
        `SELECT id FROM roster_entries
          WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL`,
        [input.teamId, input.dropPlayerId],
      );
      if (!entry) throw new WaiverError("That player is not on this roster", "NOT_ON_ROSTER");

      await tx.query("UPDATE roster_entries SET released_at = $2 WHERE id = $1", [
        entry.id,
        input.now.toISOString(),
      ]);
    }

    const [count] = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM roster_entries WHERE team_id = $1 AND released_at IS NULL",
      [input.teamId],
    );
    const shape = buildRosterShape(stored.rules.roster, NFL);
    if (Number(count?.n ?? 0) >= shape.totalSlots) {
      throw new WaiverError("This roster is full — drop someone first", "ROSTER_FULL");
    }

    await tx.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
       VALUES ($1, $2, 'FREE_AGENT', $3)`,
      [input.teamId, input.addPlayerId, input.now.toISOString()],
    );

    await tx.query("DELETE FROM waiver_wire WHERE league_id = $1 AND player_id = $2", [
      input.leagueId,
      input.addPlayerId,
    ]);
  });

  // A dropped player has to land somewhere, and the destination depends on how
  // long *this* team held him — so it runs after the swap, not before.
  if (input.dropPlayerId) {
    await placeDroppedPlayer(db, input.leagueId, input.dropPlayerId, input.now, stored.rules);
  }
}

/** Put a released player on waivers or into free agency. */
async function placeDroppedPlayer(
  db: SqlClient,
  leagueId: string,
  playerId: string,
  now: Date,
  rules: LeagueRules,
): Promise<void> {
  const [entry] = await db.query<{ acquired_at: string }>(
    `SELECT r.acquired_at FROM roster_entries r
       JOIN teams t ON t.id = r.team_id
      WHERE t.league_id = $1 AND r.player_id = $2 AND r.released_at IS NOT NULL
      ORDER BY r.released_at DESC LIMIT 1`,
    [leagueId, playerId],
  );
  if (!entry) return;

  if (dropDestination(new Date(entry.acquired_at), now, rules.waivers) === "FREE_AGENT") return;

  await db.query(
    `INSERT INTO waiver_wire (league_id, player_id, clears_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (league_id, player_id) DO UPDATE SET clears_at = EXCLUDED.clears_at`,
    [leagueId, playerId, waiverClearsAt(now, rules.waivers).toISOString()],
  );
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * Put in a claim for a player on waivers.
 *
 * Nothing happens until processing. Claims are blind, so this deliberately tells
 * the claimant nothing about who else has claimed — and a failed claim costs
 * nothing, so there is no reason to hoard them.
 */
export async function submitClaim(
  db: SqlClient,
  input: AddInput,
): Promise<{ claimId: string }> {
  const availability = await availabilityOf(db, input.leagueId, input.addPlayerId, input.now);
  if (availability === "ROSTERED") {
    throw new WaiverError("Somebody already has that player", "PLAYER_TAKEN");
  }
  if (availability === "FREE_AGENT") {
    throw new WaiverError(
      "That player is a free agent — add him now rather than claiming him.",
      "NOT_ON_WAIVERS",
    );
  }

  const [existing] = await db.query<{ id: string }>(
    `SELECT id FROM waiver_claims
      WHERE league_id = $1 AND team_id = $2 AND add_player_id = $3 AND state = 'PENDING'`,
    [input.leagueId, input.teamId, input.addPlayerId],
  );
  if (existing) throw new WaiverError("You already claimed that player", "DUPLICATE_CLAIM");

  const [priority] = await db.query<{ waiver_priority: number | null }>(
    "SELECT waiver_priority FROM teams WHERE id = $1 AND league_id = $2",
    [input.teamId, input.leagueId],
  );
  if (!priority) throw new WaiverError("Team is not in this league", "TEAM_NOT_IN_LEAGUE");

  const [row] = await db.query<{ id: string }>(
    `INSERT INTO waiver_claims
       (league_id, team_id, add_player_id, drop_player_id, priority_at_claim)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      input.leagueId,
      input.teamId,
      input.addPlayerId,
      input.dropPlayerId ?? null,
      priority.waiver_priority,
    ],
  );

  return { claimId: row!.id };
}

/** Withdraw a pending claim. */
export async function cancelClaim(
  db: SqlClient,
  leagueId: string,
  teamId: string,
  claimId: string,
): Promise<void> {
  await db.query(
    `UPDATE waiver_claims SET state = 'CANCELLED'
      WHERE id = $1 AND league_id = $2 AND team_id = $3 AND state = 'PENDING'`,
    [claimId, leagueId, teamId],
  );
}

/** A team's own pending claims, in the order they will resolve. */
export async function pendingClaims(
  db: SqlClient,
  leagueId: string,
  teamId: string,
): Promise<readonly { claimId: string; addPlayerId: string; dropPlayerId: string | null }[]> {
  const rows = await db.query<{
    id: string;
    add_player_id: string;
    drop_player_id: string | null;
  }>(
    `SELECT id, add_player_id, drop_player_id FROM waiver_claims
      WHERE league_id = $1 AND team_id = $2 AND state = 'PENDING'
      ORDER BY created_at`,
    [leagueId, teamId],
  );

  return rows.map((row) => ({
    claimId: row.id,
    addPlayerId: row.add_player_id,
    dropPlayerId: row.drop_player_id,
  }));
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export interface WaiverRunOutcome {
  readonly leagueId: string;
  readonly awarded: number;
  readonly failed: number;
  readonly priorityAfter: readonly string[];
  readonly cleared: number;
}

/**
 * Resolve every pending claim in a league.
 *
 * The decision belongs entirely to `resolveWaiverClaims`; this loads its inputs
 * and writes its outputs. Everything happens in one transaction, so a run either
 * lands whole or not at all — a half-applied waiver run would leave rosters that
 * no rule produced.
 */
export async function processWaivers(
  db: SqlClient,
  leagueId: string,
  now: Date,
): Promise<WaiverRunOutcome> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new WaiverError("League has no rules", "LEAGUE_NOT_FOUND");

  const claims = await db.query<{
    id: string;
    team_id: string;
    add_player_id: string;
    drop_player_id: string | null;
  }>(
    `SELECT id, team_id, add_player_id, drop_player_id
       FROM waiver_claims WHERE league_id = $1 AND state = 'PENDING'`,
    [leagueId],
  );

  const priority = await loadWaiverPriority(db, leagueId);
  const board = await loadDraftBoard(db, stored.rules.sportKey, stored.rules.seasonYear);
  const pool = new Map<string, DraftablePlayer>(
    board.map((entry) => [
      entry.playerId,
      { playerId: entry.playerId, positions: entry.positions, rank: entry.rank },
    ]),
  );

  const rosterRows = await db.query<{ team_id: string; player_id: string }>(
    `SELECT r.team_id, r.player_id FROM roster_entries r
       JOIN teams t ON t.id = r.team_id
      WHERE t.league_id = $1 AND r.released_at IS NULL`,
    [leagueId],
  );

  const rosters = new Map<string, DraftablePlayer[]>(priority.map((teamId) => [teamId, []]));
  for (const row of rosterRows) {
    const player = pool.get(row.player_id);
    if (player) rosters.get(row.team_id)?.push(player);
  }

  const resolution = resolveWaiverClaims({
    claims: claims.map((row): WaiverClaim => ({
      claimId: row.id,
      teamId: row.team_id,
      addPlayerId: row.add_player_id,
      dropPlayerId: row.drop_player_id,
    })),
    priority,
    rosters,
    pool,
    shape: buildRosterShape(stored.rules.roster, NFL),
  });

  let awarded = 0;
  let failed = 0;

  await withTransaction(db, async (tx) => {
    for (const outcome of resolution.outcomes) {
      const claim = claims.find((row) => row.id === outcome.claimId)!;

      if (!outcome.awarded) {
        await tx.query(
          "UPDATE waiver_claims SET state = 'FAILED', processed_at = $2 WHERE id = $1",
          [outcome.claimId, now.toISOString()],
        );
        failed++;
        continue;
      }

      if (claim.drop_player_id) {
        await tx.query(
          `UPDATE roster_entries SET released_at = $3
            WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL`,
          [claim.team_id, claim.drop_player_id, now.toISOString()],
        );
      }

      await tx.query(
        `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
         VALUES ($1, $2, 'WAIVER', $3)`,
        [claim.team_id, claim.add_player_id, now.toISOString()],
      );

      await tx.query("DELETE FROM waiver_wire WHERE league_id = $1 AND player_id = $2", [
        leagueId,
        claim.add_player_id,
      ]);

      await tx.query(
        "UPDATE waiver_claims SET state = 'AWARDED', processed_at = $2 WHERE id = $1",
        [outcome.claimId, now.toISOString()],
      );
      awarded++;
    }

    // Winners move to the back, losers do not move at all. Written as the whole
    // order rather than as increments, because a partial update would leave two
    // teams sharing a priority.
    for (const [index, teamId] of resolution.priorityAfter.entries()) {
      await tx.query("UPDATE teams SET waiver_priority = $1 WHERE id = $2", [
        index + 1,
        teamId,
      ]);
    }
  });

  // Players nobody claimed become free agents once their wire time passes.
  // Removing the row is what makes them free — absent means available.
  const cleared = await db.query<{ player_id: string }>(
    `DELETE FROM waiver_wire
      WHERE league_id = $1 AND clears_at <= $2
      RETURNING player_id`,
    [leagueId, now.toISOString()],
  );

  // Anyone dropped in the same run must not be swept up by that clear: he landed
  // after it, and his own wire time has not passed.
  for (const claim of claims) {
    if (claim.drop_player_id) {
      await placeDroppedPlayer(db, leagueId, claim.drop_player_id, now, stored.rules);
    }
  }

  return {
    leagueId,
    awarded,
    failed,
    priorityAfter: resolution.priorityAfter,
    cleared: cleared.length,
  };
}

/** When this league's next waiver run is due. */
export function nextWaiverRun(rules: LeagueRules, now: Date): Date {
  return nextProcessingAt(now, rules.waivers);
}

/** Leagues whose waiver run is due and has not happened since. */
export async function leaguesDueForWaivers(
  db: SqlClient,
  now: Date,
): Promise<readonly string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT DISTINCT l.id
       FROM leagues l
       JOIN waiver_claims c ON c.league_id = l.id AND c.state = 'PENDING'
      WHERE l.state IN ('IN_SEASON', 'PLAYOFFS')`,
  );

  const due: string[] = [];
  for (const row of rows) {
    const stored = await getLeagueRules(db, row.id);
    if (!stored) continue;

    // The run this league is currently waiting for. If the next one is more than
    // a full cycle away, the moment has passed and claims are overdue.
    const [oldest] = await db.query<{ created_at: string }>(
      `SELECT min(created_at) AS created_at FROM waiver_claims
        WHERE league_id = $1 AND state = 'PENDING'`,
      [row.id],
    );
    if (!oldest?.created_at) continue;

    if (nextProcessingAt(new Date(oldest.created_at), stored.rules.waivers) <= now) {
      due.push(row.id);
    }
  }

  return due;
}

export { availabilityAt };
