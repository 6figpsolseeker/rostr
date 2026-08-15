/**
 * Issue #77 part 4 and #112 — every trade state write is guarded, and an error
 * is never a terminal state.
 *
 * ## What these prove, and what they cannot
 *
 * PGlite is a single connection, so nothing here proves two production requests
 * overlap in wall-clock time, and `FOR UPDATE` holds nothing in it. The repo
 * says so in `migrations/README.md`, and the lineup and freeze races elsewhere
 * are genuinely untestable here for that reason.
 *
 * **These are different, and that is why the file exists.** `withdrawTrade` and
 * `declineTrade` open **no transaction at all**: their state read and their state
 * write are two separate autocommit statements. `resolveDueTrades`' pending
 * `SELECT` is likewise outside any transaction. So the production interleaving —
 * an acceptance committing between one caller's read and its write — is
 * reproducible exactly, on one connection, deterministically, by running the
 * real competing call at the instruction boundary where it would have landed.
 * No pausing, no threads, no pretending.
 *
 * A two-connection race differs only in mechanics: the loser blocks on the row
 * lock, wakes when the winner commits, and re-evaluates its `WHERE` against the
 * committed row at READ COMMITTED. Same predicate, same zero rows.
 *
 * ## Why the ordinary tests could not catch any of this
 *
 * `trades.test.ts`'s `"cannot be accepted twice"` looks like coverage of the one
 * guard that already existed and is not: delete `AND state = 'PROPOSED'` from
 * that statement and it still passes, because the second accept is refused by an
 * in-memory read that never reaches the SQL. Every guard in this file is reached
 * only when the state changes *after* that read — which is precisely what these
 * tests arrange and what nothing else in the suite does.
 */

import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import {
  acceptTrade,
  declineTrade,
  lockedByTrade,
  proposeTrade,
  resolveDueTrades,
  withdrawTrade,
} from "./trades.js";
import { dropPlayer } from "./waivers.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MONDAY = new Date("2026-10-12T18:00:00Z");
/** Past the 48-hour veto window. */
const AFTER_WINDOW = new Date(MONDAY.getTime() + 49 * HOUR);

const WEEK1_THURSDAY = new Date("2026-09-11T00:15:00Z");
const SLOTS = [0, 2 * DAY + 16 * HOUR + 45 * 60 * 1000, 4 * DAY];

/**
 * The 2026 regular season, because the deadline is derived from the schedule.
 *
 * `transactionWeek` answers `null` when the season holds no games, and `null` is
 * past every deadline — deliberately, so an unschedulable league cannot trade
 * rather than trading forever. None of these tests is about that rule, so they
 * need a league that is simply in season.
 */
async function seedSchedule(client: PGliteClient, sportId: string): Promise<void> {
  const rows: string[] = [];
  const values: unknown[] = [sportId];

  for (let week = 1; week <= 18; week++) {
    for (const [slot, offset] of SLOTS.entries()) {
      const at = new Date(WEEK1_THURSDAY.getTime() + (week - 1) * 7 * DAY + offset);
      values.push(`w${week}g${slot}`, week, at.toISOString());
      const i = values.length;
      rows.push(`($1, $${i - 2}, 2026, $${i - 1}, 'CIN', 'CLE', $${i})`);
    }
  }

  await client.query(
    `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at)
     VALUES ${rows.join(", ")}`,
    values,
  );
}

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  teams: string[];
  players: Map<string, string>;
}

/** Four teams, one player each. Teams 1 and 2 trade. */
async function setup(): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules;
  const league = await createLeague(db, NFL, {
    name: "Race League",
    commissionerId: commissioner.id,
    rules,
  });

  const teams: string[] = [];
  for (let i = 0; i < 4; i++) {
    teams.push((await addTestTeam(db, league.id, `Team ${i + 1}`)).teamId);
  }

  const [sport] = await db.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    NFL.key,
  ]);
  const [position] = await db.query<{ id: string }>(
    "SELECT id FROM positions WHERE sport_id = $1 AND key = 'RB'",
    [sport!.id],
  );

  const players = new Map<string, string>();
  for (const [index, teamId] of teams.entries()) {
    const handle = `p${index + 1}`;
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $3, $4, 'CIN') RETURNING id`,
      [sport!.id, handle, handle, position!.id],
    );
    players.set(handle, row!.id);

    await db.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
       VALUES ($1, $2, 'DRAFT', $3)`,
      [teamId, row!.id, new Date(MONDAY.getTime() - 7 * 24 * HOUR)],
    );
  }

  await seedSchedule(db, sport!.id);

  return { client: db, leagueId: league.id, teams, players };
}

