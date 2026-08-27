import { afterEach, describe, expect, it } from "vitest";
import {
  buildNflPprRules,
  buildRosterShape,
  deriveOrderSeed,
  generateDraftOrder,
  NFL,
  NFL_DEFAULT_FEE_BPS,
  NFL_DEFAULT_PAYOUT,
  NFL_PPR_ROSTER,
  totalPicks,
} from "@rostr/core";
import type { DraftablePlayer, DraftRules, LeagueRules } from "@rostr/core";
import { createLeague, recordSeasonStart } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { addBot } from "./membership.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { FixedBeacon } from "./randomness.js";
import {
  catchUpExpiredPicks,
  createDraftRecord,
  draftProgress,
  DraftPersistenceError,
  draftsWithExpiredPicks,
  drawDraftOrder,
  FixedSettlementAccount,
  getQueue,
  isCurrentPickExpired,
  loadDraft,
  loadQueues,
  pauseDraft,
  recordPick,
  setQueue,
  startDraft,
  verifyDraftOrder,
} from "./draft.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

/**
 * The scheduled draft time, thirty days out — and **relative**, not a literal.
 *
 * The field now locks at this instant (migration `0028`), and the trigger
 * compares it against the database's own clock. A fixed date would therefore
 * pass until it arrived and then fail every test in this file that adds a team,
 * on a day nobody would connect to a change made months earlier. It used to be
 * `2026-08-22T18:00:00Z`.
 */
const SCHEDULED = new Date(Math.floor(Date.now() / 1000) * 1000 + 30 * 24 * 3600 * 1000);
const SCHEDULED_SECONDS = Math.floor(SCHEDULED.getTime() / 1000);

/**
 * `scheduledAt` matches `SCHEDULED` exactly, and `0028` requires it to.
 *
 * These were a year apart — the frozen rules said 2025 and the `drafts` row said
 * 2026 — because nothing compared them. Now that the row decides when the field
 * locks, it has to be the number members actually signed.
 */
const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "FAST",
  pickSeconds: 90,
  scheduledAt: SCHEDULED_SECONDS,
};

const SHAPE = buildRosterShape(NFL_PPR_ROSTER, NFL);

/**
 * A stand-in chain: one block just before the scheduled time and one just after.
 * The one after is the only block the rule can select.
 */
const CHOSEN_SLOT = 412_550_991;
const CHOSEN_BLOCKHASH = "5xot9PVkphiX2adznghwrAuxGs2zeWisNSxMW6hU6Hkj";

const BEACON = new FixedBeacon([
  {
    slot: CHOSEN_SLOT - 3,
    blockhash: "TooEarly1111111111111111111111111111111111",
    blockTime: SCHEDULED_SECONDS - 2,
  },
  { slot: CHOSEN_SLOT, blockhash: CHOSEN_BLOCKHASH, blockTime: SCHEDULED_SECONDS + 1 },
  {
    slot: CHOSEN_SLOT + 4,
    blockhash: "TooLate11111111111111111111111111111111111",
    blockTime: SCHEDULED_SECONDS + 3,
  },
]);

/**
 * A settlement account that agrees with the rules.
 *
 * Every fixture here is a free league bar the pot block at the bottom, so the
 * check is not consulted — but the field is required, deliberately, so each call
 * has to say something.
 */
const SETTLEMENT_OK = new FixedSettlementAccount();

/** After the draft time, so the draw is allowed. */
const DRAW_TIME = new Date(SCHEDULED.getTime() + 5_000);

/**
 * The instant pick `n` of a draft started at `SCHEDULED` runs out of clock.
 *
 * An auto-pick is legal only at or after its own deadline — `recordPick` refuses
 * one whose clock is still running, because a caller asking for it is working
 * from a snapshot another writer has already moved past. So a fixture that plays
 * a draft out through the auto path has to walk the clock the way a real draft
 * does: pick `n` is stamped at its deadline, and pick `n + 1`'s clock starts
 * there.
 */
const deadlineOf = (n: number): Date => new Date(SCHEDULED.getTime() + n * 90_000);

/**
 * A pool deep enough that every team can fill a legal lineup, in a realistic
 * cadence rather than blocks by position — a pool that lists sixty running backs
 * first makes "best available" look like "take every running back".
 */
const POSITION_CADENCE = [
  "RB",
  "WR",
  "QB",
  "WR",
  "RB",
  "TE",
  "WR",
  "RB",
  "WR",
  "QB",
  "K",
  "DEF",
];

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  teamIds: string[];
  /** Player pool keyed by database UUID, ready for the engine. */
  pool: Map<string, DraftablePlayer>;
}

async function setup(teamCount = 4, poolSize = 200): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules;

  const league = await createLeague(db, NFL, {
    name: "Test League",
    commissionerId: commissioner.id,
    rules,
  });

  const teamIds: string[] = [];
  for (let i = 0; i < teamCount; i++) {
    const bot = await addTestTeam(db, league.id, `Bot ${i + 1}`);
    teamIds.push(bot.teamId);
  }

  const [sport] = await db.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    NFL.key,
  ]);
  const positions = await db.query<{ id: string; key: string }>(
    "SELECT id, key FROM positions WHERE sport_id = $1",
    [sport!.id],
  );
  const positionId = new Map(positions.map((p) => [p.key, p.id]));

  const pool = new Map<string, DraftablePlayer>();
  for (let i = 0; i < poolSize; i++) {
    const position = POSITION_CADENCE[i % POSITION_CADENCE.length]!;
    const [player] = await db.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [sport!.id, `ext-${i}`, `Player ${i}`, positionId.get(position)!],
    );
    pool.set(player!.id, { playerId: player!.id, positions: [position], rank: i + 1 });
  }

  return { client: db, leagueId: league.id, teamIds, pool };
}

const scheduleArgs = (leagueId: string) => ({
  leagueId,
  rounds: 14,
  pickSeconds: 90,
  scheduledAt: SCHEDULED,
});

/** Schedule a draft and draw its order. */
async function scheduled(fx: Fixture): Promise<readonly string[]> {
  await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));
  const drawn = await drawDraftOrder(fx.client, {
    leagueId: fx.leagueId,
    beacon: BEACON,
    settlement: SETTLEMENT_OK,
    now: DRAW_TIME,
  });
  return drawn.order;
}

/** The best available player the engine would consider legal for anyone. */
function anyAvailable(fx: Fixture, taken: ReadonlySet<string>, position?: string): string {
  for (const [id, player] of fx.pool) {
    if (taken.has(id)) continue;
    if (position && !player.positions.includes(position)) continue;
    return id;
  }
  throw new Error("pool exhausted");
}

describe("createDraftRecord", () => {
  it("schedules without drawing an order", async () => {
    // Teams may still be joining. A seed that exists while the field can change
    // is a seed the commissioner can grind against.
    const fx = await setup();
    const draft = await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    expect(draft.draw).toBeNull();
    expect(draft.order).toEqual([]);
    expect(draft.status).toBe("SCHEDULED");
  });

  it("refuses a second draft for the same league", async () => {
    // A redraft would invalidate every roster NFT already minted.
    const fx = await setup();
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(createDraftRecord(fx.client, scheduleArgs(fx.leagueId))).rejects.toMatchObject(
      { code: "DRAFT_EXISTS" },
    );
  });
});

