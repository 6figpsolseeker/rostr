/**
 * The draft, persisted.
 *
 * The state machine lives in `@rostr/core` and is not duplicated here. This
 * module loads state out of Postgres, hands it to the engine, and writes back
 * what the engine decided. Every rule about what is a legal pick stays in one
 * place.
 *
 * ## What the database adds that the engine cannot
 *
 * The engine is single-threaded and pure. It has no way to arbitrate between two
 * managers who click at the same instant — both read "pick 15 is open", both
 * validate, both are right.
 *
 * So the ordering authority is the database, not the application:
 *
 *   1. `SELECT ... FOR UPDATE` on the draft row serialises picks within a draft.
 *      Picks are at most one per 90 seconds, so serialising costs nothing.
 *   2. `PRIMARY KEY (draft_id, pick_number)` and `UNIQUE (draft_id, player_id)`
 *      are the backstop. Even if the lock were bypassed, the second write fails.
 *
 * Belt and braces on purpose. The draft is the origin of every roster in the
 * league, and a duplicated player is not something you can fix afterwards.
 *
 * **Serialising is not the same as being right, and that distinction is the
 * whole of `recordPick`'s two guards.** The lock decides who writes first; it
 * cannot make a decision taken before the lock true afterwards. Two callers who
 * both read "pick 15 expired" are queued by the lock and then *both* write —
 * the second one taking pick 16 from a manager who has a full clock in hand.
 * Neither the primary key nor the unique index catches that: the picks are
 * different pick numbers and different players, so both are perfectly legal
 * rows. Only re-reading the decision inside the lock catches it.
 */

import {
  createDraft,
  currentPickNumber,
  currentTeam,
  generateDraftOrder,
  isComplete,
  makeAutoPick,
  makePick,
  pickDeadline,
  totalPicks,
} from "@rostr/core";
import { deriveOrderSeed } from "@rostr/core";
import type { DraftablePlayer, DraftPick, DraftState, RosterShape } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { isUniqueViolation } from "./pg-errors.js";
import type { RandomnessBeacon } from "./randomness.js";
import { withTransaction } from "./transaction.js";
import { seedWaiverPriority } from "./waivers.js";
import { generateSeasonSchedule } from "./week.js";

export class DraftPersistenceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "DRAFT_NOT_FOUND"
      | "DRAFT_EXISTS"
      | "NO_TEAMS"
      | "ORDER_INCOMPLETE"
      | "ORDER_NOT_DRAWN"
      | "ORDER_ALREADY_DRAWN"
      | "TOO_EARLY_TO_DRAW"
      | "RULES_MISSING"
      | "NOT_IN_PROGRESS"
      | "ALREADY_STARTED"
      | "PICK_RACE_LOST"
      | "CLOCK_EXPIRED",
  ) {
    super(message);
    this.name = "DraftPersistenceError";
  }
}

export interface DraftRecord {
  readonly draftId: string;
  readonly leagueId: string;
  readonly status: "SCHEDULED" | "IN_PROGRESS" | "PAUSED" | "COMPLETE";
  readonly rounds: number;
  readonly pickSeconds: number;
  readonly scheduledAt: Date;
  readonly clockStartedAt: Date | null;
  /**
   * The order draw, or `null` until it happens.
   *
   * Everything needed to check the order independently: the slot it came from,
   * that block's hash, and the seed they produce.
   */
  readonly draw: OrderDraw | null;
  /** Team IDs in round-1 order. Empty until the order is drawn. */
  readonly order: readonly string[];
  /** Reconstructed engine state, ready to pass to `makePick` / `makeAutoPick`. */
  readonly state: DraftState;
}

export interface OrderDraw {
  readonly seed: string;
  readonly slot: number;
  readonly blockhash: string;
  readonly drawnAt: Date;
}

interface DraftRow {
  id: string;
  league_id: string;
  status: DraftRecord["status"];
  rounds: number;
  pick_seconds: number;
  order_seed: string | null;
  order_slot: string | number | null;
  order_blockhash: string | null;
  order_drawn_at: string | null;
  scheduled_at: string;
  clock_started_at: string | null;
}