async function propose(fx: Fixture): Promise<string> {
  const { tradeId } = await proposeTrade(fx.client, {
    leagueId: fx.leagueId,
    proposerTeamId: fx.teams[0]!,
    receiverTeamId: fx.teams[1]!,
    proposerGives: [fx.players.get("p1")!],
    receiverGives: [fx.players.get("p2")!],
    now: MONDAY,
  });
  return tradeId;
}

const stateOf = async (fx: Fixture, tradeId: string): Promise<string> => {
  const [row] = await fx.client.query<{ state: string }>(
    "SELECT state FROM trades WHERE id = $1",
    [tradeId],
  );
  return row!.state;
};

/**
 * A client that runs somebody else's call in the middle of yours.
 *
 * `fire` runs once, on the connection underneath, immediately **after** the
 * first query matching `arm` returns — so the caller has already read the state
 * it is about to act on, and the competing write commits before the caller's own
 * write is issued. That is the interleaving, produced rather than raced.
 */
class InterleavingClient implements SqlClient {
  private fired = false;

  constructor(
    private readonly inner: SqlClient,
    private readonly arm: (sql: string) => boolean,
    private readonly fire: (inner: SqlClient) => Promise<void>,
  ) {}

  exec(sql: string): Promise<void> {
    return this.inner.exec(sql);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]> {
    const rows = await this.inner.query<T>(sql, params);

    if (!this.fired && this.arm(sql)) {
      this.fired = true;
      await this.fire(this.inner);
    }

    return rows;
  }
}

/** Matches the `SELECT` `loadTrade` issues — the read every guard has to outlive. */
const readsTheTrade = (sql: string): boolean => sql.includes("FROM trades WHERE id = $1");

