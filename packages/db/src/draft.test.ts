import { afterEach, describe, expect, it } from "vitest";
import {
  buildNflPprRules,
  buildRosterShape,
  deriveOrderSeed,
  generateDraftOrder,
  NFL,
  NFL_PPR_ROSTER,
  totalPicks,
} from "@rostr/core";
import type { DraftablePlayer, DraftRules, LeagueRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { addBot } from "./membership.js";
import { seedSport } from "./sports.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { FixedBeacon } from "./randomness.js";
import {
  createDraftRecord,
  draftProgress,
  DraftPersistenceError,
  draftsWithExpiredPicks,
  drawDraftOrder,
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

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "FAST",
  pickSeconds: 90,
  scheduledAt: 1_756_400_000,
};

const SHAPE = buildRosterShape(NFL_PPR_ROSTER, NFL);
const SCHEDULED = new Date("2026-08-22T18:00:00Z");
const SCHEDULED_SECONDS = Math.floor(SCHEDULED.getTime() / 1000);

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

/** After the draft time, so the draw is allowed. */
const DRAW_TIME = new Date(SCHEDULED.getTime() + 5_000);

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
    const bot = await addBot(db, league.id, `Bot ${i + 1}`);
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
        now: DRAW_TIME,
      }),
    ).rejects.toMatchObject({ code: "ORDER_ALREADY_DRAWN" });
  });

  it("refuses a league with no teams", async () => {
    const fx = await setup(0);
    await createDraftRecord(fx.client, scheduleArgs(fx.leagueId));

    await expect(
      drawDraftOrder(fx.client, { leagueId: fx.leagueId, beacon: BEACON, now: DRAW_TIME }),
    ).rejects.toMatchObject({ code: "NO_TEAMS" });
  });

  it("refuses to draw for a league with no draft", async () => {
    const fx = await setup();

    await expect(
      drawDraftOrder(fx.client, { leagueId: fx.leagueId, beacon: BEACON, now: DRAW_TIME }),
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

    await expect(addBot(fx.client, fx.leagueId, "Late Bot")).rejects.toThrow(
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
    expect(result.nextTeamId).toBe(fx.order[1]);
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
      now: SCHEDULED,
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
      now: SCHEDULED,
    });

    expect(await getQueue(fx.client, fx.order[1]!)).toEqual([]);
  });

  it("falls back to best available when the queue is empty", async () => {
    const fx = await started();

    const result = await recordPick(fx.client, {
      leagueId: fx.leagueId,
      pool: fx.pool,
      shape: SHAPE,
      now: SCHEDULED,
    });

    expect(result.source).not.toBe("MANUAL");
    expect(result.source).not.toBe("QUEUE");
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
        now: SCHEDULED,
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
        now: SCHEDULED,
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
        now: SCHEDULED,
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
        now: SCHEDULED,
      });
    }

    await expect(startDraft(fx.client, fx.leagueId, SCHEDULED)).rejects.toBeInstanceOf(
      DraftPersistenceError,
    );
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