const DRAFT_COLUMNS = `id, league_id, status, rounds, pick_seconds, order_seed,
            order_slot, order_blockhash, order_drawn_at,
            scheduled_at, clock_started_at`;

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateDraftInput {
  readonly leagueId: string;
  readonly rounds: number;
  readonly pickSeconds: number;
  /** Frozen at league creation. The order draw keys off this instant. */
  readonly scheduledAt: Date;
}

/**
 * Schedule a draft.
 *
 * **No order is drawn here.** Teams may still be joining, and a seed that exists
 * while the field can still change is a seed a commissioner can grind against —
 * see `deriveOrderSeed`. The order comes later, from `drawDraftOrder`.
 */
export async function createDraftRecord(
  db: SqlClient,
  input: CreateDraftInput,
): Promise<DraftRecord> {
  return withTransaction(db, async (tx) => {
    const [existing] = await tx.query<{ id: string }>(
      "SELECT id FROM drafts WHERE league_id = $1",
      [input.leagueId],
    );
    if (existing) {
      throw new DraftPersistenceError(
        "This league already has a draft. Redrafting would invalidate every roster NFT already minted.",
        "DRAFT_EXISTS",
      );
    }

    const [draft] = await tx.query<DraftRow>(
      `INSERT INTO drafts (league_id, rounds, pick_seconds, scheduled_at)
       VALUES ($1, $2, $3, $4)
       RETURNING ${DRAFT_COLUMNS}`,
      [input.leagueId, input.rounds, input.pickSeconds, input.scheduledAt],
    );

    return toRecord(draft!, [], []);
  });
}

// ---------------------------------------------------------------------------
// Drawing the order
// ---------------------------------------------------------------------------

export interface DrawOrderInput {
  readonly leagueId: string;
  readonly beacon: RandomnessBeacon;
  readonly now: Date;
}

/**
 * Draw the draft order, once, from a block nobody could have predicted.
 *
 * The seed comes from the first Solana block produced at or after the league's
 * frozen `scheduledAt`. While teams were joining, that block did not exist, so
 * there was nothing to grind against; afterwards anyone can look up the slot and
 * recompute the order.
 *
 * Three things make the draw unrepeatable, and all three are needed:
 *
 *   * It refuses before `scheduledAt`. Drawing early is drawing from a block
 *     someone could still have influenced the field against.
 *   * The rule names exactly one block — the *first* at or after that instant —
 *     so there is no "try again a few slots later".
 *   * A database trigger rejects any later write to the draw or to any team's
 *     position, and locks the field the moment it lands.
 *
 * Being able to *check* the draw matters as much as making it. Everything a
 * sceptic needs is recorded; `explainOrderDraw` in `@rostr/core` prints the
 * instructions.
 */
export async function drawDraftOrder(
  db: SqlClient,
  input: DrawOrderInput,
): Promise<DraftRecord> {
  const [preflight] = await db.query<DraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE league_id = $1`,
    [input.leagueId],
  );
  if (!preflight) throw new DraftPersistenceError("League has no draft", "DRAFT_NOT_FOUND");

  if (preflight.order_drawn_at) {
    throw new DraftPersistenceError(
      `The order was already drawn from slot ${preflight.order_slot}`,
      "ORDER_ALREADY_DRAWN",
    );
  }

  const scheduledAt = new Date(preflight.scheduled_at);
  if (input.now < scheduledAt) {
    throw new DraftPersistenceError(
      `The order cannot be drawn until ${scheduledAt.toISOString()}, ` +
        `when the field locks and the deciding block is produced`,
      "TOO_EARLY_TO_DRAW",
    );
  }

  // Fetched outside the transaction: an RPC round trip should not hold a lock,
  // and the block is immutable once produced, so nothing changes underneath.
  const block = await input.beacon.firstBlockAtOrAfter(scheduledAt);

  return withTransaction(db, async (tx) => {
    const [draft] = await tx.query<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE league_id = $1 FOR UPDATE`,
      [input.leagueId],
    );
    if (!draft) throw new DraftPersistenceError("League has no draft", "DRAFT_NOT_FOUND");
    if (draft.order_drawn_at) {
      throw new DraftPersistenceError("The order was already drawn", "ORDER_ALREADY_DRAWN");
    }

    const [league] = await tx.query<{ rules_hash: string }>(
      "SELECT rules_hash FROM leagues WHERE id = $1",
      [input.leagueId],
    );
    if (!league) throw new DraftPersistenceError("League has no rules", "RULES_MISSING");

    // Ordered by join slot so the input to the shuffle is deterministic. Without
    // it the order would depend on how Postgres happened to return the rows, and
    // a seed anyone can check would produce an order nobody can reproduce.
    const teams = await tx.query<{ id: string }>(
      "SELECT id FROM teams WHERE league_id = $1 ORDER BY slot",
      [input.leagueId],
    );
    if (teams.length === 0) {
      throw new DraftPersistenceError("League has no teams to draft", "NO_TEAMS");
    }

    const seed = deriveOrderSeed({
      leagueId: input.leagueId,
      rulesHash: league.rules_hash,
      slot: block.slot,
      blockhash: block.blockhash,
    });

    const order = generateDraftOrder(
      teams.map((team) => team.id),
      seed,
    );

    for (const [index, teamId] of order.entries()) {
      await tx.query("UPDATE teams SET draft_position = $1 WHERE id = $2", [index + 1, teamId]);
    }

    // Last, so the field-lock trigger does not fire against our own writes.
    const [updated] = await tx.query<DraftRow>(
      `UPDATE drafts
          SET order_seed = $2, order_slot = $3, order_blockhash = $4, order_drawn_at = $5
        WHERE league_id = $1
        RETURNING ${DRAFT_COLUMNS}`,
      [input.leagueId, seed, block.slot, block.blockhash, input.now],
    );

    return toRecord(updated!, order, []);
  });
}

