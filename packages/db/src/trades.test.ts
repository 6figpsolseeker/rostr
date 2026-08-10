import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { availabilityOf, dropPlayer } from "./waivers.js";
import {
  acceptTrade,
  declineTrade,
  leaguesWithDueTrades,
  listTrades,
  lockedByTrade,
  proposeTrade,
  resolveDueTrades,
  TradeError,
  vetoTrade,
  withdrawTrade,
} from "./trades.js";

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
const MONDAY = new Date("2026-10-12T18:00:00Z");

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  rules: LeagueRules;
  /** Six teams. The first two trade; the other four are the electorate. */
  teams: string[];
  players: Map<string, string>;
}

/**
 * Six human teams, each holding one player.
 *
 * Six is chosen so the arithmetic is legible: two trading leaves four
 * uninvolved managers and a third of four rounds up to two, so exactly two
 * votes block a trade and one does not.
 */
async function setup(overrides?: Partial<LeagueRules>): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = {
    ...buildNflPprRules({ seasonYear: 2026, draft: DRAFT }),
    ...overrides,
  } as LeagueRules;
  const league = await createLeague(db, NFL, {
    name: "Trade League",
    commissionerId: commissioner.id,
    rules,
  });

  const teams: string[] = [];
  for (let i = 0; i < 6; i++) {
    teams.push((await addTestTeam(db, league.id, `Team ${i + 1}`)).teamId);
  }

  const [sport] = await db.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    NFL.key,
  ]);
  const [position] = await db.query<{ id: string }>(
    "SELECT id FROM positions WHERE sport_id = $1 AND key = 'RB'",
    [sport!.id],
  );

  // One player per team, named for the team that holds him.
  const players = new Map<string, string>();
  for (const [index, teamId] of teams.entries()) {
    const handle = `p${index + 1}`;
    const [player] = await db.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $3, $4, 'CIN') RETURNING id`,
      [sport!.id, handle, handle, position!.id],
    );
    players.set(handle, player!.id);

    await db.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
       VALUES ($1, $2, 'DRAFT', $3)`,
      [teamId, player!.id, new Date(MONDAY.getTime() - 30 * 24 * HOUR)],
    );
  }

  // One spare on team 1, so a two-for-one has something to be uneven with.
  const [spare] = await db.query<{ id: string }>(
    `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
     VALUES ($1, 'spare', 'spare', $2, 'CIN') RETURNING id`,
    [sport!.id, position!.id],
  );
  players.set("spare", spare!.id);
  await db.query(
    `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
     VALUES ($1, $2, 'DRAFT', $3)`,
    [teams[0], spare!.id, new Date(MONDAY.getTime() - 30 * 24 * HOUR)],
  );

  return { client: db, leagueId: league.id, rules, teams, players };
}

/**
 * Put a kickoff on the calendar, so `currentWeek` has something to answer with.
 * The week is read from the schedule rather than guessed from the date.
 */
async function kickoff(fx: Fixture, week: number, at: Date): Promise<void> {
  const [sport] = await fx.client.query<{ id: string }>(
    "SELECT id FROM sports WHERE key = $1",
    [NFL.key],
  );
  await fx.client.query(
    `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at)
     VALUES ($1, $2, 2026, $3, 'CIN', 'CLE', $4)`,
    [sport!.id, `w${week}`, week, at.toISOString()],
  );
}

/** The straightforward one-for-one: team 1's player for team 2's. */
async function propose(fx: Fixture, week = 5, now = MONDAY): Promise<string> {
  const { tradeId } = await proposeTrade(fx.client, {
    leagueId: fx.leagueId,
    proposerTeamId: fx.teams[0]!,
    receiverTeamId: fx.teams[1]!,
    proposerGives: [fx.players.get("p1")!],
    receiverGives: [fx.players.get("p2")!],
    week,
    now,
  });
  return tradeId;
}

