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
 * **waivers** and is claimable only by blind claim until the run he clears at —
 * the first processing run a full waiver period after he landed, which for a
 * drop late in the cycle is the Wednesday *after* next, not the next one;
 * held less, he goes straight to **free agency**. That second rule is ESPN's and
 * it exists to stop a manager adding someone, cutting him hours later, and
 * re-adding him to dodge the queue.
 *
 * ## Processing is the part that has to be right
 *
 * `processWaivers` is where contested players are awarded, and it is the moment
 * a league is most likely to feel cheated. Two properties matter:
 *
 *   * **Blind.** Nobody sees anyone else's claims before they resolve, so no
 *     team's outcome may depend on when another team filed — and
 *     `resolveWaiverClaims` is written so it does not: waiver priority decides
 *     every contest between teams, and submission time only orders a team's own
 *     claims against each other. This used to say the resolution "cannot depend
 *     on submission order" at all. That is stronger than blindness needs, and it
 *     was untrue of the code: two claims by one team tie on priority and the
 *     sort fell through to a v4 UUID.
 *   * **Replayable.** The resolution is pure. Given the same claims, priority and
 *     rosters, it produces the same outcome, so a disputed run can be re-run
 *     exactly rather than argued about.
 *
 * Everything here does the loading and the writing; none of it decides.
 */

import {
  availabilityAt,
  everyoneIsOnWaivers,
  buildRosterShape,
  countedRosterSize,
  isIrEligible,
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
import { isUniqueViolation } from "./pg-errors.js";
import { loadDraftBoard } from "./sync.js";
import { lockedByTrade } from "./trades.js";
import { withTransaction } from "./transaction.js";
import { transactionWeek } from "./week.js";

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
      | "DUPLICATE_CLAIM"
      | "IN_A_TRADE"
      | "GAME_STARTED",
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
 * by blind claim until the run at which he clears.
 *
 * The `<=` against `clears_at` below is the definition of "cleared", and
 * `processWaivers` compares the same way against the same column. It did not,
 * and the two disagreeing by a week is what let a claim be awarded while this
 * function still answered `ON_WAIVERS` for the same player at the same instant.
 */
export async function availabilityOf(
  db: SqlClient,
  leagueId: string,
  playerId: string,
  now: Date,
): Promise<Availability> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new WaiverError("League has no rules", "LEAGUE_NOT_FOUND");

  // Keyed on exactly what `roster_entries_one_owner_per_league` is keyed on, so
  // the answer this gives and the answer the index enforces cannot be derived
  // from different notions of "in this league".
  const [rostered] = await db.query<{ id: string }>(
    `SELECT r.id FROM roster_entries r
      WHERE r.league_id = $1 AND r.player_id = $2 AND r.released_at IS NULL`,
    [leagueId, playerId],
  );
  if (rostered) return "ROSTERED";

  const [wire] = await db.query<{ clears_at: string }>(
    "SELECT clears_at FROM waiver_wire WHERE league_id = $1 AND player_id = $2",
    [leagueId, playerId],
  );

  // No wire row means free — **except inside the weekly lock**, when `RULES.md`
  // §6 puts every unrostered player back on waivers. See `everyoneIsOnWaivers`
  // for why that is a derived default rather than a job that writes a row per
  // player. Without this the table members sign describes a cycle the code does
  // not run, and a breakout is taken by whoever refreshes fastest on Sunday
  // night rather than allocated by priority on Wednesday.
  if (!wire) {
    return everyoneIsOnWaivers(now, stored.rules.waivers) ? "ON_WAIVERS" : "FREE_AGENT";
  }

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
    /** Display only. Nothing in the waiver rules reads any of these. */
    imageUrl: string | null;
    teamRef: string | null;
    injuryDesignation: string | null;
  }[]
> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new WaiverError("League has no rules", "LEAGUE_NOT_FOUND");

  const rows = await db.query<{
    id: string;
    full_name: string;
    positions: string[];
    clears_at: string | null;
    image_url: string | null;
    team_ref: string | null;
    injury_designation: string | null;
  }>(
    `SELECT p.id,
            p.full_name,
            array_agg(DISTINCT pos.key) AS positions,
            w.clears_at,
            p.image_url,
            p.team_ref,
            p.injury_designation
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
      GROUP BY p.id, p.full_name, w.clears_at,
               p.image_url, p.team_ref, p.injury_designation`,
    [leagueId],
  );

  const locked = everyoneIsOnWaivers(now, stored.rules.waivers);

  return rows.map((row) => {
    const clearsAt = row.clears_at ? new Date(row.clears_at) : null;
    return {
      playerId: row.id,
      fullName: row.full_name,
      positions: row.positions,
      // The exact complement of `availabilityOf`, including the weekly lock —
      // the two must not be able to disagree, because this decides what the
      // screen offers and that decides what the server accepts.
      availability:
        (clearsAt && clearsAt > now) || locked
          ? ("ON_WAIVERS" as const)
          : ("FREE_AGENT" as const),
      clearsAt,
      imageUrl: row.image_url,
      teamRef: row.team_ref,
      injuryDesignation: row.injury_designation,
    };
  });
}