/**
 * Recompute a league's draft order from the recorded block and compare.
 *
 * What a suspicious member runs. It re-derives the seed, re-runs the shuffle,
 * checks the result against the stored positions, and — if the beacon is a real
 * one — confirms the recorded slot really is the first block at or after the
 * scheduled time.
 *
 * **A problem means the draw was checked and failed. An unreachable node throws
 * instead**, the same as an unreachable database does two lines below. The two
 * must not be collapsed: this function's output is an accusation, and a public
 * one at that, so "the RPC 429'd" must never be rendered as "slot 12345 is not
 * the first block at or after the scheduled time".
 */
export async function verifyDraftOrder(
  db: SqlClient,
  leagueId: string,
  beacon?: RandomnessBeacon,
): Promise<{ ok: boolean; problems: readonly string[] }> {
  const problems: string[] = [];

  const draft = await loadDraft(db, leagueId);
  if (!draft) return { ok: false, problems: ["League has no draft"] };
  if (!draft.draw) return { ok: false, problems: ["The order has not been drawn"] };

  const [league] = await db.query<{ rules_hash: string }>(
    "SELECT rules_hash FROM leagues WHERE id = $1",
    [leagueId],
  );
  if (!league) return { ok: false, problems: ["League has no rules"] };

  const seed = deriveOrderSeed({
    leagueId,
    rulesHash: league.rules_hash,
    slot: draft.draw.slot,
    blockhash: draft.draw.blockhash,
  });
  if (seed !== draft.draw.seed) {
    problems.push(`Recorded seed does not match the recorded block (expected ${seed})`);
  }

  const teams = await db.query<{ id: string }>(
    "SELECT id FROM teams WHERE league_id = $1 ORDER BY slot",
    [leagueId],
  );
  const expected = generateDraftOrder(
    teams.map((team) => team.id),
    seed,
  );
  if (expected.join(",") !== draft.order.join(",")) {
    problems.push("Stored draft positions do not match the order this seed produces");
  }

  if (beacon && !(await beacon.verify(draft.draw.slot, draft.scheduledAt))) {
    problems.push(
      `Slot ${draft.draw.slot} is not the first block at or after ${draft.scheduledAt.toISOString()}`,
    );
  }

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Load a league's draft, or `null` if it has none yet. */
export async function loadDraft(db: SqlClient, leagueId: string): Promise<DraftRecord | null> {
  const [draft] = await db.query<DraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE league_id = $1`,
    [leagueId],
  );
  if (!draft) return null;

  return hydrate(db, draft);
}

interface PickRow {
  pick_number: number;
  round: number;
  team_id: string;
  player_id: string;
  /**
   * Taken from the engine rather than restated. Writing the union out by hand
   * here is how the `draft_pick_source` enum and the engine drifted apart the
   * first time — this way a new source is a type error, not a runtime one.
   */
  source: DraftPick["source"];
}

async function hydrate(db: SqlClient, draft: DraftRow): Promise<DraftRecord> {
  // No draw yet means no order yet. That is the normal state of a league that is
  // still filling, not an error.
  if (!draft.order_drawn_at) return toRecord(draft, [], []);

  const teams = await db.query<{ id: string }>(
    `SELECT id FROM teams
      WHERE league_id = $1 AND draft_position IS NOT NULL
      ORDER BY draft_position`,
    [draft.league_id],
  );

  const [total] = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM teams WHERE league_id = $1",
    [draft.league_id],
  );
  if (teams.length !== Number(total?.count ?? 0)) {
    // A team without a draft position would silently drop out of the order, and
    // every pick after it would be attributed to the wrong manager. Triggers make
    // this unreachable; it stays as a guard because the cost of being wrong is a
    // whole season drafted against the wrong rotation.
    throw new DraftPersistenceError(
      `League ${draft.league_id} has ${total?.count} teams but only ${teams.length} draft positions`,
      "ORDER_INCOMPLETE",
    );
  }

  const picks = await db.query<PickRow>(
    `SELECT pick_number, round, team_id, player_id, source
       FROM draft_picks WHERE draft_id = $1 ORDER BY pick_number`,
    [draft.id],
  );

  return toRecord(
    draft,
    teams.map((team) => team.id),
    picks,
  );
}

function toRecord(
  draft: DraftRow,
  order: readonly string[],
  picks: readonly PickRow[],
): DraftRecord {
  return {
    draftId: draft.id,
    leagueId: draft.league_id,
    status: draft.status,
    rounds: Number(draft.rounds),
    pickSeconds: Number(draft.pick_seconds),
    draw:
      draft.order_drawn_at && draft.order_seed && draft.order_blockhash
        ? {
            seed: draft.order_seed,
            slot: Number(draft.order_slot),
            blockhash: draft.order_blockhash,
            drawnAt: new Date(draft.order_drawn_at),
          }
        : null,
    scheduledAt: new Date(draft.scheduled_at),
    clockStartedAt: draft.clock_started_at ? new Date(draft.clock_started_at) : null,
    order,
    state: {
      ...createDraft(order, Number(draft.rounds)),
      picks: picks.map((pick) => ({
        pickNumber: Number(pick.pick_number),
        round: Number(pick.round),
        teamId: pick.team_id,
        playerId: pick.player_id,
        source: pick.source,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Start the clock.
 *
 * Refuses until the order has been drawn. Without one there is no rotation, so
 * there is nobody on the clock and no answer to "whose pick is it".
 */
export async function startDraft(db: SqlClient, leagueId: string, now: Date): Promise<void> {
  const rows = await db.query<{ id: string }>(
    `UPDATE drafts
        SET status = 'IN_PROGRESS', clock_started_at = $2, started_at = COALESCE(started_at, $2)
      WHERE league_id = $1 AND status IN ('SCHEDULED', 'PAUSED')
        AND order_drawn_at IS NOT NULL
      RETURNING id`,
    [leagueId, now],
  );

  if (rows.length > 0) {
    // Nothing else moved league state, so a drafted league stayed FORMING
    // forever — which meant it kept accepting members and never appeared to any
    // job that works on live leagues.
    await db.query(
      "UPDATE leagues SET state = 'DRAFTING' WHERE id = $1 AND state = 'FORMING'",
      [leagueId],
    );
  }

  if (rows.length === 0) {
    const draft = await loadDraft(db, leagueId);
    if (!draft) throw new DraftPersistenceError("League has no draft", "DRAFT_NOT_FOUND");
    if (!draft.draw) {
      throw new DraftPersistenceError(
        "The draft order has not been drawn yet",
        "ORDER_NOT_DRAWN",
      );
    }
    throw new DraftPersistenceError(`Draft is already ${draft.status}`, "ALREADY_STARTED");
  }
}

/**
 * Pause the draft.
 *
 * The clock stops rather than continuing to run against a stopped draft. Whoever
 * is on the clock gets a full fresh timer when it resumes, which is the only
 * defensible behaviour — a manager should not lose sixty of their ninety seconds
 * to an outage they had nothing to do with.
 */
export async function pauseDraft(db: SqlClient, leagueId: string): Promise<void> {
  await db.query(
    `UPDATE drafts SET status = 'PAUSED', clock_started_at = NULL
      WHERE league_id = $1 AND status = 'IN_PROGRESS'`,
    [leagueId],
  );
}

export interface RecordPickInput {
  readonly leagueId: string;
  /** Omit for an auto-pick; the team on the clock is used. */
  readonly teamId?: string;
  /** Omit for an auto-pick. */
  readonly playerId?: string;
  /**
   * The pick number the caller believes is on the clock.
   *
   * Everything a caller works out — that a clock had expired, whose turn it was
   * — it works out from a snapshot read *before* the lock below is taken. Naming
   * the pick is how the caller says which pick that snapshot was about, so this
   * transaction can check the belief against the row it is holding rather than
   * acting on a claim about the past. If the pick has already been made, nothing
   * is recorded and the answer is `null`.
   *
   * Optional because a manual pick already names the picking team and the engine
   * checks the rotation. **Nothing enforces that an auto-pick supplies it** —
   * one that does not still gets the deadline guard, which is the half that
   * protects a manager's clock; the pick number is what makes a lost race a
   * silent no-op instead of a stolen pick. `catchUpExpiredPicks` supplies it.
   */
  readonly expectedPickNumber?: number;
  readonly pool: ReadonlyMap<string, DraftablePlayer>;
  readonly shape: RosterShape;
  readonly now: Date;
}

export interface RecordedPick {
  readonly pickNumber: number;
  readonly round: number;
  readonly teamId: string;
  readonly playerId: string;
  readonly source: PickRow["source"];
  readonly draftComplete: boolean;
  /** The team now on the clock, or `null` if the draft just finished. */
  readonly nextTeamId: string | null;
}

/**
 * Record one pick — manual if `teamId` and `playerId` are given, automatic
 * otherwise. `null` means the pick the caller meant had already been made.
 *
 * Both paths run through the same engine and the same write. An auto-pick that
 * took a different code path from a manual one would eventually diverge, and the
 * divergence would read to a manager as "the bot outdrafted me while I slept".
 *
 * **The clock decides which of the two paths is legal, and exactly one of them
 * is legal at any instant.** Before the deadline the pick belongs to its manager
 * and only a manual pick may take it; at the deadline it passes to the
 * auto-pick, stamped at the deadline it missed, and a manual pick is too late.
 * Both halves of that are enforced here, inside the lock, because both were
 * decided outside it:
 *
 *   * A manual pick that arrives late is **refused** (`CLOCK_EXPIRED`) rather
 *     than accepted and stamped `now`. Accepting it restarts the next manager's
 *     clock from whenever the late click landed, so one overrun is added to a
 *     baseline that never re-anchors and every clock after it silently
 *     stretches. That is the exact drift the deadline-stamped auto-pick exists
 *     to prevent, and it does not stop being drift because a human caused it.
 *   * An auto-pick whose clock has *not* expired records nothing. Its caller
 *     decided "overdue" against a snapshot; if another writer has since made
 *     that pick, the manager now on the clock has a full timer and taking their
 *     pick is unrecoverable — there is no un-pick, and `createDraftRecord`
 *     refuses a redraft.
 */
export async function recordPick(
  db: SqlClient,
  input: RecordPickInput,
): Promise<RecordedPick | null> {
  return withTransaction(db, async (tx) => {
    // Serialises every pick in this draft. Held until the transaction ends.
    const [locked] = await tx.query<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE league_id = $1 FOR UPDATE`,
      [input.leagueId],
    );
    if (!locked) throw new DraftPersistenceError("League has no draft", "DRAFT_NOT_FOUND");
    if (locked.status !== "IN_PROGRESS") {
      // A caller that named a pick decided outside this lock, so a draft that is
      // no longer running means it lost the race rather than that anything is
      // wrong: the winner's final pick completed the draft, or a commissioner
      // paused between the read and here. That is the same lost race the two
      // guards below treat as a no-op, and it has to answer the same way —
      // throwing would 500 every polling tab at the exact instant a draft
      // finishes, because the read route has no catch for it.
      //
      // A manual pick names no expected pick, so it still throws and still
      // surfaces as a 409. Somebody clicking on a paused draft wants to be told.
      if (input.expectedPickNumber !== undefined) return null;

      throw new DraftPersistenceError(`Draft is ${locked.status}`, "NOT_IN_PROGRESS");
    }

    const record = await hydrate(tx, locked);

    // ---- The two guards. Both live here, and neither replaces the other. ----
    //
    // Nothing extra is read for them: the row was locked above and hydrated on
    // the line before, so `pickSeconds`, `scheduledAt` and the picks made so far
    // are already in hand.
    //
    // The pick number catches a caller whose snapshot predates a pick somebody
    // else committed. The deadline catches a caller whose pick number is still
    // right but whose *clock* is not — a draft paused and resumed keeps the same
    // pick on the clock and starts a fresh timer, so a stale "it expired" from
    // before the pause would otherwise pass a pick-number check and auto-pick a
    // manager who has just been handed their full ninety seconds.
    if (
      input.expectedPickNumber !== undefined &&
      input.expectedPickNumber !== currentPickNumber(record.state)
    ) {
      return null;
    }

    const manual = input.teamId !== undefined && input.playerId !== undefined;
    const expired = isCurrentPickExpired(record, input.now);

    if (manual && expired) {
      // `expired` is only true with a clock running, so there is a deadline to
      // name. Told to the manager rather than "too late", because the number is
      // the whole answer: it says how late, and it is the instant the auto-pick
      // will be stamped at.
      const deadline = new Date(record.clockStartedAt!.getTime() + record.pickSeconds * 1000);
      throw new DraftPersistenceError(
        `This pick's clock ran out at ${deadline.toISOString()}; it belongs to the auto-pick now`,
        "CLOCK_EXPIRED",
      );
    }
    if (!manual && !expired) return null;

    const queues =
      input.teamId && input.playerId ? undefined : await loadQueues(tx, input.leagueId);

    const next =
      input.teamId && input.playerId
        ? makePick(record.state, {
            teamId: input.teamId,
            playerId: input.playerId,
            pool: input.pool,
            shape: input.shape,
          })
        : makeAutoPick(record.state, {
            pool: input.pool,
            shape: input.shape,
            ...(queues ? { queues } : {}),
          });

    const pick = next.picks[next.picks.length - 1]!;

    try {
      await tx.query(
        `INSERT INTO draft_picks (draft_id, pick_number, round, team_id, player_id, source)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [record.draftId, pick.pickNumber, pick.round, pick.teamId, pick.playerId, pick.source],
      );
    } catch (cause) {
      // Only a uniqueness violation means we lost a race. Anything else — a
      // missing player, a bad team — is a real fault and must surface as itself
      // rather than be relabelled as contention.
      if (!isUniqueViolation(cause)) throw cause;

      // The lock should make this unreachable. If it fires anyway, something
      // wrote outside the transaction, and the honest answer is to reject this
      // pick rather than guess which writer should win.
      throw new DraftPersistenceError(
        `Pick ${pick.pickNumber} (${pick.playerId}) was already recorded by another writer`,
        "PICK_RACE_LOST",
      );
    }

    // The draft is the origin of every roster in the league, so the pick lands
    // on the roster in the same transaction. A pick recorded without a roster
    // entry would leave a team owning a player nothing else could see.
    await tx.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
       VALUES ($1, $2, 'DRAFT', $3)`,
      [pick.teamId, pick.playerId, input.now],
    );

    // A drafted player is off everyone's queue. Leaving them would make the next
    // auto-pick reach for someone already gone.
    await tx.query(
      `DELETE FROM draft_queues
        WHERE player_id = $1
          AND team_id IN (SELECT id FROM teams WHERE league_id = $2)`,
      [pick.playerId, input.leagueId],
    );

    const complete = isComplete(next);
    if (complete) {
      await tx.query(
        `UPDATE drafts SET status = 'COMPLETE', clock_started_at = NULL, completed_at = $2
          WHERE id = $1`,
        [record.draftId, input.now],
      );

      // The season starts here, in the same transaction as the last pick.
      //
      // A league that finished drafting and had no fixtures would look finished
      // and be unplayable, and the schedule seed is the draft's own — already
      // from a Solana block nobody could predict, already recorded, so the
      // schedule is as checkable as the order.
      await tx.query("UPDATE leagues SET state = 'IN_SEASON' WHERE id = $1", [input.leagueId]);

      await generateSeasonSchedule(tx, input.leagueId, record.draw?.seed ?? record.draftId);

      // Reverse of the draft order — the team that picked last claims first,
      // which is the same balancing instinct the snake applies within a round.
      // Seeded here because it is the first moment there is a draft order to
      // reverse, and a league with no priority cannot process a claim.
      await seedWaiverPriority(tx, input.leagueId);
    } else {
      // The next manager's clock starts when the previous pick lands, not when
      // anyone loads the page.
      await tx.query("UPDATE drafts SET clock_started_at = $2 WHERE id = $1", [
        record.draftId,
        input.now,
      ]);
    }

    return {
      pickNumber: pick.pickNumber,
      round: pick.round,
      teamId: pick.teamId,
      playerId: pick.playerId,
      source: pick.source,
      draftComplete: complete,
      nextTeamId: complete ? null : currentTeam(next),
    };
  });
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