describe("proposing", () => {
  it("records both sides", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);

    const [trade] = await listTrades(fx.client, fx.leagueId);

    expect(trade?.tradeId).toBe(tradeId);
    expect(trade?.state).toBe("PROPOSED");
    expect(trade?.proposerGives).toEqual([fx.players.get("p1")]);
    expect(trade?.receiverGives).toEqual([fx.players.get("p2")]);
  });

  it("reports how many vetoes it would take", async () => {
    // Six teams, two trading: four uninvolved managers, a third of which is 1.33,
    // rounded up to 2.
    const fx = await setup();
    await propose(fx);

    const [trade] = await listTrades(fx.client, fx.leagueId);
    expect(trade?.vetoesRequired).toBe(2);
  });

  it("refuses a player the proposing team does not own", async () => {
    const fx = await setup();

    await expect(
      proposeTrade(fx.client, {
        leagueId: fx.leagueId,
        proposerTeamId: fx.teams[0]!,
        // Team 3's player, offered by team 1.
        proposerGives: [fx.players.get("p3")!],
        receiverTeamId: fx.teams[1]!,
        receiverGives: [fx.players.get("p2")!],
        week: 5,
        now: MONDAY,
      }),
    ).rejects.toMatchObject({ code: "NOT_YOUR_PLAYER" });
  });

  it("refuses a player the receiving team does not own", async () => {
    const fx = await setup();

    await expect(
      proposeTrade(fx.client, {
        leagueId: fx.leagueId,
        proposerTeamId: fx.teams[0]!,
        proposerGives: [fx.players.get("p1")!],
        receiverTeamId: fx.teams[1]!,
        receiverGives: [fx.players.get("p3")!],
        week: 5,
        now: MONDAY,
      }),
    ).rejects.toMatchObject({ code: "NOT_YOUR_PLAYER" });
  });

  it("refuses after the deadline", async () => {
    const fx = await setup();

    await expect(propose(fx, fx.rules.trades.deadlineWeek + 1)).rejects.toMatchObject({
      code: "PAST_DEADLINE",
    });
  });

  it("allows one in the deadline week itself", async () => {
    const fx = await setup();
    await expect(propose(fx, fx.rules.trades.deadlineWeek)).resolves.toBeTypeOf("string");
  });

  it("honours a commissioner-set deadline", async () => {
    const base = buildNflPprRules({ seasonYear: 2026, draft: DRAFT });
    const fx = await setup({ trades: { ...base.trades, deadlineWeek: 8 } });

    await expect(propose(fx, 9)).rejects.toMatchObject({ code: "PAST_DEADLINE" });
    await expect(propose(fx, 8)).resolves.toBeTypeOf("string");
  });

  it("refuses when the league disabled trading", async () => {
    const base = buildNflPprRules({ seasonYear: 2026, draft: DRAFT });
    const fx = await setup({ trades: { ...base.trades, enabled: false } });

    await expect(propose(fx)).rejects.toMatchObject({ code: "TRADES_DISABLED" });
  });

  it("refuses a trade involving a bot", async () => {
    // A bot has nobody to weigh an offer. Letting one be proposed to would
    // either strand the trade or make the bot judge it.
    const fx = await setup();
    await fx.client.query("UPDATE teams SET owner_id = NULL, is_bot = true WHERE id = $1", [
      fx.teams[1],
    ]);

    await expect(propose(fx)).rejects.toMatchObject({ code: "BOT_CANNOT_TRADE" });
  });

  it("writes nothing when a leg is invalid", async () => {
    // The rejection happens partway through the loop, after the first player
    // validated. A half-written trade would show up in the league's list.
    const fx = await setup();

    await expect(
      proposeTrade(fx.client, {
        leagueId: fx.leagueId,
        proposerTeamId: fx.teams[0]!,
        proposerGives: [fx.players.get("p1")!],
        receiverTeamId: fx.teams[1]!,
        receiverGives: [fx.players.get("p4")!],
        week: 5,
        now: MONDAY,
      }),
    ).rejects.toBeInstanceOf(TradeError);

    expect(await listTrades(fx.client, fx.leagueId)).toHaveLength(0);
  });
});

describe("responding", () => {
  it("opens the veto window on acceptance", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);

    const accepted = await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    expect(accepted.state).toBe("ACCEPTED");
    expect(accepted.vetoDeadline?.getTime()).toBe(MONDAY.getTime() + 48 * HOUR);
  });

  it("lets only the receiving team accept", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);

    await expect(acceptTrade(fx.client, tradeId, fx.teams[0]!, MONDAY)).rejects.toMatchObject({
      code: "NOT_YOUR_TRADE",
    });
    await expect(acceptTrade(fx.client, tradeId, fx.teams[2]!, MONDAY)).rejects.toMatchObject({
      code: "NOT_YOUR_TRADE",
    });
  });

  it("cannot be accepted twice", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    await expect(acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY)).rejects.toMatchObject({
      code: "WRONG_STATE",
    });
  });

  it("lets the receiving team decline", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);

    await declineTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const [trade] = await listTrades(fx.client, fx.leagueId);
    expect(trade?.state).toBe("WITHDRAWN");
  });

  it("lets the proposer withdraw before acceptance", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);

    await withdrawTrade(fx.client, tradeId, fx.teams[0]!, MONDAY);

    const [trade] = await listTrades(fx.client, fx.leagueId);
    expect(trade?.state).toBe("WITHDRAWN");
  });

  it("refuses a withdrawal once the trade is accepted", async () => {
    // Otherwise a proposer could pull a trade the moment it looked like
    // surviving the veto — the window would only ever run against them.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    await expect(withdrawTrade(fx.client, tradeId, fx.teams[0]!, MONDAY)).rejects.toMatchObject(
      { code: "WRONG_STATE" },
    );
  });
});