// ---------------------------------------------------------------------------
// Kickoff locks
// ---------------------------------------------------------------------------

/**
 * Refuse to move a player whose own game has already started.
 *
 * `docs/RULES.md` §6 has said this since the constitution was frozen, and it was
 * implemented nowhere:
 *
 * > A player cannot be added or dropped once **his own game has kicked off**.
 * > Otherwise a manager could cut an injured player mid-game, or add one after
 * > his touchdown.
 *
 * Members signed that. Both halves of the exploit it names were live: cutting a
 * started player reopened the lineup slot he was in, and — because a released
 * player's points are still scored from the stored lineup — cutting one who had
 * *already* done well kept his points and freed the roster spot for somebody
 * else, so a twelve-man roster fielded thirteen contributors.
 *
 * **This guards the two member-initiated paths only.** `processWaivers` and
 * `resolveTrade` also release roster rows, and neither can refuse: a throw
 * inside the waiver run rolls back the whole league's run and leaves the claim
 * PENDING forever, and a trade the league already approved cannot be undone
 * because a game started. Those two are covered instead by the lineup lock now
 * keying on the player rather than the roster, which makes the release harmless
 * wherever it comes from. Closing the outcome and closing the route are
 * different jobs and this repo needs both — the same argument `ASSET_GONE`
 * makes for trades.
 *
 * ## The lock releases when the week does, and getting that wrong is a worse bug
 *
 * §2 says a locked player "cannot be moved **for that week**", so the lock is
 * week-scoped. The first version of this asked `currentWeek`, which answers "the
 * week of the most recent kickoff" — and that keeps answering week N right up
 * until week N+1's Thursday. So it refused every add and drop for the three days
 * *after* a week's games ended, swallowing the Tuesday turnover and most of the
 * free-agency window §6's own cycle table opens at Wednesday 03:00 ET.
 *
 * The release point is the **weekly lock** — `waivers.weeklyLock`, Tuesday 00:00
 * ET by default, already in the frozen rules, so this needs no new field and
 * cannot move a rules hash. It is the moment the transaction week turns over,
 * and it falls after the last Monday-night whistle, which matters: releasing at
 * the week's last *kickoff* instead would reopen the exploit during that game.
 *
 * ## Silent, not refusing, in three cases — each for its own reason
 *
 * No live week, no game row for this player, or no schedule at all. §6 refuses a
 * player "once **his own game** has kicked off"; a player with no game this week
 * has no game to have started, so there is nothing to refuse.
 *
 * That is deliberately *not* the fail-closed direction `isSlotLocked` takes on
 * the same data, and the difference is the point. `loadKickoffs` synthesises the
 * week's first kickoff for a player whose team matches no game (`lineups.ts` —
 * its case three), which is right for a lineup slot and wrong here: `team_ref`
 * is nullable, so every unsigned free agent matches nothing, and consuming that
 * synthesis would make the entire free-agent pool unaddable for most of every
 * week. This asks for the player's own game directly instead.
 */
/**
 * Take the roster row and hold it, so a decision made about it stays true.
 *
 * **`FOR UPDATE OF r`, not a bare `FOR UPDATE`, and the league comes from the
 * row rather than a join.** A bare `FOR UPDATE` on a joined query locks a row in
 * *every* table in the FROM list — so joining `teams` for league scoping would
 * quietly take a lock on the team row as well. `processWaivers` holds the league
 * row and ends by updating `teams.waiver_priority`; a drop holding a `teams` row
 * and waiting on a roster row the run has already released is a deadlock cycle
 * that does not exist today only because this function did not lock at all.
 *
 * `roster_entries.league_id` has been `NOT NULL` and trigger-maintained since
 * migration `0022`, so the join was never needed for correctness — and
 * `availabilityOf` and `processWaivers` already read it directly.
 */
async function lockRosterRow(
  tx: SqlClient,
  leagueId: string,
  teamId: string,
  playerId: string,
): Promise<{ id: string; acquired_at: string } | undefined> {
  const [entry] = await tx.query<{ id: string; acquired_at: string }>(
    `SELECT r.id, r.acquired_at FROM roster_entries r
      WHERE r.league_id = $1 AND r.team_id = $2 AND r.player_id = $3
        AND r.released_at IS NULL
      FOR UPDATE OF r`,
    [leagueId, teamId, playerId],
  );
  return entry;
}