/**
 * Whether the pick on the clock has expired.
 *
 * Computed from `clock_started_at`, never scheduled. That is what lets a 24-hour
 * slow draft run with no timer infrastructure: a job wakes up, asks this, and
 * auto-picks if the answer is yes.
 */
export function isCurrentPickExpired(draft: DraftRecord, now: Date): boolean {
  if (draft.status !== "IN_PROGRESS" || !draft.clockStartedAt) return false;

  const deadline = pickDeadline(Math.floor(draft.clockStartedAt.getTime() / 1000), {
    type: "SNAKE",
    mode: draft.pickSeconds >= 3600 ? "SLOW" : "FAST",
    pickSeconds: draft.pickSeconds,
    scheduledAt: Math.floor(draft.scheduledAt.getTime() / 1000),
  });

  return Math.floor(now.getTime() / 1000) >= deadline;
}

export interface CatchUpInput {
  readonly leagueId: string;
  readonly pool: ReadonlyMap<string, DraftablePlayer>;
  readonly shape: RosterShape;
  readonly now: Date;
  /**
   * Safety stop.
   *
   * A whole 12-team draft is 168 picks, so a request that would make more than
   * that has hit a bug rather than a backlog, and grinding on would turn one bad
   * state into a timeout.
   */
  readonly maxPicks?: number;
}