describe("drawDraftOrder", () => {
  it("draws an order covering every team exactly once", async () => {
    const fx = await setup();
    const order = await scheduled(fx);

    expect([...order].sort()).toEqual([...fx.teamIds].sort());
  });

  it("records the block it drew from", async () => {
    // Without the slot and blockhash, the seed is an unverifiable claim.
    const fx = await setup();
    await scheduled(fx);
    const draft = await loadDraft(fx.client, fx.leagueId);

    expect(draft!.draw).toMatchObject({
      slot: CHOSEN_SLOT,
      blockhash: CHOSEN_BLOCKHASH,
    });
    expect(draft!.draw!.drawnAt.toISOString()).toBe(DRAW_TIME.toISOString());
  });

  it("takes the first block at or after the scheduled time, not the latest", async () => {
    // The rule has to name exactly one block. "A recent block" would let whoever
    // draws keep asking until they liked the answer.
    const fx = await setup();
    await scheduled(fx);
    const draft = await loadDraft(fx.client, fx.leagueId);

    expect(draft!.draw!.slot).toBe(CHOSEN_SLOT);
    expect(draft!.draw!.slot).not.toBe(CHOSEN_SLOT + 4);
  });

  it("derives the seed from the block, the league, and the rules hash", async () => {
    const fx = await setup();
    await scheduled(fx);

    const draft = await loadDraft(fx.client, fx.leagueId);
    const [league] = await fx.client.query<{ rules_hash: string }>(
      "SELECT rules_hash FROM leagues WHERE id = $1",
      [fx.leagueId],
    );

    expect(draft!.draw!.seed).toBe(
      deriveOrderSeed({
        leagueId: fx.leagueId,
        rulesHash: league!.rules_hash,
        slot: CHOSEN_SLOT,
        blockhash: CHOSEN_BLOCKHASH,
      }),
    );
  });

  it("produces the order that seed produces, and nothing else", async () => {
    const fx = await setup();
    const order = await scheduled(fx);
    const draft = await loadDraft(fx.client, fx.leagueId);

    const joinOrder = await fx.client.query<{ id: string }>(
      "SELECT id FROM teams WHERE league_id = $1 ORDER BY slot",
      [fx.leagueId],
    );

    expect(order).toEqual(
      generateDraftOrder(
        joinOrder.map((t) => t.id),
        draft!.draw!.seed,
      ),
    );
  });

  it("writes the order to teams.draft_position", async () => {
    // One source of truth. Storing the order in two places would eventually let
    // them disagree about who is on the clock.
    const fx = await setup();
    const order = await scheduled(fx);

    const rows = await fx.client.query<{ id: string }>(
      "SELECT id FROM teams WHERE league_id = $1 ORDER BY draft_position",
      [fx.leagueId],
    );

    expect(rows.map((r) => r.id)).toEqual([...order]);
  });

  it("refuses before the scheduled time", async () => {
    // Drawing early is drawing from a block someone could still arrange the
    // field against.
    const fx = await setup();
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: new Date(SCHEDULED.getTime() - 1000),
      }),
    ).rejects.toMatchObject({ code: "TOO_EARLY_TO_DRAW" });
  });

  it("refuses a second draw", async () => {
    // The whole attack is re-rolling until you like the answer. One draw, ever.
    const fx = await setup();
    await scheduled(fx);

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).rejects.toMatchObject({ code: "ORDER_ALREADY_DRAWN" });
  });

  it("refuses a league with no teams", async () => {
    const fx = await setup(0);
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).rejects.toMatchObject({ code: "NO_TEAMS" });
  });

  it("refuses to draw for a league with no draft", async () => {
    const fx = await setup();

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });

  it("depends on the block, so a different block gives a different order", async () => {
    const fx = await setup(8);
    await scheduled(fx);
    const drawn = await loadDraft(fx.client, fx.leagueId);

    const joinOrder = await fx.client.query<{ id: string }>(
      "SELECT id FROM teams WHERE league_id = $1 ORDER BY slot",
      [fx.leagueId],
    );
    const [league] = await fx.client.query<{ rules_hash: string }>(
      "SELECT rules_hash FROM leagues WHERE id = $1",
      [fx.leagueId],
    );

    const otherSeed = deriveOrderSeed({
      leagueId: fx.leagueId,
      rulesHash: league!.rules_hash,
      slot: CHOSEN_SLOT + 1,
      blockhash: CHOSEN_BLOCKHASH,
    });

    expect(
      generateDraftOrder(
        joinOrder.map((t) => t.id),
        otherSeed,
      ),
    ).not.toEqual(drawn!.order);
  });
});

describe("the field locks at the draw", () => {
  it("refuses a team joining after the order is drawn", async () => {
    // The shuffle depends on the seed *and* the set of teams. Adding a team
    // after the block is known would restore the whole attack: watch the block
    // land, compute what adding a bot does, then add it.
    const fx = await setup();
    await scheduled(fx);

    await expect(addTestTeam(fx.client, fx.leagueId, "Late Bot")).rejects.toThrow(
      /field is locked/i,
    );
  });

  it("refuses to edit a drawn position", async () => {
    // An editable position would make the recorded slot decorative.
    const fx = await setup();
    const order = await scheduled(fx);

    await expect(
      fx.client.query("UPDATE teams SET draft_position = 1 WHERE id = $1", [order[2]]),
    ).rejects.toThrow(/cannot be edited/i);
  });

  it("refuses to clear a drawn position", async () => {
    const fx = await setup();
    const order = await scheduled(fx);

    await expect(
      fx.client.query("UPDATE teams SET draft_position = NULL WHERE id = $1", [order[0]]),
    ).rejects.toThrow(/cannot be edited/i);
  });

  it("refuses to overwrite the recorded draw", async () => {
    const fx = await setup();
    await scheduled(fx);

    await expect(
      fx.client.query("UPDATE drafts SET order_slot = 1 WHERE league_id = $1", [fx.leagueId]),
    ).rejects.toThrow(/drawn once/i);
  });

  it("refuses a seed recorded without the block it came from", async () => {
    const fx = await setup();
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      fx.client.query("UPDATE drafts SET order_seed = $2 WHERE league_id = $1", [
        fx.leagueId,
        "a".repeat(64),
      ]),
    ).rejects.toThrow();
  });
});

describe("verifyDraftOrder", () => {
  it("passes for an honest draw", async () => {
    const fx = await setup();
    await scheduled(fx);

    expect(await verifyDraftOrder(fx.client, fx.leagueId, BEACON)).toEqual({
      ok: true,
      problems: [],
    });
  });

  it("fails before the order is drawn", async () => {
    const fx = await setup();
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    const result = await verifyDraftOrder(fx.client, fx.leagueId, BEACON);

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/not been drawn/i);
  });

  it("catches a slot that is not the first block at or after the draft time", async () => {
    // The check a sceptic actually runs: two RPC calls, no search.
    const fx = await setup();
    await scheduled(fx);

    const wrongBeacon = new FixedBeacon([
      {
        slot: CHOSEN_SLOT + 4,
        blockhash: "TooLate11111111111111111111111111111111111",
        blockTime: SCHEDULED_SECONDS + 3,
      },
    ]);

    const result = await verifyDraftOrder(fx.client, fx.leagueId, wrongBeacon);

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/not the first block/i);
  });

  it("works without a beacon, checking only the maths", async () => {
    // Useful in the UI, where an RPC round trip per page load is not worth it.
    const fx = await setup();
    await scheduled(fx);

    expect((await verifyDraftOrder(fx.client, fx.leagueId)).ok).toBe(true);
  });
});