/**
 * Refuse to release a player an accepted trade has committed.
 *
 * Between acceptance and execution the players are in escrow: `docs/RULES.md` §6
 * says a committed player "cannot be dropped, claimed away, or entered into a
 * second trade", and that sentence is in the document members sign. It was true
 * of exactly one of the three paths that release a roster row.
 *
 * **`addFreeAgent`'s drop leg was the hole**, and it needed no concurrency: a
 * manager could accept a trade and then cut the player they promised through the
 * add-with-drop button, one request, no race. Worse than it sounds in a
 * multi-asset trade — `resolveTrade` throws `ASSET_GONE` and rolls back, so
 * dropping the *cheapest* frozen asset destroys the whole trade and hands the
 * proposer back everything else. `withdrawTrade` refuses after acceptance
 * precisely to prevent that ("it is now up to the league"), and `RULES.md` §9
 * denies the power even to the commissioner.
 *
 * ## Call it inside the transaction, after the roster row is locked
 *
 * `acceptTrade` already documents why, twenty lines away: *"Take every row lock
 * first, and only then read the freeze set."* Read the other way round and both
 * callers compute a freeze set before either takes a lock; the loser blocks,
 * wakes after the winner commits, re-checks a snapshot that predates it, and
 * passes. `dropPlayer` did exactly that — read on `db`, before `withTransaction`,
 * with no lock — so an `acceptTrade` committing in between left a trade
 * `ACCEPTED`, the state whose whole meaning is "these players are frozen", with
 * its player on waivers.
 *
 * **This is correct only under READ COMMITTED**, which is Postgres's default and
 * what `withTransaction`'s bare `BEGIN` gets. Each statement takes a fresh
 * snapshot, so this read — issued *after* the lock was granted — sees any
 * `acceptTrade` that committed before it. Under REPEATABLE READ it would read
 * the transaction's original snapshot and silently revert to the bug.
 */
async function refuseIfFrozen(
  tx: SqlClient,
  leagueId: string,
  playerId: string,
): Promise<void> {
  const committed = await lockedByTrade(tx, leagueId);
  if (committed.has(playerId)) {
    throw new WaiverError(
      "That player is committed to an accepted trade and cannot be dropped until it resolves",
      "IN_A_TRADE",
    );
  }
}