/**
 * Auto-pick everything the clock has already passed.
 *
 * Expiry has to happen somewhere. `/api/cron/draft-tick` is the scheduled half,
 * but this also runs on every read of the draft, so "whoever triggers it" is a
 * large and uncoordinated set: the cron every minute, and every open tab, at one
 * second apiece while its manager is on the clock or on deck. The read route
 * needs no session, so an anonymous caller who knows the league id is in that
 * set too.
 *
 * **Safe to run concurrently, and that safety is bought, not free.** The read at
 * the top of each iteration happens outside the lock the write then takes, so by
 * the time the write holds the row its decision may be several picks out of
 * date. Nothing here can prevent that; what prevents the damage is that
 * `recordPick` re-checks both halves of the decision — the pick number and the
 * deadline — inside the lock and records nothing if either has moved. Without
 * that, N callers all seeing pick N expire would make N *consecutive* picks:
 * pick N legitimately, then picks N+1 and N+2 for managers whose full clock had
 * just started, unrecoverably, since there is no un-pick and no redraft.
 *
 * **Losing that race is a no-op, not an error.** This returns the number of
 * picks it made itself and throws nothing when another writer got there first —
 * the draft read route calls it with no try/catch, so a throw would turn every
 * polling tab into a 500 at the exact instant a draft advances.
 *
 * What it makes is still a function of the stored state and the clock alone, so
 * the picks are the same whoever calls and however often — the count differs
 * only in that it counts this caller's own work.
 *
 * **The old limitation stands for the read path: a draft nobody is looking at
 * does not advance until the cron fires.** That is why the cron must fire at
 * least as often as the shortest pick clock.
 */