describe("the freeze between acceptance and execution", () => {
  it("locks both players", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const locked = await lockedByTrade(fx.client, fx.leagueId);

    expect(locked.has(fx.players.get("p1")!)).toBe(true);
    expect(locked.has(fx.players.get("p2")!)).toBe(true);
    expect(locked.has(fx.players.get("p3")!)).toBe(false);
  });

  it("locks nothing while the trade is only proposed", async () => {
    // An offer nobody has taken commits nobody. Freezing on proposal would let
    // one manager tie up another's roster for free.
    const fx = await setup();
    await propose(fx);

    expect(await lockedByTrade(fx.client, fx.leagueId)).toEqual(new Set());
  });

  it("stops a committed player being dropped", async () => {
    // Without it, a manager accepts a trade and then cuts the player they
    // promised, and execution finds a hole where a roster spot used to be.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    await expect(
      dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("p1")!, MONDAY),
    ).rejects.toMatchObject({ code: "IN_A_TRADE" });
  });

  it("stops a committed player entering a second trade", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    await expect(
      proposeTrade(fx.client, {
        leagueId: fx.leagueId,
        proposerTeamId: fx.teams[0]!,
        proposerGives: [fx.players.get("p1")!],
        receiverTeamId: fx.teams[2]!,
        receiverGives: [fx.players.get("p3")!],
        week: 5,
        now: MONDAY,
      }),
    ).rejects.toMatchObject({ code: "PLAYER_IN_ANOTHER_TRADE" });
  });

  it("releases the lock once the trade executes", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await resolveDueTrades(fx.client, fx.leagueId, new Date(MONDAY.getTime() + 49 * HOUR));

    expect(await lockedByTrade(fx.client, fx.leagueId)).toEqual(new Set());
  });
});

describe("vetoing", () => {
  it("counts a vote", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const after = await vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY);

    expect(after.vetoes).toBe(1);
    expect(after.vetoesRequired).toBe(2);
  });

  it("refuses a team in the trade", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    await expect(vetoTrade(fx.client, tradeId, fx.teams[0]!, MONDAY)).rejects.toMatchObject({
      code: "INVOLVED_CANNOT_VETO",
    });
    await expect(vetoTrade(fx.client, tradeId, fx.teams[1]!, MONDAY)).rejects.toMatchObject({
      code: "INVOLVED_CANNOT_VETO",
    });
  });

  it("refuses a bot", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await fx.client.query("UPDATE teams SET owner_id = NULL, is_bot = true WHERE id = $1", [
      fx.teams[2],
    ]);

    await expect(vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY)).rejects.toMatchObject({
      code: "BOT_CANNOT_VETO",
    });
  });

  it("refuses a veto from a team in another league", async () => {
    // The electorate is the trade's own league. A team from a different league
    // is not in it, so its vote must not be counted toward the veto threshold —
    // otherwise an outsider could force a veto a small league never wanted.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const other = await createUser(fx.client, "other@example.com", "Other");
    const otherLeague = await createLeague(fx.client, NFL, {
      name: "Other League",
      commissionerId: other.id,
      rules: buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules,
    });
    const outsider = (await addTestTeam(fx.client, otherLeague.id, "Outsider")).teamId;

    await expect(vetoTrade(fx.client, tradeId, outsider, MONDAY)).rejects.toMatchObject({
      code: "NOT_IN_LEAGUE",
    });
  });

  it("refuses a second vote from the same team", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY);

    await expect(vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY)).rejects.toMatchObject({
      code: "ALREADY_VETOED",
    });
  });

  it("refuses a vote on a trade nobody has accepted", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);

    await expect(vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY)).rejects.toMatchObject({
      code: "WRONG_STATE",
    });
  });

  it("does not count a bot in the denominator", async () => {
    // Six teams with one bot: two trading leaves three uninvolved *managers*,
    // and a third of three is 1. Counting the bot would make it 2 while leaving
    // the pool of possible voters at three.
    const fx = await setup();
    await fx.client.query("UPDATE teams SET owner_id = NULL, is_bot = true WHERE id = $1", [
      fx.teams[5],
    ]);
    const tradeId = await propose(fx);

    const [trade] = await listTrades(fx.client, fx.leagueId);
    expect(trade?.vetoesRequired).toBe(1);

    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY);

    const [resolution] = await resolveDueTrades(
      fx.client,
      fx.leagueId,
      new Date(MONDAY.getTime() + 49 * HOUR),
    );
    expect(resolution?.outcome).toBe("VETOED");
  });
});

