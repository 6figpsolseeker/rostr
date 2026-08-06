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
 */

import {
  createDraft,
  currentTeam,
  generateDraftOrder,
  isComplete,
  makeAutoPick,
  makePick,
  pickDeadline,
  totalPicks,
} from "@rostr/core";
import type { DraftablePlayer, DraftPick, DraftState, RosterShape } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { withTransaction } from "./transaction.js";

/** Postgres `unique_violation`. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export class DraftPersistenceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "DRAFT_NOT_FOUND"
      | "DRAFT_EXISTS"
      | "NO_TEAMS"
      | "ORDER_INCOMPLETE"
      | "NOT_IN_PROGRESS"
      | "ALREADY_STARTED"
      | "PICK_RACE_LOST",
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
  readonly orderSeed: string;
  readonly scheduledAt: Date;
  readonly clockStartedAt: Date | null;
  /** Team IDs in round-1 order. */
  readonly order: readonly string[];
  /** Reconstructed engine state, ready to pass to `makePick` / `makeAutoPick`. */
  readonly state: DraftState;
}

interface DraftRow {
  id: string;
  league_id: string;
  status: DraftRecord["status"];
  rounds: number;
  pick_seconds: number;
  order_seed: string;
  scheduled_at: string;
  clock_started_at: string | null;
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateDraftInput {
  readonly leagueId: string;
  readonly rounds: number;
  readonly pickSeconds: number;
  /**
   * Seed for the order.
   *
   * **This is a security decision, not a formality.** A seed known before the
   * field is locked can be ground: add a bot, compute the order, remove it, try
   * another. It must be unpredictable until after the last team joins — a Solana
   * slot hash at or after the frozen `scheduledAt`. See `generateDraftOrder`.
   */
  readonly orderSeed: string;
  readonly scheduledAt: Date;
}

/**
 * Create the draft and draw the order.
 *
 * The order is written to `teams.draft_position` in the same transaction, so
 * there is no moment at which a draft exists without one.
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

    // Ordered by slot so the input to the shuffle is deterministic. Without it
    // the order would depend on how Postgres happened to return the rows, and a
    // seed anyone can check would produce an order nobody can reproduce.
    const teams = await tx.query<{ id: string }>(
      "SELECT id FROM teams WHERE league_id = $1 ORDER BY slot",
      [input.leagueId],
    );
    if (teams.length === 0) {
      throw new DraftPersistenceError("League has no teams to draft", "NO_TEAMS");
    }

    const order = generateDraftOrder(
      teams.map((team) => team.id),
      input.orderSeed,
    );

    const [draft] = await tx.query<DraftRow>(
      `INSERT INTO drafts (league_id, rounds, pick_seconds, order_seed, scheduled_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, league_id, status, rounds, pick_seconds, order_seed,
                 scheduled_at, clock_started_at`,
      [input.leagueId, input.rounds, input.pickSeconds, input.orderSeed, input.scheduledAt],
    );

    for (const [index, teamId] of order.entries()) {
      await tx.query("UPDATE teams SET draft_position = $1 WHERE id = $2", [index + 1, teamId]);
    }

    return toRecord(draft!, order, []);
  });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Load a league's draft, or `null` if it has none yet. */
export async function loadDraft(db: SqlClient, leagueId: string): Promise<DraftRecord | null> {
  const [draft] = await db.query<DraftRow>(
    `SELECT id, league_id, status, rounds, pick_seconds, order_seed,
            scheduled_at, clock_started_at
       FROM drafts WHERE league_id = $1`,
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
    // every pick after it would be attributed to the wrong manager.
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
    orderSeed: draft.order_seed,
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

/** Start the clock. */
export async function startDraft(db: SqlClient, leagueId: string, now: Date): Promise<void> {
  const rows = await db.query<{ id: string }>(
    `UPDATE drafts
        SET status = 'IN_PROGRESS', clock_started_at = $2, started_at = COALESCE(started_at, $2)
      WHERE league_id = $1 AND status IN ('SCHEDULED', 'PAUSED')
      RETURNING id`,
    [leagueId, now],
  );

  if (rows.length === 0) {
    const draft = await loadDraft(db, leagueId);
    if (!draft) throw new DraftPersistenceError("League has no draft", "DRAFT_NOT_FOUND");
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
 * otherwise.
 *
 * Both paths run through the same engine and the same write. An auto-pick that
 * took a different code path from a manual one would eventually diverge, and the
 * divergence would read to a manager as "the bot outdrafted me while I slept".
 */
export async function recordPick(db: SqlClient, input: RecordPickInput): Promise<RecordedPick> {
  return withTransaction(db, async (tx) => {
    // Serialises every pick in this draft. Held until the transaction ends.
    const [locked] = await tx.query<DraftRow>(
      `SELECT id, league_id, status, rounds, pick_seconds, order_seed,
              scheduled_at, clock_started_at
         FROM drafts WHERE league_id = $1 FOR UPDATE`,
      [input.leagueId],
    );
    if (!locked) throw new DraftPersistenceError("League has no draft", "DRAFT_NOT_FOUND");
    if (locked.status !== "IN_PROGRESS") {
      throw new DraftPersistenceError(`Draft is ${locked.status}`, "NOT_IN_PROGRESS");
    }

    const record = await hydrate(tx, locked);

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