describe("recordPick", () => {
  async function started(teamCount = 4): Promise<Fixture & { order: readonly string[] }> {
    const fx = await setup(teamCount);
    const order = await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);
    return { ...fx, order };
  }

  it("records a manual pick and moves the clock on", async () => {
    const fx = await started();
    const playerId = anyAvailable(fx, new Set());

    const result = await recordPick(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.order[0]!,
      playerId,
      pool: fx.pool,
      shape: SHAPE,
      now: SCHEDULED,
    });

    expect(result).toMatchObject({
      pickNumber: 1,
      round: 1,
      teamId: fx.order[0],
      playerId,
      source: "MANUAL",
      draftComplete: false,
    });
    expect(result!.nextTeamId).toBe(fx.order[1]);
  });

  it("puts the player on the roster in the same transaction", async () => {
    // A pick recorded without a roster entry leaves a team owning a player
    // nothing else in the system can see.
    const fx = await started();
    const playerId = anyAvailable(fx, new Set());

    await recordPick(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.order[0]!,
      playerId,
      pool: fx.pool,
      shape: SHAPE,
      now: SCHEDULED,
    });

    const rows = await fx.client.query<{ acquired_via: string }>(
      "SELECT acquired_via FROM roster_entries WHERE team_id = $1 AND player_id = $2",
      [fx.order[0], playerId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.acquired_via).toBe("DRAFT");
  });

  it("rejects a pick from a team not on the clock", async () => {
    const fx = await started();

    await expect(
      recordPick(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.order[2]!,
        playerId: anyAvailable(fx, new Set()),
        pool: fx.pool,
        shape: SHAPE,
        now: SCHEDULED,
      }),
    ).rejects.toMatchObject({ code: "NOT_ON_CLOCK" });
  });

  it("rejects a player already drafted", async () => {
    const fx = await started();
    const playerId = anyAvailable(fx, new Set());

    await recordPick(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.order[0]!,
      playerId,
      pool: fx.pool,
      shape: SHAPE,
      now: SCHEDULED,
    });

    await expect(
      recordPick(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.order[1]!,
        playerId,
        pool: fx.pool,
        shape: SHAPE,
        now: SCHEDULED,
      }),
    ).rejects.toMatchObject({ code: "PLAYER_UNAVAILABLE" });
  });

  it("refuses to pick into a draft that has not started", async () => {
    const fx = await setup();
    await scheduled(fx);

    await expect(
      recordPick(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamIds[0]!,
        playerId: anyAvailable(fx, new Set()),
        pool: fx.pool,
        shape: SHAPE,
        now: SCHEDULED,
      }),
    ).rejects.toMatchObject({ code: "NOT_IN_PROGRESS" });
  });

  it("auto-picks from the queue when no player is named", async () => {
    const fx = await started();
    const wanted = anyAvailable(fx, new Set(), "TE");
    await setQueue(fx.client, fx.order[0]!, [wanted]);

    const result = await recordPick(fx.client, {
      leagueId: fx.leagueId,
      pool: fx.pool,
      shape: SHAPE,
      now: deadlineOf(1),
    });

    expect(result).toMatchObject({ playerId: wanted, source: "QUEUE" });
  });

  it("clears a drafted player from every queue in the league", async () => {
    // Otherwise the next auto-pick reaches for someone already gone.
    const fx = await started();
    const contested = anyAvailable(fx, new Set(), "TE");
    await setQueue(fx.client, fx.order[0]!, [contested]);
    await setQueue(fx.client, fx.order[1]!, [contested]);

    await recordPick(fx.client, {
      leagueId: fx.leagueId,
      pool: fx.pool,
      shape: SHAPE,
      now: deadlineOf(1),
    });

    expect(await getQueue(fx.client, fx.order[1]!)).toEqual([]);
  });

  it("falls back to best available when the queue is empty", async () => {
    const fx = await started();

    const result = await recordPick(fx.client, {
      leagueId: fx.leagueId,
      pool: fx.pool,
      shape: SHAPE,
      now: deadlineOf(1),
    });

    expect(result!.source).not.toBe("MANUAL");
    expect(result!.source).not.toBe("QUEUE");
  });

  it("starts the season when the draft completes", async () => {
    // A league that finished drafting and had no fixtures would look finished
    // and be unplayable.
    const fx = await started(2);

    for (let i = 0; i < totalPicks(2, 14); i++) {
      await recordPick(fx.client, {
        leagueId: fx.leagueId,
        pool: fx.pool,
        shape: SHAPE,
        now: deadlineOf(i + 1),
      });
    }

    const [league] = await fx.client.query<{ state: string }>(
      "SELECT state FROM leagues WHERE id = $1",
      [fx.leagueId],
    );
    expect(league?.state).toBe("IN_SEASON");

    const [matchups] = await fx.client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM matchups WHERE league_id = $1",
      [fx.leagueId],
    );
    // Two teams, fourteen weeks.
    expect(Number(matchups?.count)).toBe(14);
  });

  it("moves the league to DRAFTING when the clock starts", async () => {
    // Nothing else moved league state, so a drafted league stayed FORMING and
    // kept accepting members.
    const fx = await setup();
    await scheduled(fx);

    const before = await fx.client.query<{ state: string }>(
      "SELECT state FROM leagues WHERE id = $1",
      [fx.leagueId],
    );
    expect(before[0]?.state).toBe("FORMING");

    await startDraft(fx.client, fx.leagueId, SCHEDULED);

    const after = await fx.client.query<{ state: string }>(
      "SELECT state FROM leagues WHERE id = $1",
      [fx.leagueId],
    );
    expect(after[0]?.state).toBe("DRAFTING");
  });

  it("marks the draft complete on the final pick", async () => {
    const fx = await started(2);
    const total = totalPicks(2, 14);

    let last;
    for (let i = 0; i < total; i++) {
      last = await recordPick(fx.client, {
        leagueId: fx.leagueId,
        pool: fx.pool,
        shape: SHAPE,
        now: deadlineOf(i + 1),
      });
    }

    expect(last).toMatchObject({ pickNumber: total, draftComplete: true, nextTeamId: null });

    const draft = await loadDraft(fx.client, fx.leagueId);
    expect(draft?.status).toBe("COMPLETE");
    expect(draft?.clockStartedAt).toBeNull();
  });

  it("plays out a full draft with every team legal", async () => {
    const fx = await started(4);
    const total = totalPicks(4, 14);

    for (let i = 0; i < total; i++) {
      await recordPick(fx.client, {
        leagueId: fx.leagueId,
        pool: fx.pool,
        shape: SHAPE,
        now: deadlineOf(i + 1),
      });
    }

    const draft = await loadDraft(fx.client, fx.leagueId);
    expect(draft!.state.picks).toHaveLength(total);

    // Every player exactly once, and every team a full roster.
    expect(new Set(draft!.state.picks.map((p) => p.playerId)).size).toBe(total);

    for (const teamId of fx.teamIds) {
      expect(draft!.state.picks.filter((p) => p.teamId === teamId)).toHaveLength(14);
    }

    // And rosters landed in the database, not just in the reconstructed state.
    const [rosterCount] = await fx.client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM roster_entries r
         JOIN teams t ON t.id = r.team_id WHERE t.league_id = $1`,
      [fx.leagueId],
    );
    expect(Number(rosterCount?.count)).toBe(total);
  });

  it("survives a reload mid-draft", async () => {
    // The whole point of B16: a slow draft runs for days across many processes.
    const fx = await started();

    for (let i = 0; i < 5; i++) {
      await recordPick(fx.client, {
        leagueId: fx.leagueId,
        pool: fx.pool,
        shape: SHAPE,
        now: deadlineOf(i + 1),
      });
    }

    const reloaded = await loadDraft(fx.client, fx.leagueId);
    const progress = draftProgress(reloaded!);

    expect(progress).toMatchObject({
      picksMade: 5,
      totalPicks: 56,
      currentPickNumber: 6,
      complete: false,
    });

    // Pick 6 of a 4-team draft is round 2, which runs backward: picks 5 and 6
    // are order[3] and order[2]. The snake has to survive the reload too — a
    // reconstruction that restarted the rotation would hand the pick to
    // order[1] and nobody would notice until someone checked their turn.
    expect(progress.currentTeamId).toBe(reloaded!.order[2]);
  });
});

describe("clocks", () => {
  it("refuses to start before the order is drawn", async () => {
    // Without an order there is no rotation, so there is no answer to "whose
    // pick is it".
    const fx = await setup();
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(startDraft(fx.client, fx.leagueId, SCHEDULED)).rejects.toMatchObject({
      code: "ORDER_NOT_DRAWN",
    });
  });

  it("does not expire a draft that has not started", async () => {
    const fx = await setup();
    await scheduled(fx);
    const draft = await loadDraft(fx.client, fx.leagueId);

    expect(isCurrentPickExpired(draft!, new Date("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("expires once the pick clock elapses", async () => {
    const fx = await setup();
    await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);
    const draft = await loadDraft(fx.client, fx.leagueId);

    expect(isCurrentPickExpired(draft!, new Date(SCHEDULED.getTime() + 89_000))).toBe(false);
    expect(isCurrentPickExpired(draft!, new Date(SCHEDULED.getTime() + 90_000))).toBe(true);
  });

  it("lists drafts a timer job needs to act on", async () => {
    const fx = await setup();
    await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);

    const before = await draftsWithExpiredPicks(
      fx.client,
      new Date(SCHEDULED.getTime() + 60_000),
    );
    const after = await draftsWithExpiredPicks(
      fx.client,
      new Date(SCHEDULED.getTime() + 120_000),
    );

    expect(before).toEqual([]);
    expect(after).toEqual([fx.leagueId]);
  });

  it("gives a full fresh timer after a pause", async () => {
    // A manager should not lose sixty of their ninety seconds to an outage they
    // had nothing to do with.
    const fx = await setup();
    await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);
    await pauseDraft(fx.client, fx.leagueId);

    const paused = await loadDraft(fx.client, fx.leagueId);
    expect(paused?.status).toBe("PAUSED");
    expect(paused?.clockStartedAt).toBeNull();
    expect(isCurrentPickExpired(paused!, new Date(SCHEDULED.getTime() + 600_000))).toBe(false);

    const resumedAt = new Date(SCHEDULED.getTime() + 600_000);
    await startDraft(fx.client, fx.leagueId, resumedAt);
    const resumed = await loadDraft(fx.client, fx.leagueId);

    expect(isCurrentPickExpired(resumed!, new Date(resumedAt.getTime() + 60_000))).toBe(false);
    expect(isCurrentPickExpired(resumed!, new Date(resumedAt.getTime() + 90_000))).toBe(true);
  });

  it("refuses to start a completed draft", async () => {
    const fx = await setup(2);
    await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);

    for (let i = 0; i < totalPicks(2, 14); i++) {
      await recordPick(fx.client, {
        leagueId: fx.leagueId,
        pool: fx.pool,
        shape: SHAPE,
        now: deadlineOf(i + 1),
      });
    }

    // Assert the draft really did complete before asserting the refusal — with
    // the clock walked forward per pick, a fixture that quietly recorded nothing
    // would otherwise still see `startDraft` throw, for the wrong reason.
    expect((await loadDraft(fx.client, fx.leagueId))?.status).toBe("COMPLETE");

    await expect(startDraft(fx.client, fx.leagueId, SCHEDULED)).rejects.toBeInstanceOf(
      DraftPersistenceError,
    );
  });
});

describe("catchUpExpiredPicks", () => {
  async function running(teamCount = 4): Promise<Fixture & { order: readonly string[] }> {
    const fx = await setup(teamCount);
    const order = await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);
    return { ...fx, order };
  }

  const args = (fx: Fixture, now: Date) => ({
    leagueId: fx.leagueId,
    pool: fx.pool,
    shape: SHAPE,
    now,
  });

  it("does nothing while the clock is running", async () => {
    const fx = await running();

    expect(
      await catchUpExpiredPicks(fx.client, args(fx, new Date(SCHEDULED.getTime() + 60_000))),
    ).toBe(0);
  });

  it("makes the pick once the clock has passed", async () => {
    const fx = await running();

    expect(
      await catchUpExpiredPicks(fx.client, args(fx, new Date(SCHEDULED.getTime() + 90_000))),
    ).toBe(1);
  });

  it("works through a backlog one deadline at a time", async () => {
    // Nobody looked at the draft for an hour. At 90 seconds a pick, exactly
    // forty clocks expired in that window — not one, and not the whole draft.
    const fx = await running();

    const made = await catchUpExpiredPicks(
      fx.client,
      args(fx, new Date(SCHEDULED.getTime() + 3_600_000)),
    );

    expect(made).toBe(40);
  });

  it("leaves the next manager a full clock", async () => {
    // The point of stamping each pick at the deadline it missed. Stamping `now`
    // would silently extend every clock by however long the room sat empty.
    const fx = await running();
    const hourLater = new Date(SCHEDULED.getTime() + 3_600_000);

    await catchUpExpiredPicks(fx.client, args(fx, hourLater));
    const draft = await loadDraft(fx.client, fx.leagueId);

    // Forty picks in, the clock is running from the fortieth deadline.
    expect(draft!.clockStartedAt?.toISOString()).toBe(
      new Date(SCHEDULED.getTime() + 40 * 90_000).toISOString(),
    );
    expect(isCurrentPickExpired(draft!, hourLater)).toBe(false);
  });

  it("runs a draft out when the gap is long enough", async () => {
    const fx = await running(2);
    const total = totalPicks(2, 14);

    const made = await catchUpExpiredPicks(
      fx.client,
      args(fx, new Date(SCHEDULED.getTime() + (total + 5) * 90_000)),
    );

    expect(made).toBe(total);
    expect((await loadDraft(fx.client, fx.leagueId))?.status).toBe("COMPLETE");
  });

  it("stops at a completed draft rather than spinning", async () => {
    const fx = await running(2);
    const far = new Date(SCHEDULED.getTime() + 30 * 24 * 3_600_000);
    await catchUpExpiredPicks(fx.client, args(fx, far));

    expect(await catchUpExpiredPicks(fx.client, args(fx, far))).toBe(0);
  });

  it("does nothing to a paused draft", async () => {
    // A stale clock must not let the catch-up pick straight through a
    // commissioner's halt.
    const fx = await running();
    await pauseDraft(fx.client, fx.leagueId);

    expect(
      await catchUpExpiredPicks(fx.client, args(fx, new Date(SCHEDULED.getTime() + 3_600_000))),
    ).toBe(0);
  });

  it("does nothing to a draft that never started", async () => {
    const fx = await setup();
    await scheduled(fx);

    expect(
      await catchUpExpiredPicks(fx.client, args(fx, new Date(SCHEDULED.getTime() + 3_600_000))),
    ).toBe(0);
  });

  it("respects the safety stop", async () => {
    // A request that would make more picks than a whole draft has hit a bug, not
    // a backlog, and grinding on turns one bad state into a timeout.
    const fx = await running();

    const made = await catchUpExpiredPicks(fx.client, {
      ...args(fx, new Date(SCHEDULED.getTime() + 3_600_000)),
      maxPicks: 3,
    });

    expect(made).toBe(3);
  });

  it("is idempotent — every reader triggers it", async () => {
    const fx = await running();
    const now = new Date(SCHEDULED.getTime() + 90_000);

    expect(await catchUpExpiredPicks(fx.client, args(fx, now))).toBe(1);
    expect(await catchUpExpiredPicks(fx.client, args(fx, now))).toBe(0);
    expect(await catchUpExpiredPicks(fx.client, args(fx, now))).toBe(0);

    const picks = (await loadDraft(fx.client, fx.leagueId))!.state.picks;
    expect(picks).toHaveLength(1);
    expect(new Set(picks.map((p) => p.playerId)).size).toBe(picks.length);
  });
});

describe("concurrency guards", () => {
  // PGlite is a single connection, so a genuine two-writer race cannot be
  // simulated here. What can be proven is that the constraints which would stop
  // one are actually present — the application lock is the fast path, but these
  // are what make a lost race impossible rather than merely unlikely.
  async function drafted(): Promise<{ fx: Fixture; draftId: string; playerId: string }> {
    const fx = await setup();
    const order = await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);

    const playerId = anyAvailable(fx, new Set());
    await recordPick(fx.client, {
      leagueId: fx.leagueId,
      teamId: order[0]!,
      playerId,
      pool: fx.pool,
      shape: SHAPE,
      now: SCHEDULED,
    });

    const draft = await loadDraft(fx.client, fx.leagueId);
    return { fx, draftId: draft!.draftId, playerId };
  }

  it("refuses a second write to the same pick number", async () => {
    // Two managers clicking at the same instant both compute "I am pick 1".
    const { fx, draftId } = await drafted();
    const other = anyAvailable(fx, new Set([...fx.pool.keys()].slice(0, 1)));

    await expect(
      fx.client.query(
        `INSERT INTO draft_picks (draft_id, pick_number, round, team_id, player_id, source)
         VALUES ($1, 1, 1, $2, $3, 'MANUAL')`,
        [draftId, fx.teamIds[1], other],
      ),
    ).rejects.toThrow();
  });

  it("refuses the same player twice in one draft", async () => {
    const { fx, draftId, playerId } = await drafted();

    await expect(
      fx.client.query(
        `INSERT INTO draft_picks (draft_id, pick_number, round, team_id, player_id, source)
         VALUES ($1, 2, 1, $2, $3, 'MANUAL')`,
        [draftId, fx.teamIds[1], playerId],
      ),
    ).rejects.toThrow();
  });

  it("refuses a second draft row for one league", async () => {
    const { fx } = await drafted();

    await expect(
      fx.client.query(
        `INSERT INTO drafts (league_id, rounds, pick_seconds, scheduled_at)
         VALUES ($1, 14, 90, $2)`,
        [fx.leagueId, SCHEDULED],
      ),
    ).rejects.toThrow();
  });

  it("refuses a running clock on a draft that is not in progress", async () => {
    // A stale clock on a PAUSED draft would let the timer job auto-pick through
    // a commissioner's halt.
    const { fx } = await drafted();

    await expect(
      fx.client.query("UPDATE drafts SET status = 'PAUSED' WHERE league_id = $1", [
        fx.leagueId,
      ]),
    ).rejects.toThrow();
  });

  it("leaves nothing behind when a pick is rejected", async () => {
    // The pick, the roster entry, and the queue cleanup are one transaction.
    const { fx } = await drafted();
    const before = await fx.client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM roster_entries",
    );

    await expect(
      recordPick(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamIds[0]!,
        playerId: "00000000-0000-0000-0000-000000000000",
        pool: fx.pool,
        shape: SHAPE,
        now: SCHEDULED,
      }),
    ).rejects.toThrow();

    const after = await fx.client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM roster_entries",
    );
    expect(after[0]?.count).toBe(before[0]?.count);
  });
});

/**
 * Issue #22. The lock decides who writes first; it cannot make a decision taken
 * *before* the lock true afterwards. Both guards are checked inside it.
 *
 * PGlite is one connection, so a genuine two-writer race cannot run here — and
 * attempting one produces a different failure entirely (nested BEGIN, unique
 * violation, everything rolled back). What is testable, and what actually
 * matters, is that a stale decision is refused. These drive that directly.
 */
describe("a decision made before the lock is re-checked inside it", () => {
  async function running(): Promise<{ fx: Fixture; order: readonly string[] }> {
    const fx = await setup();
    const order = await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);
    return { fx, order };
  }

  const EXPIRED = new Date(SCHEDULED.getTime() + 91_000);

  it("records nothing when the pick it meant has already been made", async () => {
    // Caller A committed pick 1 while caller B was between its read and its
    // lock. B's snapshot says "pick 1 expired"; acting on it would take pick 2
    // from a manager whose ninety seconds just started.
    const { fx, order } = await running();

    await recordPick(fx.client, {
      leagueId: fx.leagueId,
      teamId: order[0]!,
      playerId: anyAvailable(fx, new Set()),
      pool: fx.pool,
      shape: SHAPE,
      now: SCHEDULED,
    });

    const stale = await recordPick(fx.client, {
      leagueId: fx.leagueId,
      expectedPickNumber: 1,
      pool: fx.pool,
      shape: SHAPE,
      now: EXPIRED,
    });

    expect(stale).toBeNull();
    expect(draftProgress((await loadDraft(fx.client, fx.leagueId))!).picksMade).toBe(1);
  });

  it("records nothing when the pick number is right but the clock is not", async () => {
    // The subtle half, and why the pick number alone is not enough: a pause and
    // resume keeps the same pick on the clock and starts a fresh timer, so a
    // stale "it expired" passes a pick-number check and would auto-pick a
    // manager who has just been handed their full ninety seconds.
    const { fx } = await running();

    const notExpired = await recordPick(fx.client, {
      leagueId: fx.leagueId,
      expectedPickNumber: 1,
      pool: fx.pool,
      shape: SHAPE,
      now: new Date(SCHEDULED.getTime() + 1_000),
    });

    expect(notExpired).toBeNull();
    expect(draftProgress((await loadDraft(fx.client, fx.leagueId))!).picksMade).toBe(0);
  });

  it("still auto-picks when the decision is genuinely current", async () => {
    // The control. Both guards must let a real expiry through, or the clock
    // never advances at all.
    const { fx } = await running();

    const made = await recordPick(fx.client, {
      leagueId: fx.leagueId,
      expectedPickNumber: 1,
      pool: fx.pool,
      shape: SHAPE,
      now: EXPIRED,
    });

    expect(made).not.toBeNull();
    expect(made?.pickNumber).toBe(1);
  });

  it("refuses a manual pick whose own clock has run out", async () => {
    // Accepting it stamps `clock_started_at = now`, so the overrun is added to a
    // baseline that never re-anchors and every later clock stretches — the exact
    // drift the deadline-stamped auto-pick exists to prevent.
    const { fx, order } = await running();

    await expect(
      recordPick(fx.client, {
        leagueId: fx.leagueId,
        teamId: order[0]!,
        playerId: anyAvailable(fx, new Set()),
        pool: fx.pool,
        shape: SHAPE,
        now: new Date(SCHEDULED.getTime() + 300_000),
      }),
    ).rejects.toMatchObject({ code: "CLOCK_EXPIRED" });

    expect(draftProgress((await loadDraft(fx.client, fx.leagueId))!).picksMade).toBe(0);
  });

  it("records nothing when the winner's pick completed the draft", async () => {
    // The status check runs before both guards, so a lost race to a winner who
    // *finished* the draft used to throw NOT_IN_PROGRESS — and the read route
    // has no catch for it, so every polling tab would 500 at the exact instant a
    // draft ends. A named caller losing a race is a no-op however it lost.
    const fx = await setup(2);
    const order = await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);

    const total = totalPicks(order.length, 14);
    await catchUpExpiredPicks(fx.client, {
      leagueId: fx.leagueId,
      pool: fx.pool,
      shape: SHAPE,
      now: deadlineOf(total),
      maxPicks: total,
    });

    const [row] = await fx.client.query<{ status: string }>(
      "SELECT status FROM drafts WHERE league_id = $1",
      [fx.leagueId],
    );
    expect(row?.status).toBe("COMPLETE");

    await expect(
      recordPick(fx.client, {
        leagueId: fx.leagueId,
        expectedPickNumber: total,
        pool: fx.pool,
        shape: SHAPE,
        now: deadlineOf(total),
      }),
    ).resolves.toBeNull();
  });

  it("records nothing when a commissioner paused between the read and the lock", async () => {
    const { fx } = await running();
    await pauseDraft(fx.client, fx.leagueId);

    await expect(
      recordPick(fx.client, {
        leagueId: fx.leagueId,
        expectedPickNumber: 1,
        pool: fx.pool,
        shape: SHAPE,
        now: EXPIRED,
      }),
    ).resolves.toBeNull();
  });

  it("still tells a manual picker the draft is not running", async () => {
    // The manual path names no expected pick, so it keeps throwing — somebody
    // clicking on a paused draft wants to be told, not silently ignored.
    const { fx, order } = await running();
    await pauseDraft(fx.client, fx.leagueId);

    await expect(
      recordPick(fx.client, {
        leagueId: fx.leagueId,
        teamId: order[0]!,
        playerId: anyAvailable(fx, new Set()),
        pool: fx.pool,
        shape: SHAPE,
        now: SCHEDULED,
      }),
    ).rejects.toMatchObject({ code: "NOT_IN_PROGRESS" });
  });

  it("leaves the clock where the schedule says after a late pick is refused", async () => {
    // The point of refusing: the next manager's clock still runs from the missed
    // deadline, not from whenever the late click happened to land.
    const { fx, order } = await running();

    await recordPick(fx.client, {
      leagueId: fx.leagueId,
      teamId: order[0]!,
      playerId: anyAvailable(fx, new Set()),
      pool: fx.pool,
      shape: SHAPE,
      // Genuinely late — 300s into a 90s clock. With `SCHEDULED` here the pick
      // is on time, the refusal never fires, and this asserts nothing.
      now: new Date(SCHEDULED.getTime() + 300_000),
    }).catch(() => undefined);

    await catchUpExpiredPicks(fx.client, {
      leagueId: fx.leagueId,
      pool: fx.pool,
      shape: SHAPE,
      now: new Date(SCHEDULED.getTime() + 300_000),
    });

    const [row] = await fx.client.query<{ clock_started_at: string }>(
      "SELECT clock_started_at FROM drafts WHERE league_id = $1",
      [fx.leagueId],
    );

    // Every stamp is a multiple of the pick clock from the scheduled start —
    // never an arbitrary instant somebody happened to click at.
    const offset = (new Date(row!.clock_started_at).getTime() - SCHEDULED.getTime()) / 1000;
    expect(offset % 90).toBe(0);
  });
});

describe("queues", () => {
  async function withDraft(): Promise<Fixture> {
    const fx = await setup();
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));
    return fx;
  }

  it("round-trips a queue in order", async () => {
    const fx = await withDraft();
    const ids = [...fx.pool.keys()].slice(0, 5);

    await setQueue(fx.client, fx.teamIds[0]!, ids);

    expect(await getQueue(fx.client, fx.teamIds[0]!)).toEqual(ids);
  });

  it("replaces rather than merges on reorder", async () => {
    // Patching ranks in place can leave a queue half-reordered if a clock
    // expires mid-write. Delete-and-rewrite inside a transaction cannot.
    const fx = await withDraft();
    const ids = [...fx.pool.keys()].slice(0, 5);

    await setQueue(fx.client, fx.teamIds[0]!, ids);
    await setQueue(fx.client, fx.teamIds[0]!, [...ids].reverse());

    expect(await getQueue(fx.client, fx.teamIds[0]!)).toEqual([...ids].reverse());
  });

  it("handles being emptied", async () => {
    const fx = await withDraft();
    await setQueue(fx.client, fx.teamIds[0]!, [...fx.pool.keys()].slice(0, 3));
    await setQueue(fx.client, fx.teamIds[0]!, []);

    expect(await getQueue(fx.client, fx.teamIds[0]!)).toEqual([]);
  });

  it("keeps each team's queue separate", async () => {
    const fx = await withDraft();
    const ids = [...fx.pool.keys()];

    await setQueue(fx.client, fx.teamIds[0]!, ids.slice(0, 3));
    await setQueue(fx.client, fx.teamIds[1]!, ids.slice(3, 5));

    const queues = await loadQueues(fx.client, fx.leagueId);

    expect(queues.get(fx.teamIds[0]!)).toEqual(ids.slice(0, 3));
    expect(queues.get(fx.teamIds[1]!)).toEqual(ids.slice(3, 5));
  });
});

// ---------------------------------------------------------------------------

/**
 * `minHumans` is in the frozen rule set and the draw is where it binds.
 *
 * `docs/RULES.md` §3 — "minimum humans to start: 2" — was signed by every member
 * and compared to nothing. What made that worth a guard is not the draft itself,
 * which completes fine: it is that a short league then reaches `IN_SEASON` with
 * no fixtures and **cannot be recovered**. There is no redraft, the draw is
 * write-once by trigger, the field is locked, and the one moment that writes a
 * schedule has passed.
 *
 * The boundary is exercised in both directions here: one human refused, two
 * allowed. Note also `setup(2)` in the suites above — those drafts run against
 * the default `minHumans: 2`, so they are a standing detector for anyone who
 * writes `<=` where the guard needs `<`.
 */
/**
 * No odd fields — decided by the owner on 2026-08-17.
 *
 * An odd field hands somebody a bye every week, and a bye is a free result: no
 * game, no loss. In a league playing for money that moves who gets paid.
 *
 * The refusal is here rather than a fix, and that is forced rather than chosen:
 * migration `0028` locks the field at `scheduledAt` on INSERT *and* DELETE, and
 * this runs at or after that instant. So nothing can add a bot or drop a team
 * by the time the draw happens — squaring the field has to be done while it is
 * still open, which is what the lobby has to say before the deadline.
 */
describe("the draw refuses an odd field", () => {
  it("refuses three teams", async () => {
    const fx = await setup(3);
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).rejects.toMatchObject({ code: "ODD_FIELD" });
  });

  it("draws an even field", async () => {
    const fx = await setup(4);
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).resolves.toBeDefined();
  });

  it("counts every team, bots included", async () => {
    // A bot occupies a fixture like anyone else, so it is what squares an odd
    // free league — the field being even is a fact about the schedule, not
    // about how many people are in it.
    const fx = await setup(5);
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).rejects.toThrow(/5 teams/);
  });

  it("answers BELOW_MIN_HUMANS first for a single-manager league", async () => {
    // One team is both odd and short, and short is the more useful thing to be
    // told — the same ordering `NO_TEAMS` keeps ahead of both.
    const fx = await setup(1);
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).rejects.toMatchObject({ code: "BELOW_MIN_HUMANS" });
  });
});

describe("the draw refuses a field below minHumans", () => {
  it("refuses a single-manager league", async () => {
    const fx = await setup(1);
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).rejects.toMatchObject({ code: "BELOW_MIN_HUMANS" });
  });

  it("says how many it has and how many it needs", async () => {
    // The commissioner is the only person who ever sees this string, and it is
    // the only thing telling them what to do about it.
    const fx = await setup(1);
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).rejects.toThrow(/1 manager and its rules require 2/);
  });

  it("still answers NO_TEAMS for an empty league", async () => {
    // Zero teams is the more specific fact and keeps its own code, which is why
    // the human count is checked after it rather than before.
    const fx = await setup(0);
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).rejects.toMatchObject({ code: "NO_TEAMS" });
  });

  it("counts humans, not rows: one manager and a bot is still one manager", async () => {
    // Reachable today — `addBot` permits a bot at an odd human count, and one is
    // odd. A bot is a placeholder for a person who is missing from an otherwise
    // playable league (`RULES.md` §3), and it cannot be paid, so it can never
    // satisfy a minimum denominated in humans. A `count(*)` here would pass this
    // league straight through.
    const fx = await setup(1);
    await addBot(fx.client, fx.leagueId, "Sub");
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).rejects.toMatchObject({ code: "BELOW_MIN_HUMANS" });
  });

  it("allows exactly minHumans, and the bot still joins the order", async () => {
    // `validateLeagueRules` permits `maxTeams == minHumans`, so a league of
    // exactly two is legal and must remain draftable — `<=` here would brick it
    // permanently, against frozen rules nobody could correct.
    //
    // The bot is refused a seat in the *count* and keeps its seat in the *draft*:
    // filtering the query rather than the count would shorten the rotation.
    const fx = await setup(3);
    await addBot(fx.client, fx.leagueId, "Sub");

    const order = await scheduled(fx);

    expect(order).toHaveLength(4);
    expect(new Set(order).size).toBe(4);
  });

  it("lets a two-manager league draw", async () => {
    // The control, in its cheap form. Without something like it the guard could
    // be refusing every league and every test above would still pass.
    //
    // The expensive half already exists: "starts the season when the draft
    // completes" drafts a two-team league to completion and asserts fourteen
    // fixtures. It runs through this same guard, so it is a standing control
    // that a short-field refusal has not swallowed a legal one.
    const fx = await setup(2);

    const order = await scheduled(fx);

    expect(order).toHaveLength(2);
  });
});

/**
 * A pot league does not draft until the chain has been told its season is
 * starting.
 *
 * `refund_stake` has two openings and `League.started` is the only thing
 * separating them:
 *
 *     timelock_open = now >= refund_unlock_at            -- months away
 *     failed_open   = !started && now >= start_deadline  -- draft time + 48h
 *
 * The second exists so a league that never gets going returns everyone's money
 * in days. Its cost is that a league which *did* get going and was never marked
 * started spends the whole season on that schedule: any member could withdraw
 * their entire stake in week 3 while keeping their roster, their standings place
 * and their claim on the pot. Until 2026-08-18 nothing in the app ever sent
 * `start_season`, so that was true of every pot league that ever drafted.
 *
 * **Mark first, draw second.** Drawing first and failing to mark is
 * unrecoverable — the draw is write-once by trigger — while marking first and
 * failing to draw simply means pressing the button again.
 */
describe("the draw refuses a pot league whose season has not started", () => {
  /**
   * The same fixture as `setup`, with a pot.
   *
   * `refundUnlockAt` is derived rather than a literal because the floor is
   * derived: `earliestRefundUnlock` is roughly the draft plus 186 days, and
   * `SCHEDULED` moves with the clock.
   */
  async function potLeague(teamCount = 4): Promise<Fixture> {
    db = await createTestDatabase();
    await seedSport(db, NFL);

    const commissioner = await createUser(db, "commish@example.com", "Commish");
    const rules = buildNflPprRules({
      seasonYear: 2026,
      draft: DRAFT,
      pot: {
        tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        buyInBaseUnits: "50000000",
        payout: NFL_DEFAULT_PAYOUT,
        refundUnlockAt: SCHEDULED_SECONDS + 200 * 24 * 3600,
        feeBps: NFL_DEFAULT_FEE_BPS,
        feeRecipient: "6dNUCTMTgoHhbfgDzKtiPvBpJ2LzMwGqBpKmUDgQtNMK",
        settlementOracle: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx",
      },
    }) as LeagueRules;

    const league = await createLeague(db, NFL, {
      name: "The Money League",
      commissionerId: commissioner.id,
      rules,
    });

    const teamIds: string[] = [];
    for (let i = 0; i < teamCount; i++) {
      const team = await addTestTeam(db, league.id, `Manager ${i + 1}`);
      teamIds.push(team.teamId);
    }

    await createDraftRecord(db, scheduleArgs(league.id));

    return { client: db, leagueId: league.id, teamIds, pool: new Map() };
  }

  const draw = (fx: Fixture) =>
    drawDraftOrder(fx.client, {
      leagueId: fx.leagueId,
      beacon: BEACON,
      settlement: SETTLEMENT_OK,
      now: DRAW_TIME,
    });

  it("refuses a pot league with everything else in order", async () => {
    // Four managers, an even field, and nobody owing a stake — so the only thing
    // left is the one this describe block is about.
    const fx = await potLeague();

    await expect(draw(fx)).rejects.toMatchObject({ code: "SEASON_NOT_STARTED" });
  });

  it("says what the commissioner has to do and why", async () => {
    // The only string anybody sees about this, and it has to name both the
    // action and the consequence of skipping it.
    const fx = await potLeague();

    await expect(draw(fx)).rejects.toThrow(/start_season/);
    await expect(draw(fx)).rejects.toThrow(/withdraw their stake mid-season/);
  });

  it("draws once the season start is recorded", async () => {
    const fx = await potLeague();
    // The real recorder rather than a hand-written UPDATE, so a fixture cannot
    // reach a state the application could not produce — the same reason the
    // membership fixtures call `recordChainAnchor`.
    await recordSeasonStart(fx.client, fx.leagueId, {
      signature: "5".repeat(88),
      cluster: "localnet",
    });

    await expect(draw(fx)).resolves.toMatchObject({ order: expect.any(Array) });
  });

  it("checks it last, after the field", async () => {
    // A commissioner who is a manager short is told *that*, not told to press a
    // button which — pressed — would close the automatic refund on stakes that
    // will never be played for, and nothing can reopen it.
    const fx = await potLeague(3);

    await expect(draw(fx)).rejects.toMatchObject({ code: "ODD_FIELD" });
  });

  it("never asks a free league for one", async () => {
    // A free league has no vault, so there is nothing for `start_season` to
    // protect — and the program refuses it outright without `has_pot`. Requiring
    // it here would make every free league undraftable.
    const fx = await setup(4);
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: BEACON,
        settlement: SETTLEMENT_OK,
        now: DRAW_TIME,
      }),
    ).resolves.toBeDefined();
  });
});

describe("a player cut by his club stays on the roster he was drafted to", () => {
  /*
    Issue #253. The engine rebuilt a drafting roster by looking each pick up in
    the draft board, and the board filters on `players.active` — a flag the daily
    sync clears for anyone the provider reports as an NFL free agent. So a player
    drafted in round 2 and cut overnight fell out of his own team's roster: the
    count went on without him, letting the team take one more than the limit, and
    letting a bot double up at a position it had already filled.

    Deleting him from the fixture's `pool` is exactly what the sync produces —
    the board is rebuilt from a query he no longer matches.
  */

  it("keeps drafting when its own earlier pick has left the board", async () => {
    /*
      A lock on the throw, not on the bug — and worth being exact about which,
      because it reads like the latter.

      This passes against fully reverted code: the roster rows are written from
      `input`, not from the count, so a team whose roster rebuilt one player
      short still ends up with both rows in the database. What it does catch is
      the intermediate state — throw added, widening removed — where the fourth
      pick fails with POOL_INCOMPLETE instead of quietly counting wrong. That
      state is one careless revert away, and this is the test that stops it.

      The consequence of the miscount is asserted below, in the cap test.

      Two teams, so the snake turns straight back: A takes pick 1, B takes 2 and
      3, A takes 4 — A's next pick being the first moment its own roster is
      rebuilt, since `rosterFor` is per-team.
    */
    const fx = await setup(2);
    const order = await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);

    const taken = new Set<string>();
    const take = async (teamId: string, board: ReadonlyMap<string, DraftablePlayer>) => {
      const playerId = anyAvailable(fx, taken);
      taken.add(playerId);
      await recordPick(fx.client, {
        leagueId: fx.leagueId,
        teamId,
        playerId,
        pool: board,
        shape: SHAPE,
        now: SCHEDULED,
      });
      return playerId;
    };

    const first = await take(order[0]!, fx.pool);

    // Overnight, his club cuts him: the board is rebuilt without him.
    const cutBoard = new Map(fx.pool);
    cutBoard.delete(first);

    await take(order[1]!, cutBoard);
    await take(order[1]!, cutBoard);

    // A picks again, and this is the call that rebuilds A's roster.
    const fourth = await take(order[0]!, cutBoard);

    const roster = await fx.client.query<{ player_id: string }>(
      `SELECT player_id FROM roster_entries
        WHERE team_id = $1 AND released_at IS NULL`,
      [order[0]!],
    );

    // Compared as a set: every pick here is stamped at `SCHEDULED`, so
    // `acquired_at` ties and any ORDER BY over it is unspecified.
    expect(new Set(roster.map((row) => row.player_id))).toEqual(new Set([first, fourth]));
  });
  it("still refuses to draft him twice once he is back on the board", async () => {
    /*
      The widening puts him back in the pool, and the pool is what `available`
      is derived from — so the guard that matters is that he is still in
      `draftedPlayerIds`, which is what refuses a second pick of him.

      The second call must be handed a board he has fallen off. Given an intact
      one, `poolWithDraftedPlayers` finds nothing missing and returns at its
      guard, and this asserts against the un-widened path — the one case it
      exists to rule out.
    */
    const fx = await setup();
    const order = await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);

    const first = anyAvailable(fx, new Set());
    await recordPick(fx.client, {
      leagueId: fx.leagueId,
      teamId: order[0]!,
      playerId: first,
      pool: fx.pool,
      shape: SHAPE,
      now: SCHEDULED,
    });

    const cutBoard = new Map(fx.pool);
    cutBoard.delete(first);

    await expect(
      recordPick(fx.client, {
        leagueId: fx.leagueId,
        teamId: order[1]!,
        playerId: first,
        pool: cutBoard,
        shape: SHAPE,
        now: SCHEDULED,
      }),
    ).rejects.toMatchObject({ code: "PLAYER_UNAVAILABLE" });
  });

  it("counts him against the position cap, so a bot is not handed a second quarterback", async () => {
    /*
      The consequence, and the reason the miscount was worth fixing.

      `canDraft` reads `roster.length` only, so an undercount cannot be caught
      by the roster limit — with fourteen rounds and fourteen slots a team never
      reaches it anyway. The cap is where it bites: `isAtPositionCap` reads
      `positions` off the roster the engine rebuilds, and `defaultPositionCaps`
      puts QB at one (one starting slot, and `floor(5 * 1 / 9)` of the bench).

      So a bot that already holds the only quarterback it drafted must never be
      given a second — and before the fix it was, because his club had cut him
      and he had fallen out of his own roster.

      The board handed to the auto-pick is narrowed to two players, which is the
      fixture doing deliberately what a real board does by accident: it makes the
      cap the only thing that can decide between them. Widen it and the bot picks
      by rank and the cap is never consulted.
    */
    const fx = await setup(2);
    const order = await scheduled(fx);
    await startDraft(fx.client, fx.leagueId, SCHEDULED);

    const players = [...fx.pool.values()];
    const quarterbacks = players.filter((player) => player.positions.includes("QB"));
    const [ownQb, otherQb] = [quarterbacks[0]!, quarterbacks[1]!];
    // Not the first back in the pool: that one goes to the other team below.
    const back = players.filter((player) => player.positions.includes("RB"))[1]!;

    await recordPick(fx.client, {
      leagueId: fx.leagueId,
      teamId: order[0]!,
      playerId: ownQb.playerId,
      pool: fx.pool,
      shape: SHAPE,
      now: SCHEDULED,
    });

    // Overnight his club cuts him, and the sync rebuilds a board without him.
    const cutBoard = new Map(fx.pool);
    cutBoard.delete(ownQb.playerId);

    // The other team takes both picks at the turn.
    for (const player of [players[0]!, players[1]!]) {
      await recordPick(fx.client, {
        leagueId: fx.leagueId,
        teamId: order[1]!,
        playerId: player.playerId,
        pool: cutBoard,
        shape: SHAPE,
        now: SCHEDULED,
      });
    }

    // Back to the first team, and nobody is there to pick: the bot decides,
    // against its own roster, from a board of one quarterback and one back.
    const narrowed = new Map<string, DraftablePlayer>([
      [otherQb.playerId, { ...otherQb, rank: 1 }],
      [back.playerId, { ...back, rank: 2 }],
    ]);

    await recordPick(fx.client, {
      leagueId: fx.leagueId,
      pool: narrowed,
      shape: SHAPE,
      // Ninety seconds after the pick before it, so the clock has genuinely run
      // out — `recordPick` refuses an auto-pick whose timer is still running.
      now: new Date(SCHEDULED.getTime() + 91_000),
    });

    const roster = await fx.client.query<{ player_id: string }>(
      `SELECT player_id FROM roster_entries
        WHERE team_id = $1 AND released_at IS NULL`,
      [order[0]!],
    );
    const held = new Set(roster.map((row) => row.player_id));

    // He is still there, he was counted, and the bot took the back instead.
    expect(held.has(ownQb.playerId)).toBe(true);
    expect(held.has(back.playerId)).toBe(true);
    expect(
      [...held].filter((id) => quarterbacks.some((qb) => qb.playerId === id)),
    ).toHaveLength(1);
  });
});