describe("resolution", () => {
  const AFTER = new Date(MONDAY.getTime() + 49 * HOUR);

  it("leaves the window alone before it closes", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const resolved = await resolveDueTrades(
      fx.client,
      fx.leagueId,
      new Date(MONDAY.getTime() + 47 * HOUR),
    );

    expect(resolved).toEqual([]);
    const [trade] = await listTrades(fx.client, fx.leagueId);
    expect(trade?.state).toBe("ACCEPTED");
  });

  it("executes at the hour the window closes", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const [resolution] = await resolveDueTrades(
      fx.client,
      fx.leagueId,
      new Date(MONDAY.getTime() + 48 * HOUR),
    );

    expect(resolution?.outcome).toBe("EXECUTED");
  });

  it("swaps the rosters", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await resolveDueTrades(fx.client, fx.leagueId, AFTER);

    const owners = await fx.client.query<{ player_id: string; team_id: string }>(
      `SELECT player_id, team_id FROM roster_entries
        WHERE released_at IS NULL AND player_id = ANY($1)`,
      [[fx.players.get("p1"), fx.players.get("p2")]],
    );

    expect(new Map(owners.map((row) => [row.player_id, row.team_id]))).toEqual(
      new Map([
        [fx.players.get("p1")!, fx.teams[1]!],
        [fx.players.get("p2")!, fx.teams[0]!],
      ]),
    );
  });

  it("keeps the old roster rows rather than repointing them", async () => {
    // `roster_entries` is append-only with `released_at` precisely so any past
    // week's roster can be reconstructed. A trade that edited history would make
    // a settled week unverifiable.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await resolveDueTrades(fx.client, fx.leagueId, AFTER);

    const history = await fx.client.query<{ team_id: string; released_at: string | null }>(
      "SELECT team_id, released_at FROM roster_entries WHERE player_id = $1 ORDER BY acquired_at",
      [fx.players.get("p1")],
    );

    expect(history).toHaveLength(2);
    expect(history[0]?.team_id).toBe(fx.teams[0]);
    expect(history[0]?.released_at).not.toBeNull();
    expect(history[1]?.team_id).toBe(fx.teams[1]);
    expect(history[1]?.released_at).toBeNull();
  });

  it("does not put traded players on waivers", async () => {
    // A trade is not a drop. If execution went through the release path a
    // traded player would surface as claimable by the rest of the league.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await resolveDueTrades(fx.client, fx.leagueId, AFTER);

    expect(await availabilityOf(fx.client, fx.leagueId, fx.players.get("p1")!, AFTER)).toBe(
      "ROSTERED",
    );
  });

  it("blocks a trade that reached the threshold", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[3]!, MONDAY);

    const [resolution] = await resolveDueTrades(fx.client, fx.leagueId, AFTER);

    expect(resolution?.outcome).toBe("VETOED");
    expect(resolution?.vetoes).toBe(2);
    expect(resolution?.required).toBe(2);
  });

  it("executes a trade one vote short", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY);

    const [resolution] = await resolveDueTrades(fx.client, fx.leagueId, AFTER);

    expect(resolution?.outcome).toBe("EXECUTED");
  });

  it("leaves rosters untouched when a trade is vetoed", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[3]!, MONDAY);
    await resolveDueTrades(fx.client, fx.leagueId, AFTER);

    const [row] = await fx.client.query<{ team_id: string }>(
      "SELECT team_id FROM roster_entries WHERE player_id = $1 AND released_at IS NULL",
      [fx.players.get("p1")],
    );
    expect(row?.team_id).toBe(fx.teams[0]);
  });

  it("is idempotent", async () => {
    // The cron runs hourly. A second pass must not re-execute a swap, which
    // would release a player from the team that just received him.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await resolveDueTrades(fx.client, fx.leagueId, AFTER);

    const again = await resolveDueTrades(
      fx.client,
      fx.leagueId,
      new Date(AFTER.getTime() + HOUR),
    );

    expect(again).toEqual([]);
    const owners = await fx.client.query<{ team_id: string }>(
      "SELECT team_id FROM roster_entries WHERE player_id = $1 AND released_at IS NULL",
      [fx.players.get("p1")],
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]?.team_id).toBe(fx.teams[1]);
  });

  it("expires a trade whose window closed after the deadline", async () => {
    // The deadline binds on the week a trade *executes*. Checking only at
    // proposal bounds the earliest week it might land in — a trade proposed on
    // the deadline and accepted days later slides past it, and this is where
    // that is caught.
    const fx = await setup();
    const tradeId = await propose(fx, fx.rules.trades.deadlineWeek);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await kickoff(fx, fx.rules.trades.deadlineWeek + 1, new Date(MONDAY.getTime() + 40 * HOUR));

    const [resolution] = await resolveDueTrades(fx.client, fx.leagueId, AFTER);

    expect(resolution?.outcome).toBe("EXPIRED");

    const [row] = await fx.client.query<{ team_id: string }>(
      "SELECT team_id FROM roster_entries WHERE player_id = $1 AND released_at IS NULL",
      [fx.players.get("p1")],
    );
    expect(row?.team_id).toBe(fx.teams[0]);
  });

  it("executes when the closing week is still inside the deadline", async () => {
    const fx = await setup();
    const tradeId = await propose(fx, fx.rules.trades.deadlineWeek);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await kickoff(fx, fx.rules.trades.deadlineWeek, new Date(MONDAY.getTime() - HOUR));

    const [resolution] = await resolveDueTrades(fx.client, fx.leagueId, AFTER);

    expect(resolution?.outcome).toBe("EXECUTED");
  });

  it("executes an uneven trade", async () => {
    // Two for one. Team 1 starts with two players and ends with one; team 2
    // starts with one and ends with two. Rosters changing size is legal — a
    // roster limit is a lineup concern, not a trade one.
    const fx = await setup();
    const { tradeId } = await proposeTrade(fx.client, {
      leagueId: fx.leagueId,
      proposerTeamId: fx.teams[0]!,
      proposerGives: [fx.players.get("p1")!, fx.players.get("spare")!],
      receiverTeamId: fx.teams[1]!,
      receiverGives: [fx.players.get("p2")!],
      week: 5,
      now: MONDAY,
    });
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await resolveDueTrades(fx.client, fx.leagueId, AFTER);

    const sizes = await fx.client.query<{ team_id: string; n: number }>(
      `SELECT team_id, count(*)::int AS n FROM roster_entries
        WHERE released_at IS NULL AND team_id = ANY($1)
        GROUP BY team_id`,
      [[fx.teams[0], fx.teams[1]]],
    );

    expect(new Map(sizes.map((row) => [row.team_id, Number(row.n)]))).toEqual(
      new Map([
        [fx.teams[0]!, 1],
        [fx.teams[1]!, 2],
      ]),
    );
  });
});