async function refuseIfKickedOff(
  db: SqlClient,
  rules: LeagueRules,
  playerId: string,
  now: Date,
  verb: "added" | "dropped",
): Promise<void> {
  const week = await transactionWeek(db, rules, now);
  if (week === null) return;

  // This player's own game, and only his. Season-scoped, sport-scoped, and no
  // fallback — an absent row means he does not play this week.
  const [row] = await db.query<{ kickoff_at: string }>(
    `SELECT g.kickoff_at
       FROM players p
       JOIN games g
         ON g.sport_id = p.sport_id
        AND g.season = $2
        AND g.week = $3
        AND (g.home_team_ref = p.team_ref OR g.away_team_ref = p.team_ref)
      WHERE p.id = $1
      ORDER BY g.kickoff_at
      LIMIT 1`,
    [playerId, rules.seasonYear, week],
  );
  if (!row) return;

  if (now.getTime() >= new Date(row.kickoff_at).getTime()) {
    throw new WaiverError(
      `That player's game has already kicked off, so he cannot be ${verb} this week.`,
      "GAME_STARTED",
    );
  }
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
    const entry = await lockRosterRow(tx, leagueId, teamId, playerId);
    if (!entry) throw new WaiverError("That player is not on this roster", "NOT_ON_ROSTER");

    // **After the lock, not before.** Both of these used to run on `db` above,
    // outside the transaction — see `refuseIfFrozen` for what that cost.
    //
    // The ownership check comes first now, and that is a small improvement of
    // its own: a team that does not hold the player used to be told
    // `IN_A_TRADE`, which discloses that a trade exists involving somebody
    // else's player.
    await refuseIfFrozen(tx, leagueId, playerId);
    await refuseIfKickedOff(tx, stored.rules, playerId, now, "dropped");

    // Leaving IR is part of leaving the roster. `0038` asserts
    // `CHECK (NOT on_ir OR released_at IS NULL)` — an IR slot belongs to a
    // rostered player — and this UPDATE violated it outright, so a manager
    // simply could not release anyone they had placed there.
    await tx.query("UPDATE roster_entries SET released_at = $2, on_ir = false WHERE id = $1", [
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

  // Both halves of `RULES.md` §6, on both players. The add half stops "add one
  // after his touchdown" — harmless today only because `PLAYER_LOCKED` refuses
  // to start him, which is a second line rather than the rule itself. The drop
  // half matters more: it is the same release `dropPlayer` guards, reached
  // through a different button, and without it the guard there is decorative.
  await refuseIfKickedOff(db, stored.rules, input.addPlayerId, input.now, "added");
  if (input.dropPlayerId) {
    await refuseIfKickedOff(db, stored.rules, input.dropPlayerId, input.now, "dropped");
  }

  await withTransaction(db, async (tx) => {
    // A shared lock on the league, held for the whole add.
    //
    // It does not exclude other adds — `FOR SHARE` does not conflict with itself,
    // and Wednesday morning is precisely when a league is all adding at once.
    // What it excludes is `processWaivers`, which takes `FOR UPDATE` on the same
    // row because it resolves against a league-wide snapshot of every roster.
    // An add landing mid-run makes that snapshot stale.
    //
    // **This is defence in depth, not the thing that makes the run safe.** The
    // window it closes is the sub-millisecond one *during* a run; the window
    // that actually matters is the hour between a player clearing waivers and
    // the next cron, when he reads as a free agent with a claim still
    // outstanding against him. `processWaivers` closes that itself by dropping
    // claims for players already held, which it must do whether or not this
    // lock exists.
    //
    // Adds racing *each other* are arbitrated below, by the index, not by a lock.
    await tx.query("SELECT id FROM leagues WHERE id = $1 FOR SHARE", [input.leagueId]);

    // Inside the transaction, not before it. Read on `db` and written on `tx`,
    // this answered a question about a moment that had already passed by the time
    // the insert ran: two managers adding the same free agent both saw
    // FREE_AGENT, both inserted, and one player ended the week on two rosters —
    // started, scored twice, and unrecoverable once the week finalised.
    //
    // Moving it in narrows the window; it does not close it, because in READ
    // COMMITTED a concurrent inserter can still commit between this SELECT and
    // the INSERT below. The index is what closes it. This check survives because
    // it is the only thing that can tell FREE_AGENT from ON_WAIVERS, and those
    // need different answers.
    const availability = await availabilityOf(tx, input.leagueId, input.addPlayerId, input.now);
    if (availability === "ROSTERED") {
      throw new WaiverError("Somebody already has that player", "PLAYER_TAKEN");
    }
    if (availability === "ON_WAIVERS") {
      throw new WaiverError(
        "That player is on waivers. Put in a claim instead — he is awarded by priority, not by who is fastest.",
        "NOT_A_FREE_AGENT",
      );
    }

    if (input.dropPlayerId) {
      // Inside the same transaction, so a full roster never briefly holds one
      // player too many and never briefly holds one too few.
      //
      // **Locked, and the freeze read after it.** This is the same release
      // `dropPlayer` performs, reached through a different button, and until now
      // it asked none of the questions that one asks — so an accepted trade's
      // player could be cut here with no concurrency at all. The comment above
      // makes exactly this argument about the kickoff lock ("without it the
      // guard there is decorative") and it applies unchanged to the freeze.
      const entry = await lockRosterRow(tx, input.leagueId, input.teamId, input.dropPlayerId);
      if (!entry) throw new WaiverError("That player is not on this roster", "NOT_ON_ROSTER");

      await refuseIfFrozen(tx, input.leagueId, input.dropPlayerId);

      // Same as `dropPlayer`: releasing clears the IR slot, or `0038`'s check
      // refuses the swap.
      await tx.query(
        "UPDATE roster_entries SET released_at = $2, on_ir = false WHERE id = $1",
        [entry.id, input.now.toISOString()],
      );
    }

    /*
      Roster capacity, with injured reserve subtracted.

      `totalSlots` is starters plus bench and has always excluded IR — the
      rules said so and nothing acted on it. What changed is that genuinely
      stashed players are now taken out of the count before the comparison.

      **The designation is read here, live.** A player who recovers while on IR
      stops being exempt at that moment and counts again, which is the owner's
      rule that somebody on IR must actually be injured. Nothing is dropped or
      moved to enforce it: the team simply finds itself at capacity, which is a
      state they already understand and can fix by activating him.
    */
    const held = await tx.query<{
      player_id: string;
      on_ir: boolean;
      designation: string | null;
    }>(
      `SELECT r.player_id, r.on_ir, p.injury_designation AS designation
         FROM roster_entries r
         JOIN players p ON p.id = r.player_id
        WHERE r.team_id = $1 AND r.released_at IS NULL`,
      [input.teamId],
    );
    const shape = buildRosterShape(stored.rules.roster, NFL);
    const counted = countedRosterSize(
      held.map((row) => ({
        playerId: row.player_id,
        onIr: row.on_ir,
        injuryDesignation: row.designation,
      })),
      shape.irSlots,
    );
    if (counted >= shape.totalSlots) {
      throw new WaiverError("This roster is full — drop someone first", "ROSTER_FULL");
    }

    // The arbitration, and the only part of it that holds under concurrency.
    // `roster_entries_one_owner_per_league` (migration `0022`) is unique on
    // (league, player) among unreleased rows, so of two simultaneous adds the
    // loser blocks on the index entry until the winner commits and then fails —
    // which is the same fact the check above reports, arriving later.
    //
    // Wrapped around this one statement rather than the transaction, so a unique
    // violation from anywhere else could not be relabelled as contention.
    //
    // Two unique indexes exist on this table — the primary key and the
    // one-owner-per-league index. The key is `gen_random_uuid()`, so in practice
    // only the second is reachable here; the constraint name is not matched,
    // which means a *future* unique index on this table would be silently
    // reported as `PLAYER_TAKEN`. If one is ever added, narrow this.
    try {
      await tx.query(
        `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
         VALUES ($1, $2, 'FREE_AGENT', $3)`,
        [input.teamId, input.addPlayerId, input.now.toISOString()],
      );
    } catch (cause) {
      if (!isUniqueViolation(cause)) throw cause;
      throw new WaiverError("Somebody already has that player", "PLAYER_TAKEN");
    }

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
 *
 * **`created_at` is left to the database, and that now decides something.** The
 * column defaults to `now()` and this function deliberately does not write
 * `input.now`, so the order a team's own claims are tried in comes from the
 * server clock at the instant each INSERT commits and no caller can name it.
 * Since that order became load-bearing, that is a property rather than an
 * omission: a writable submission time is a way to file a claim and then move it
 * to the front of your own queue. `input.now` decides availability only.
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

/**
 * A team's own pending claims, newest last — which is the order they will be
 * tried in.
 *
 * **Their order relative to each other, and nothing further.** Waiver priority
 * decides every contest against another team, and a claim for a player who has
 * not cleared yet waits for a later run than one filed after it — so this
 * predicts neither who wins nor which run resolves it. It used to say it was
 * "not the order they resolve in" at all, which stopped being true when the
 * intra-team tiebreak stopped being a random UUID.
 */
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
  /**
   * Claims left PENDING because their player has not cleared waivers yet.
   *
   * **Not collapsed into "nothing happened".** A run that defers three claims
   * and a run with no work look identical from `awarded`/`failed`/`cleared`, and
   * they are different facts — only the first explains to whoever is watching
   * why a manager's claim is still outstanding. Same argument as
   * `finalizedWithUnfinishedGames` on the week outcome.
   *
   * It is also the only trace this leaves. A wrongly-early award used to destroy
   * its own evidence: the wire row carrying `clears_at` is deleted as part of
   * awarding, and nothing else stores it.
   */
  readonly deferred: number;
  readonly priorityAfter: readonly string[];
  readonly cleared: number;
}

/**
 * Resolve every pending claim whose player has cleared waivers.
 *
 * The decision belongs entirely to `resolveWaiverClaims`; this loads its inputs
 * and writes its outputs. Everything happens in one transaction, so a run either
 * lands whole or not at all — a half-applied waiver run would leave rosters that
 * no rule produced.
 *
 * **Not every pending claim, and the difference is a signed rule.** A claim
 * filed against a player who has not served his waiver period stays PENDING and
 * is resolved by a later run. It is deferred, never failed.
 *
 * **The inputs are read inside that transaction too.** They were not, and the gap
 * was the whole bug: every roster in the league was read on `db`, resolved
 * against, and written on `tx` — so anything that changed a roster in between
 * (another run of this function, a free-agent add) was invisible to a decision
 * that had already been made. Two overlapping runs each awarded the same player.
 */
export async function processWaivers(
  db: SqlClient,
  leagueId: string,
  now: Date,
): Promise<WaiverRunOutcome> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new WaiverError("League has no rules", "LEAGUE_NOT_FOUND");

  // Reference data, not league state: the same rows for every league and every
  // run, and nothing a concurrent writer can move underneath us. Loaded before
  // the transaction so the league lock is held for as little time as possible.
  const board = await loadDraftBoard(db, stored.rules.sportKey, stored.rules.seasonYear);
  const pool = new Map<string, DraftablePlayer>(
    board.map((entry) => [
      entry.playerId,
      { playerId: entry.playerId, positions: entry.positions, rank: entry.rank },
    ]),
  );
  const shape = buildRosterShape(stored.rules.roster, NFL);

  const run = await withTransaction(db, async (tx) => {
    // One waiver run per league at a time. The cron is hourly and idempotent by
    // intent, but a slow run and a retry can overlap, and two runs resolving
    // against the same pre-run rosters both award the same player to different
    // teams. `addFreeAgent` takes `FOR SHARE` on this row, so an add cannot land
    // between the read below and the writes either.
    await tx.query("SELECT id FROM leagues WHERE id = $1 FOR UPDATE", [leagueId]);

    // No `ORDER BY`: `resolveWaiverClaims` sorts, and one here would suggest the
    // array order it is handed matters. It must not.
    const claims = await tx.query<{
      id: string;
      team_id: string;
      add_player_id: string;
      drop_player_id: string | null;
      created_at: string;
    }>(
      `SELECT id, team_id, add_player_id, drop_player_id, created_at
         FROM waiver_claims WHERE league_id = $1 AND state = 'PENDING'`,
      [leagueId],
    );

    const priority = await loadWaiverPriority(tx, leagueId);

    /*
      The same two IR columns `addFreeAgent` reads, and for the same reason.

      Until #237 this query took `team_id, player_id` only, so the capacity
      comparison downstream counted stashed players against the roster limit —
      while `addFreeAgent`, three hundred lines up, subtracted them. A signed
      `irSlots` allowance bought room in the first-come market and none in the
      priority-allocated one, which is the market `RULES.md` §6 exists to make
      fair.
    */
    const rosterRows = await tx.query<{
      team_id: string;
      player_id: string;
      on_ir: boolean;
      designation: string | null;
    }>(
      `SELECT r.team_id, r.player_id, r.on_ir, p.injury_designation AS designation
         FROM roster_entries r
         JOIN players p ON p.id = r.player_id
        WHERE r.league_id = $1 AND r.released_at IS NULL`,
      [leagueId],
    );

    const rosters = new Map<string, DraftablePlayer[]>(priority.map((teamId) => [teamId, []]));

    /*
      Built **inside the same filter** as `rosters`, and that is load-bearing.

      A rostered player absent from the draft board is already missing from the
      array the resolver counts. Exempting him as well would subtract him twice
      and conjure a roster slot out of an unrelated gap, so an exemption is only
      ever recorded for a player who was actually counted. One loop, one filter,
      and the two cannot disagree.

      The designation is read live, so a player who has recovered stops being
      exempt at this run. Nothing is moved or dropped to enforce that; the team
      simply finds itself at capacity again.
    */
    const irExempt = new Set<string>();
    for (const row of rosterRows) {
      const player = pool.get(row.player_id);
      if (!player) continue;
      rosters.get(row.team_id)?.push(player);
      if (row.on_ir && isIrEligible(row.designation)) irExempt.add(row.player_id);
    }

    /**
     * Players somebody in this league already holds.
     *
     * `resolveWaiverClaims` does not consult rosters for ownership — it checks
     * the pool, what this run has already awarded, and the claiming team's own
     * shape. So a claim for a player another team picked up *since the claim was
     * filed* is awarded, and the insert then violates
     * `roster_entries_one_owner_per_league`.
     *
     * That window is not narrow. `clears_at` is a processing instant and the
     * cron is hourly, so every Wednesday there is a stretch in which a player
     * with an outstanding claim reads as a free agent and can simply be added.
     * Nothing cancels the claim when that happens.
     *
     * Before the league-scoped index, both writes landed and two teams held him.
     * After it, the run would abort — and because the claim stays PENDING and
     * the roster is unchanged, **every later run would abort identically**,
     * wedging the league's waivers permanently rather than for an hour. Filtering
     * here is what makes the no-catch policy below honest, and it gives the
     * manager the true answer: the claim failed because somebody else has him.
     */
    const alreadyHeld = new Set(rosterRows.map((row) => row.player_id));

    /**
     * Players whose waiver period has not elapsed yet.
     *
     * **The run must not award a player before he clears**, and until this
     * existed it did. `waiverClearsAt` rounds a drop up to the first processing
     * run at least `waiverPeriodDays` later, and the runs are weekly — so a drop
     * in the 24 hours before a run rounds up by a whole week, while the run
     * itself is hours away. `docs/RULES.md` §6 names that exact case: "someone
     * dropped on Tuesday evening does not clear the next morning, which would
     * leave the rest of the league no real chance to claim him." He did.
     *
     * **A missing row means clear, never blocked.** An absent wire row is what
     * "free agent" *is* everywhere else in this module, and a claim can outlive
     * its row — the sweep below removes it, and so does an add. An inner join
     * here would leave those claims PENDING forever, retried hourly, which is
     * the permanent wedge the filter above exists to prevent.
     *
     * **`<=`, matching `availabilityOf` and the sweep exactly.** `clears_at` is
     * itself a processing instant and this runs at processing instants, so
     * equality is the ordinary case rather than a boundary curiosity: a `<` here
     * would defer every ordinary claim by a week, and would defer a claim in the
     * same run that the sweep below frees his player to whoever is fastest.
     */
    const wireRows = await tx.query<{ player_id: string; clears_at: string }>(
      "SELECT player_id, clears_at FROM waiver_wire WHERE league_id = $1",
      [leagueId],
    );
    const clearsAt = new Map(wireRows.map((row) => [row.player_id, new Date(row.clears_at)]));
    const notYetClear = (playerId: string): boolean => {
      const clears = clearsAt.get(playerId);
      return clears !== undefined && clears.getTime() > now.getTime();
    };

    /**
     * Claims whose *drop* player an accepted trade has committed.
     *
     * **A third exclusion set, and it has to be computed before resolution —
     * not checked when the award is written.** `resolveWaiverClaims` marks a
     * player taken the moment a claim wins him, and fails every later claim for
     * him with `PLAYER_TAKEN`. So refusing the winner's award afterwards leaves
     * the runner-up already rejected and the player awarded to nobody: one
     * manager's frozen drop would quietly deny the player to the whole league.
     * Filtering here lets the next priority win him, which is what the rules
     * say should happen.
     *
     * **Failed, not deferred.** The freeze is temporary — at most the veto
     * window plus cron lag — so deferring looks tempting. It does not help: the
     * sweep below deletes the *add* player's wire row in this same run, so he
     * becomes a free agent within the hour and is gone before any later run
     * could award him. `RULES.md` §6 says a failed claim costs nothing and
     * priority moves only on success, so the manager re-files with a different
     * drop and loses nothing but the week. Deferring would also make
     * `deferred`'s own docstring false — it says "has not cleared waivers yet",
     * which is a statement about the add player's wire clock, not this.
     *
     * `processWaivers` cannot refuse by throwing, unlike the two member-facing
     * paths: the whole run is one transaction, so a throw rolls back every award
     * and leaves every claim PENDING for the next run to fail on identically.
     * That is the permanent wedge this module's other filters exist to avoid.
     */
    const frozen = await lockedByTrade(tx, leagueId);
    const dropIsFrozen = (row: { drop_player_id: string | null }): boolean =>
      row.drop_player_id !== null && frozen.has(row.drop_player_id);

    const resolution = resolveWaiverClaims({
      claims: claims
        .filter(
          (row) =>
            !alreadyHeld.has(row.add_player_id) &&
            !notYetClear(row.add_player_id) &&
            !dropIsFrozen(row),
        )
        .map((row): WaiverClaim => ({
          claimId: row.id,
          teamId: row.team_id,
          addPlayerId: row.add_player_id,
          dropPlayerId: row.drop_player_id,
          // Wrapped, following this file's convention for timestamp columns:
          // both drivers hand `timestamptz` back as a `Date` already, and the
          // wrap normalises the string shape too if one ever stops.
          submittedAt: new Date(row.created_at),
        })),
      priority,
      rosters,
      pool,
      shape,
      irExempt,
    });

    let awarded = 0;
    let failed = 0;

    // **Three filters above, and two of them are failures.**
    //
    // A claim for a player somebody already holds can never succeed, and one
    // naming a frozen player as its drop cannot be honoured as written — both
    // are written FAILED here, because leaving them PENDING would retry them
    // hourly forever. A claim for a player who has not cleared yet is not
    // failed, it is *early*: it stays PENDING deliberately and is resolved by
    // the run after he clears.
    //
    // So this loop keys on those two sets specifically. Do not "simplify" it to
    // "anything missing from `resolution.outcomes` failed" — that would turn
    // every deferral into a permanent rejection, silently, and the manager would
    // be told their claim lost to a player nobody had.
    for (const row of claims) {
      if (!alreadyHeld.has(row.add_player_id) && !dropIsFrozen(row)) continue;

      // The reason is known here and nowhere else: these two never reach the
      // resolver, so its `ClaimFailure` cannot speak for them. Recording the
      // resolver's vocabulary keeps one set of words for one idea.
      await tx.query(
        `UPDATE waiver_claims SET state = 'FAILED', processed_at = $2, failure_reason = $3
          WHERE id = $1`,
        [
          row.id,
          now.toISOString(),
          alreadyHeld.has(row.add_player_id) ? "ALREADY_ROSTERED" : "DROP_NOT_ON_ROSTER",
        ],
      );
      failed++;
    }

    // Players this run actually released, which is not the same as every player
    // any pending claim happens to name. See the loop below the transaction.
    const dropped: string[] = [];

    for (const outcome of resolution.outcomes) {
      const claim = claims.find((row) => row.id === outcome.claimId)!;

      if (!outcome.awarded) {
        // `resolveWaiverClaims` already decided why, and it was being thrown
        // away. The four reasons are not interchangeable — one says somebody
        // outranked you, one says your own roster had no room.
        await tx.query(
          `UPDATE waiver_claims SET state = 'FAILED', processed_at = $2, failure_reason = $3
            WHERE id = $1`,
          [outcome.claimId, now.toISOString(), outcome.reason ?? null],
        );
        failed++;
        continue;
      }

      if (claim.drop_player_id) {
        /*
          `on_ir = false` for the same reason as every other release, and this
          is the site where omitting it cost the most.

          The whole run is one transaction, so `0038`'s check did not refuse one
          claim — it rolled back the entire league's cycle. The claims stayed
          PENDING, `leaguesDueForWaivers` re-selected the league on the next
          hourly tick, and it failed identically. A league with one manager
          dropping an IR'd player as part of a claim would never have processed
          a waiver again.
        */
        await tx.query(
          `UPDATE roster_entries SET released_at = $3, on_ir = false
            WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL`,
          [claim.team_id, claim.drop_player_id, now.toISOString()],
        );
        dropped.push(claim.drop_player_id);
      }

      // No `try` around this one, unlike `addFreeAgent`. There, a unique
      // violation is an ordinary outcome to report to one manager; here it would
      // mean the locked, in-transaction snapshot above was still wrong, and the
      // honest answer is to roll the whole run back rather than quietly drop a
      // claim from a resolution that is meant to be replayable.
      //
      // That is only defensible because claims for players already held are
      // dropped before resolving. Without that filter the case is not
      // exceptional at all — it is every Wednesday — and rolling back would
      // leave the claim PENDING and the roster unchanged, so the next run would
      // fail identically. A league whose waivers never process again is a far
      // worse answer than a dropped claim.
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

    // Everything the run neither awarded nor failed: still PENDING, waiting for
    // its player to clear. Reported rather than inferred — a league with three
    // deferred claims and a league with nothing to do are different facts, and
    // only the first explains why a manager's claim is still outstanding.
    const deferred = claims.length - awarded - failed;

    return {
      awarded,
      failed,
      deferred,
      dropped,
      priorityAfter: resolution.priorityAfter,
    };
  });

  const { awarded, failed, deferred, dropped } = run;

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
  //
  // **Players this run released, not players some pending claim mentions.** It
  // used to walk every pending claim, so a claim that failed — or, now that
  // claims can be deferred, one that has simply not resolved yet — re-dated the
  // wire row of a player it never touched. That is somebody else's player: a
  // manager who legitimately dropped him watched his `clears_at` pushed a week
  // further out by a stranger's losing claim, hourly, for as long as the claim
  // sat there. Since `waiverClearsAt(now) > now` always, he could never clear.
  for (const playerId of dropped) {
    await placeDroppedPlayer(db, leagueId, playerId, now, stored.rules);
  }

  return {
    leagueId,
    awarded,
    failed,
    deferred,
    priorityAfter: run.priorityAfter,
    cleared: cleared.length,
  };
}

/** When this league's next waiver run is due. */
export function nextWaiverRun(rules: LeagueRules, now: Date): Date {
  return nextProcessingAt(now, rules.waivers);
}

/**
 * Which leagues are due, and which could not be asked.
 *
 * A bare `string[]` was the old shape and it had nowhere to put a failure, so
 * the only options were to throw — taking every league down with one — or to
 * skip in silence. Neither is acceptable for a job nobody watches: a league that
 * can never process another claim has to be distinguishable from one with
 * nothing due, and most leagues have nothing due most hours.
 */
export interface WaiverDueSelection {
  readonly due: readonly string[];
  /**
   * Leagues whose due-ness could not be computed.
   *
   * Every path that declines to answer for a league lands here — the two
   * `continue`s below included. They said "never empty silently" while skipping
   * in exactly the way that sentence forbade; both are unreachable in
   * production, which is a reason to keep the claim true cheaply rather than a
   * reason to have made it falsely.
   */
  readonly problems: readonly { readonly leagueId: string; readonly error: string }[];
}

export async function leaguesDueForWaivers(
  db: SqlClient,
  now: Date,
): Promise<WaiverDueSelection> {
  const rows = await db.query<{ id: string }>(
    `SELECT DISTINCT l.id
       FROM leagues l
       JOIN waiver_claims c ON c.league_id = l.id AND c.state = 'PENDING'
      WHERE l.state IN ('IN_SEASON', 'PLAYOFFS')`,
  );

  const due: string[] = [];
  const problems: { leagueId: string; error: string }[] = [];

  for (const row of rows) {
    /*
      One league's failure must not decide for the others, and **selection is
      inside that rule as much as processing is** — issue #131.

      The cron has guarded `processWaivers` per league since it was written, and
      this call sat **above** that loop — before it in program order, not in
      time. (An earlier draft of this comment said the guard did not yet exist,
      which is not what happened and makes the bug sound older than it was.) So
      a throw here escaped the guard and 500'd the whole route: no league's
      waivers ran, deterministically, every hour. That is the shape `CLAUDE.md`
      documents under "One league's failure never stops the others", which counts
      waivers among the routes that do it correctly — true of the loop it was
      looking at, and the reason the rule needs stating about *selection* too.

      **Not silently.** The route already stamped `cron_runs` and rethrew, so
      `pnpm cron:status` read FAILING throughout. What it could not say was
      *which* league, which is what `problems` adds.

      Four things in here can throw for one league: `getLeagueRules` issues a
      query and then `JSON.parse`s what it finds, the `min(created_at)` query
      below is a second round trip, and `nextProcessingAt` walks
      `rules.waivers`. Both of the cheap content-level causes are now closed —
      the timezone by `validateLeagueRules` and the weekday by #230 — so the
      guard is latent, and deliberately kept: it is about the shape rather than
      any one cause.
    */
    try {
      const stored = await getLeagueRules(db, row.id);
      if (!stored) {
        // Unrepresentable — `createLeague` writes both rows in one transaction
        // and `league_rules` carries a DELETE trigger. Reported rather than
        // skipped so the type's promise above is true of every path.
        problems.push({ leagueId: row.id, error: "league has no stored rules" });
        continue;
      }

      // The run this league is currently waiting for. If the next one is more
      // than a full cycle away, the moment has passed and claims are overdue.
      const [oldest] = await db.query<{ created_at: string }>(
        `SELECT min(created_at) AS created_at FROM waiver_claims
          WHERE league_id = $1 AND state = 'PENDING'`,
        [row.id],
      );
      if (!oldest?.created_at) {
        // Also unrepresentable: the selection query joins a PENDING claim, so
        // one exists by construction. Same reasoning as above.
        problems.push({ leagueId: row.id, error: "no pending claim to date the run from" });
        continue;
      }

      if (nextProcessingAt(new Date(oldest.created_at), stored.rules.waivers) <= now) {
        due.push(row.id);
      }
    } catch (error) {
      /*
        Recorded, never swallowed. A selection that quietly skipped a league
        would look identical to a league with nothing due — the state this
        function reports for most leagues most hours.

        **This does not mean the league is permanently stuck**, and an earlier
        version of this comment said it did. Catching by shape is right, and its
        price is that a transient fault — a statement timeout, a dropped
        connection, a deadlock on either query above — arrives here looking
        exactly like an unparseable rule set. Both are reported; only one
        recovers unaided next hour. Do not let the reporting copy claim a
        permanence the catch cannot establish.

        Caught by shape rather than by class, deliberately — but note the rule it
        follows is `CLAUDE.md`'s "if you find yourself adding an error class to an
        allowlist inside a per-league loop, the allowlist is the bug", which came
        out of #38 in `score-week`. It is a rule this change obeys, not the
        defect this change is about; those are different, and conflating them
        made #131 sound like a repeat of a bug it has nothing to do with.
      */
      problems.push({
        leagueId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { due, problems };
}

export { availabilityAt };