describe("a write that loses its race writes nothing", () => {
  it("refuses a withdrawal when the trade was accepted after the state was read", async () => {
    // The exploit this closes. `withdrawTrade` reads PROPOSED, the receiver's
    // acceptance commits, and the stomping write used to set WITHDRAWN over the
    // top — which did not merely mislabel the row. `lockedByTrade` counts only
    // ACCEPTED trades, so it **unfroze both players in the same statement**, and
    // the proposer could then drop the player they had promised. The route has
    // no rate limit, so a proposer wanting out could fire withdrawals until one
    // landed on the accept.
    const fx = await setup();
    const tradeId = await propose(fx);

    const racing = new InterleavingClient(fx.client, readsTheTrade, async (inner) => {
      await acceptTrade(inner, tradeId, fx.teams[1]!, MONDAY);
    });

    await expect(withdrawTrade(racing, tradeId, fx.teams[0]!, MONDAY)).rejects.toMatchObject({
      code: "WRONG_STATE",
    });

    expect(await stateOf(fx, tradeId)).toBe("ACCEPTED");

    // The freeze survived, which is the half that had teeth.
    const frozen = await lockedByTrade(fx.client, fx.leagueId);
    expect(frozen.has(fx.players.get("p1")!)).toBe(true);
    expect(frozen.has(fx.players.get("p2")!)).toBe(true);

    await expect(
      dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("p1")!, MONDAY),
    ).rejects.toMatchObject({ code: "IN_A_TRADE" });
  });

  it("refuses a decline when the trade was accepted after the state was read", async () => {
    // Needs one manager and one browser rather than two people racing:
    // `TradeBlock` renders Accept and Decline side by side on a PROPOSED trade,
    // and the panel only re-reads after the mutation returns.
    const fx = await setup();
    const tradeId = await propose(fx);

    const racing = new InterleavingClient(fx.client, readsTheTrade, async (inner) => {
      await acceptTrade(inner, tradeId, fx.teams[1]!, MONDAY);
    });

    await expect(declineTrade(racing, tradeId, fx.teams[1]!, MONDAY)).rejects.toMatchObject({
      code: "WRONG_STATE",
    });

    expect(await stateOf(fx, tradeId)).toBe("ACCEPTED");
  });

  it("does not relabel an executed trade EXPIRED when a second run overlaps it", async () => {
    // Part 4(a). Two overlapping cron runs both select the trade. The first
    // executes it and commits; the second's release `UPDATE ... WHERE
    // released_at IS NULL` then matches nothing, raises ASSET_GONE, and used to
    // record EXPIRED unguarded — "rosters untouched", written about rosters that
    // had just moved, and reported to both managers.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    let overlapRan = false;
    const racing = new InterleavingClient(
      fx.client,
      (sql) => sql.includes("FROM trade_assets"),
      async (inner) => {
        await resolveDueTrades(inner, fx.leagueId, AFTER_WINDOW);
        overlapRan = true;
      },
    );

    const outcome = await resolveDueTrades(racing, fx.leagueId, AFTER_WINDOW);

    expect(overlapRan).toBe(true);
    expect(await stateOf(fx, tradeId)).toBe("EXECUTED");

    // The losing run reports nothing settled and writes nothing at all.
    expect(outcome.resolutions).toEqual([]);

    // And the swap happened exactly once — one live row per player.
    const rows = await fx.client.query<{ team_id: string; player_id: string }>(
      `SELECT team_id, player_id FROM roster_entries
        WHERE league_id = $1 AND released_at IS NULL AND acquired_via = 'TRADE'`,
      [fx.leagueId],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.player_id)).size).toBe(2);
  });
  it("does not execute a trade that was vetoed while it was executing", async () => {
    // The case the `EXECUTED` write's own guard exists for, and the reason that
    // one write must **throw** rather than answer "somebody got there first":
    // it sits inside the transaction that has already swapped both rosters.
    //
    // Reachable from two overlapping runs. Both select the trade as ACCEPTED;
    // the first reads the votes before a blocking veto is cast and heads for
    // execution, the second reads them after and writes VETOED. Without the
    // guard the executing run overwrites VETOED with EXECUTED and commits the
    // swap — a trade the league blocked, performed anyway. Answering "already
    // settled" without throwing would be just as wrong: it commits the swap and
    // leaves the row saying VETOED, so the players have moved under a state that
    // says they did not.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    // Fired on `loadTrade`'s read, which is **before** `withTransaction` opens.
    // That ordering is forced rather than chosen: PGlite is a single connection,
    // so a write injected after `BEGIN` would join the executing transaction and
    // roll back with it — proving nothing. Committing first is also the honest
    // model of the production interleaving, where the vetoing run is a separate
    // connection that has already committed.
    const racing = new InterleavingClient(fx.client, readsTheTrade, async (inner) => {
      await inner.query("UPDATE trades SET state = 'VETOED', resolved_at = $2 WHERE id = $1", [
        tradeId,
        AFTER_WINDOW.toISOString(),
      ]);
    });

    const outcome = await resolveDueTrades(racing, fx.leagueId, AFTER_WINDOW);

    // The swap rolled back whole, which is what the transaction is for.
    expect(await stateOf(fx, tradeId)).toBe("VETOED");
    expect(outcome.resolutions).toEqual([]);
    expect(outcome.failures).toEqual([{ tradeId, reason: "WRONG_STATE" }]);

    const moved = await fx.client.query<{ id: string }>(
      `SELECT id FROM roster_entries
        WHERE league_id = $1 AND acquired_via = 'TRADE'`,
      [fx.leagueId],
    );
    expect(moved).toEqual([]);

    // And both players are still where they started.
    const [p1] = await fx.client.query<{ team_id: string }>(
      "SELECT team_id FROM roster_entries WHERE player_id = $1 AND released_at IS NULL",
      [fx.players.get("p1")!],
    );
    expect(p1?.team_id).toBe(fx.teams[0]);
  });
});