describe("finding work", () => {
  it("names a league with a closed window", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const due = await leaguesWithDueTrades(fx.client, new Date(MONDAY.getTime() + 49 * HOUR));

    expect(due).toEqual([fx.leagueId]);
  });

  it("names nothing while every window is open", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    expect(await leaguesWithDueTrades(fx.client, new Date(MONDAY.getTime() + HOUR))).toEqual(
      [],
    );
  });

  it("names a league once however many trades are due", async () => {
    const fx = await setup();
    const first = await propose(fx);
    await acceptTrade(fx.client, first, fx.teams[1]!, MONDAY);

    const { tradeId: second } = await proposeTrade(fx.client, {
      leagueId: fx.leagueId,
      proposerTeamId: fx.teams[2]!,
      proposerGives: [fx.players.get("p3")!],
      receiverTeamId: fx.teams[3]!,
      receiverGives: [fx.players.get("p4")!],
      week: 5,
      now: MONDAY,
    });
    await acceptTrade(fx.client, second, fx.teams[3]!, MONDAY);

    expect(
      await leaguesWithDueTrades(fx.client, new Date(MONDAY.getTime() + 49 * HOUR)),
    ).toEqual([fx.leagueId]);
  });
});

describe("listing", () => {
  it("filters by state", async () => {
    const fx = await setup();
    const open = await propose(fx);

    const { tradeId: gone } = await proposeTrade(fx.client, {
      leagueId: fx.leagueId,
      proposerTeamId: fx.teams[2]!,
      proposerGives: [fx.players.get("p3")!],
      receiverTeamId: fx.teams[3]!,
      receiverGives: [fx.players.get("p4")!],
      week: 5,
      now: MONDAY,
    });
    await declineTrade(fx.client, gone, fx.teams[3]!, MONDAY);

    const proposed = await listTrades(fx.client, fx.leagueId, ["PROPOSED"]);

    expect(proposed.map((trade) => trade.tradeId)).toEqual([open]);
  });
});