export async function catchUpExpiredPicks(db: SqlClient, input: CatchUpInput): Promise<number> {
  const limit = input.maxPicks ?? 200;
  let made = 0;

  for (let guard = 0; guard < limit; guard++) {
    const draft = await loadDraft(db, input.leagueId);
    if (!draft || draft.status !== "IN_PROGRESS" || !draft.clockStartedAt) break;
    if (!isCurrentPickExpired(draft, input.now)) break;

    // Stamped at the deadline it missed, **not** at `now`.
    //
    // Stamping `now` would restart the next manager's clock from the moment
    // somebody happened to open the page: an hour of nobody watching would cost
    // exactly one pick, and every clock after it would have been silently
    // extended by however long the room sat empty. Advancing deadline by
    // deadline keeps the draft on real time, so the picks that expired are the
    // picks that expire.
    //
    // It is also what makes the deadline guard below self-checking: `now` is the
    // deadline of the pick this iteration means, so once that pick lands the
    // next clock runs from it and the same instant is no longer expiry.
    const deadline = new Date(draft.clockStartedAt.getTime() + draft.pickSeconds * 1000);

    const recorded = await recordPick(db, {
      leagueId: input.leagueId,
      expectedPickNumber: currentPickNumber(draft.state),
      pool: input.pool,
      shape: input.shape,
      now: deadline,
    });

    // Somebody else made this pick between the read above and the lock inside.
    // Nothing to do and nothing wrong: the pick this iteration came to make has
    // been made, by a caller running this same loop. Stopping rather than
    // re-reading keeps a lost race read-only — the winner is still inside its
    // own loop working through the rest of the backlog, and the next tick or
    // poll takes anything it does not.
    if (!recorded) break;
    made++;
  }

  return made;
}