describe("an error is never a terminal state", () => {
  /** A client whose transactions all fail the way a saturated pool fails. */
  class DeadlockingClient implements SqlClient {
    constructor(private readonly inner: SqlClient) {}

    async exec(sql: string): Promise<void> {
      if (sql === "BEGIN") {
        const error = new Error("deadlock detected") as Error & { code: string };
        error.code = "40P01";
        throw error;
      }
      return this.inner.exec(sql);
    }

    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      return this.inner.query<T>(sql, params);
    }
  }

  it("leaves a trade ACCEPTED when execution fails for an infrastructure reason", async () => {
    // The blocking finding on #112. Widening the catch to every error is right —
    // an allowlist of one code inside a loop is the shape `CLAUDE.md` names as
    // the defect. But "record and continue" must mean *record in the return
    // value*, as `resolveLeagueWeeksThrough` does, and not write EXPIRED.
    //
    // `withTransaction` calls `connect()` before `BEGIN` and the pool has a
    // connect timeout, so one saturated pool during an hourly run would expire
    // every due trade in every league, in one pass and permanently — nothing
    // revisits EXPIRED. RULES.md defines EXPIRED as the deadline case, "rosters
    // untouched, nobody's fault", and §9 forbids reversing trades. Expiring on a
    // blip is the system reversing a trade the league approved.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const outcome = await resolveDueTrades(
      new DeadlockingClient(fx.client),
      fx.leagueId,
      AFTER_WINDOW,
    );

    expect(await stateOf(fx, tradeId)).toBe("ACCEPTED");
    expect(outcome.resolutions).toEqual([]);
    expect(outcome.failures).toEqual([{ tradeId, reason: "deadlock detected" }]);
  });

  it("still settles the other trades when one fails that way", async () => {
    // The half #112 is actually about: the failure must not abort the loop. It
    // used to rethrow, so a healthy trade queued behind a poisoned one stayed
    // ACCEPTED too and uninvolved managers' players stayed frozen — every hour,
    // for the rest of the season.
    const fx = await setup();
    const poisoned = await propose(fx);
    await acceptTrade(fx.client, poisoned, fx.teams[1]!, MONDAY);

    const { tradeId: healthy } = await proposeTrade(fx.client, {
      leagueId: fx.leagueId,
      proposerTeamId: fx.teams[2]!,
      receiverTeamId: fx.teams[3]!,
      proposerGives: [fx.players.get("p3")!],
      receiverGives: [fx.players.get("p4")!],
      now: MONDAY,
    });
    await acceptTrade(fx.client, healthy, fx.teams[3]!, MONDAY);

    // Fail only the first transaction, so the second trade takes the real path.
    let failures = 1;
    const flaky: SqlClient = {
      exec: async (sql) => {
        if (sql === "BEGIN" && failures > 0) {
          failures--;
          const error = new Error("deadlock detected") as Error & { code: string };
          error.code = "40P01";
          throw error;
        }
        return fx.client.exec(sql);
      },
      query: (sql, params) => fx.client.query(sql, params),
    };

    const outcome = await resolveDueTrades(flaky, fx.leagueId, AFTER_WINDOW);

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.resolutions).toHaveLength(1);
    expect(outcome.resolutions[0]?.outcome).toBe("EXECUTED");

    // The one that failed is untouched and will be retried next hour; the other
    // settled.
    const failed = outcome.failures[0]!.tradeId;
    const settled = outcome.resolutions[0]!.tradeId;
    expect(await stateOf(fx, failed)).toBe("ACCEPTED");
    expect(await stateOf(fx, settled)).toBe("EXECUTED");
    expect(new Set([failed, settled])).toEqual(new Set([poisoned, healthy]));
  });
});

describe("the guards do not refuse a write that should happen", () => {
  /** Counts rows returned by each `UPDATE trades`, readable only via RETURNING. */
  class CountingClient implements SqlClient {
    readonly stateWrites: number[] = [];

    constructor(private readonly inner: SqlClient) {}

    exec(sql: string): Promise<void> {
      return this.inner.exec(sql);
    }

    async query<T = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      const rows = await this.inner.query<T>(sql, params);
      if (sql.includes("UPDATE trades SET state")) this.stateWrites.push(rows.length);
      return rows;
    }
  }

  it("writes exactly one row on an ordinary execution", async () => {
    // The negative test that matters most. A predicate pasted against the wrong
    // state would silently refuse every write while `resolveDueTrades` still
    // returned the outcome it computed in memory, and nothing else in the suite
    // would notice — the assertions elsewhere read the return value, not the row.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const counting = new CountingClient(fx.client);
    const outcome = await resolveDueTrades(counting, fx.leagueId, AFTER_WINDOW);

    expect(outcome.resolutions[0]?.outcome).toBe("EXECUTED");
    expect(counting.stateWrites).toEqual([1]);
    expect(await stateOf(fx, tradeId)).toBe("EXECUTED");
  });

  it("writes exactly one row when a proposer legitimately withdraws", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);

    const counting = new CountingClient(fx.client);
    await withdrawTrade(counting, tradeId, fx.teams[0]!, MONDAY);

    expect(counting.stateWrites).toEqual([1]);
    expect(await stateOf(fx, tradeId)).toBe("WITHDRAWN");
  });
});