/** Every draft with an expired clock — the queue a timer job works through. */
export async function draftsWithExpiredPicks(
  db: SqlClient,
  now: Date,
): Promise<readonly string[]> {
  const rows = await db.query<{ league_id: string }>(
    `SELECT league_id FROM drafts
      WHERE status = 'IN_PROGRESS'
        AND clock_started_at IS NOT NULL
        AND clock_started_at + (pick_seconds * interval '1 second') <= $1`,
    [now],
  );

  return rows.map((row) => row.league_id);
}

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

/**
 * Replace a team's queue wholesale.
 *
 * Delete-then-insert rather than a patch, so there is no window in which the
 * queue is half-reordered. If a clock expires mid-write, the transaction means
 * the auto-pick sees either the old queue or the new one, never a mix.
 */
export async function setQueue(
  db: SqlClient,
  teamId: string,
  playerIds: readonly string[],
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query("DELETE FROM draft_queues WHERE team_id = $1", [teamId]);

    for (const [index, playerId] of playerIds.entries()) {
      await tx.query(
        "INSERT INTO draft_queues (team_id, player_id, rank) VALUES ($1, $2, $3)",
        [teamId, playerId, index + 1],
      );
    }
  });
}

/** A team's queue, best first. */
export async function getQueue(db: SqlClient, teamId: string): Promise<readonly string[]> {
  const rows = await db.query<{ player_id: string }>(
    "SELECT player_id FROM draft_queues WHERE team_id = $1 ORDER BY rank",
    [teamId],
  );

  return rows.map((row) => row.player_id);
}

/** Every team's queue in a league, keyed by team ID. */
export async function loadQueues(
  db: SqlClient,
  leagueId: string,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const rows = await db.query<{ team_id: string; player_id: string }>(
    `SELECT q.team_id, q.player_id
       FROM draft_queues q
       JOIN teams t ON t.id = q.team_id
      WHERE t.league_id = $1
      ORDER BY q.team_id, q.rank`,
    [leagueId],
  );

  const queues = new Map<string, string[]>();
  for (const row of rows) {
    const queue = queues.get(row.team_id) ?? [];
    queue.push(row.player_id);
    queues.set(row.team_id, queue);
  }

  return queues;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface DraftProgress {
  readonly picksMade: number;
  readonly totalPicks: number;
  readonly currentPickNumber: number | null;
  readonly currentTeamId: string | null;
  readonly complete: boolean;
}

export function draftProgress(draft: DraftRecord): DraftProgress {
  const total = totalPicks(draft.order.length, draft.rounds);
  const made = draft.state.picks.length;
  const complete = isComplete(draft.state);

  return {
    picksMade: made,
    totalPicks: total,
    currentPickNumber: complete ? null : made + 1,
    currentTeamId: complete ? null : currentTeam(draft.state),
    complete,
  };
}
