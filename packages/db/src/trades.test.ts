import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import {
  addFreeAgent,
  availabilityOf,
  dropPlayer,
  processWaivers,
  seedWaiverPriority,
  submitClaim,
} from "./waivers.js";
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
const DAY = 24 * HOUR;
const MONDAY = new Date("2026-10-12T18:00:00Z");
/** Past the 48-hour veto window, so an accepted trade is due to resolve. */
const AFTER_WINDOW = new Date(MONDAY.getTime() + 49 * HOUR);

/**
 * The real 2026 season, so a week number means something.
 *
 * Week 1's Thursday is 10 September 2026, the opener following Labor Day, which
 * puts week 11 on 19-23 November and matches the trade deadline in `CLAUDE.md`'s
 * calendar. `MONDAY` above is week 5's Monday night on the same schedule.
 *
 * **Three kickoffs a week, and every week, because fewer of either cannot see
 * the bug this fixture exists for.** The deadline used to be checked with
 * `currentWeek`, which disagrees with `transactionWeek` only while the calendar
 * holds a week whose games are finished *and* a following week whose games have
 * not started. A single-week fixture makes that state unrepresentable, which is
 * why the two deadline tests this replaces both passed under the bug.
 *
 * Kickoffs step a uniform seven days in UTC, so from November they read an hour
 * earlier in local time than the NFL plays. Deliberate and harmless: the rules
 * turn on which side of Tuesday 00:00 **Eastern** a game falls, and an hour does
 * not move any of these across it. That boundary is computed by `nextWeekly`
 * from the league's frozen rules, which is code under test rather than fixture.
 */
const WEEK1_THURSDAY = new Date("2026-09-11T00:15:00Z");
/** Thursday night, Sunday afternoon, Monday night, as offsets from the Thursday. */
const SLOTS = [0, 2 * DAY + 16 * HOUR + 45 * 60 * 1000, 4 * DAY];

/**
 * The week-11/12 boundary, which is where the default deadline lives.
 *
 * Week 11's last game kicks off Monday evening; the league starts transacting in
 * week 12 at Tuesday 00:00 ET, hours later; week 12's first game is not until
 * the Thursday. So for three days "the week whose games were played" and "the
 * week a roster change lands in" are different numbers, and every assertion
 * below turns on which one the deadline is measured against.
 */
const WEEK11_FRIDAY = new Date("2026-11-20T18:00:00Z");
const WEEK11_SUNDAY = new Date("2026-11-22T18:00:00Z");
/** Monday 23:00 ET, after week 11's last kickoff and before the Tuesday lock. */
const BEFORE_WEEK12_LOCK = new Date("2026-11-24T04:00:00Z");
/** Tuesday 01:00 ET, an hour past it and still three days from any week-12 game. */
const AFTER_WEEK12_LOCK = new Date("2026-11-24T06:00:00Z");

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

  await seedSchedule(db, sport!.id);

  return { client: db, leagueId: league.id, rules, teams, players };
}

/**
 * The whole 2026 regular season, on the calendar above.
 *
 * Seeded for **every** fixture rather than per test. The deadline is derived
 * from the schedule, so a league with no games is one in which the rule cannot
 * be evaluated at all — and it now refuses when it cannot be evaluated. Tests
 * about vetoes and freezes are not trying to say anything about that; they need
 * a league that is simply in season.
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

interface TwoLeagueFixture extends Fixture {
  otherLeagueId: string;
  otherTeams: string[];
}

/**
 * The same league, plus a second one holding players of its own.
 *
 * A trade is a closed swap inside one league, and nothing in a single-league
 * fixture can tell the difference between "scoped to the league being proposed
 * in" and "scoped to whatever league the proposer happens to be in" — those are
 * the same value until a second league exists.
 *
 * League B gets **new** player rows rather than reusing league A's. Reusing one
 * would make the test pass on `roster_entries_one_owner_per_league` instead of
 * on the fix, which is per-league and would fire for its own reasons.
 *
 * No second schedule: `games` are keyed by sport and season, so the one seeded
 * above already answers for both leagues.
 */
async function setupWithSecondLeague(): Promise<TwoLeagueFixture> {
  const fx = await setup();

  const other = await createUser(fx.client, "outside@example.com", "Outside");
  const otherLeague = await createLeague(fx.client, NFL, {
    name: "Somewhere Else",
    commissionerId: other.id,
    rules: buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules,
  });

  const otherTeams: string[] = [];
  for (let i = 0; i < 2; i++) {
    otherTeams.push((await addTestTeam(fx.client, otherLeague.id, `Other ${i + 1}`)).teamId);
  }

  const [sport] = await fx.client.query<{ id: string }>(
    "SELECT id FROM sports WHERE key = $1",
    [NFL.key],
  );
  const [position] = await fx.client.query<{ id: string }>(
    "SELECT id FROM positions WHERE sport_id = $1 AND key = 'RB'",
    [sport!.id],
  );

  for (const [index, teamId] of otherTeams.entries()) {
    const handle = `q${index + 1}`;
    const [player] = await fx.client.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $3, $4, 'CIN') RETURNING id`,
      [sport!.id, handle, handle, position!.id],
    );
    fx.players.set(handle, player!.id);

    await fx.client.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
       VALUES ($1, $2, 'DRAFT', $3)`,
      [teamId, player!.id, new Date(MONDAY.getTime() - 30 * DAY).toISOString()],
    );
  }

  return { ...fx, otherLeagueId: otherLeague.id, otherTeams };
}

/** Which team actively holds a player, anywhere. Null if nobody does. */
async function ownerOf(fx: Fixture, playerId: string): Promise<string | null> {
  const [row] = await fx.client.query<{ team_id: string }>(
    "SELECT team_id FROM roster_entries WHERE player_id = $1 AND released_at IS NULL",
    [playerId],
  );
  return row?.team_id ?? null;
}

/** The straightforward one-for-one: team 1's player for team 2's. */
async function propose(fx: Fixture, now = MONDAY): Promise<string> {
  const { tradeId } = await proposeTrade(fx.client, {
    leagueId: fx.leagueId,
    proposerTeamId: fx.teams[0]!,
    receiverTeamId: fx.teams[1]!,
    proposerGives: [fx.players.get("p1")!],
    receiverGives: [fx.players.get("p2")!],
    now,
  });
  return tradeId;
}

/**
 * `resolveDueTrades`, keeping only the resolutions.
 *
 * It returns `{resolutions, failures}` — failures being trades this run could
 * not settle, for which **nothing was written**. Tests that care about those
 * call `resolveDueTrades` directly; everything else wants the list it used to
 * return.
 */
const settle = async (...args: Parameters<typeof resolveDueTrades>) =>
  (await resolveDueTrades(...args)).resolutions;

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
        now: MONDAY,
      }),
    ).rejects.toMatchObject({ code: "NOT_YOUR_PLAYER" });
  });

  it("refuses one that would land after the deadline", async () => {
    // The proposal check bounds the *earliest* week a trade could execute in, so
    // it asks about `now` plus the veto window rather than about now. Proposed
    // during week 11's Sunday games, a 48-hour window closes on the Tuesday, by
    // which time the league is transacting in week 12.
    const fx = await setup();

    await expect(propose(fx, WEEK11_SUNDAY)).rejects.toMatchObject({
      code: "PAST_DEADLINE",
    });
  });

  it("allows one whose window still closes inside the deadline week", async () => {
    // Two days earlier the same 48 hours close on week 11's Sunday. Nothing
    // about the deadline week itself is refused — only landing past it.
    const fx = await setup();

    await expect(propose(fx, WEEK11_FRIDAY)).resolves.toBeTypeOf("string");
  });

  it("honours a commissioner-set deadline, across the DST change", async () => {
    // Deadline 8 rather than the default 11, which also moves the boundary to
    // the other side of 1 November. The week-8 lock is 04:00 UTC and the week-9
    // lock is 05:00 UTC, because both are Tuesday 00:00 *Eastern* — a fixed
    // offset would put one of these two assertions on the wrong side of it.
    const base = buildNflPprRules({ seasonYear: 2026, draft: DRAFT });
    const fx = await setup({ trades: { ...base.trades, deadlineWeek: 8 } });

    await expect(propose(fx, new Date("2026-11-01T12:00:00Z"))).rejects.toMatchObject({
      code: "PAST_DEADLINE",
    });
    await expect(propose(fx, new Date("2026-10-28T12:00:00Z"))).resolves.toBeTypeOf("string");
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
        now: MONDAY,
      }),
    ).rejects.toMatchObject({ code: "PLAYER_IN_ANOTHER_TRADE" });
  });

  it("releases the lock once the trade executes", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await settle(fx.client, fx.leagueId, new Date(MONDAY.getTime() + 49 * HOUR));

    expect(await lockedByTrade(fx.client, fx.leagueId)).toEqual(new Set());
  });

  /**
   * A player rostered by nobody, so he can be added or claimed.
   *
   * `active` matters: `availablePlayers` and the draft board both filter on it,
   * and a player who is not active cannot be claimed at all.
   */
  async function unrostered(fx: Fixture, handle: string): Promise<string> {
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    const [position] = await fx.client.query<{ id: string }>(
      "SELECT id FROM positions WHERE sport_id = $1 AND key = 'RB'",
      [sport!.id],
    );
    const [row] = await fx.client.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $2, $3, 'CIN') RETURNING id`,
      [sport!.id, handle, position!.id],
    );
    fx.players.set(handle, row!.id);
    return row!.id;
  }

  /**
   * An instant with no kickoff behind it, so `GAME_STARTED` stays silent.
   *
   * Every player in this fixture belongs to `CIN`, and at `MONDAY` week 5's
   * games have already started — which is fine for the trade machinery and
   * fatal for anything that has to *succeed* at dropping somebody. Week 6's
   * cycle opens Tuesday 04:00Z and its first game is the Thursday, so this sits
   * in the gap between them.
   *
   * Worth stating rather than quietly picking a magic number: `refuseIfKickedOff`
   * and the freeze both refuse a drop, and a test that cannot tell which one
   * refused proves nothing about the freeze.
   */
  // Wednesday 08:00 ET: after that week's processing run and before week 6's
  // Thursday kickoff. **Both halves are load-bearing.** Before the run, §6's
  // weekly lock puts every unrostered player on waivers, so an add is refused
  // with `NOT_A_FREE_AGENT` and never reaches the freeze check these tests are
  // about — which is exactly what the first version of this constant did.
  const QUIET = new Date("2026-10-14T12:00:00Z");

  const holds = async (fx: Fixture, teamId: string, playerId: string): Promise<boolean> => {
    const rows = await fx.client.query(
      "SELECT 1 FROM roster_entries WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL",
      [teamId, playerId],
    );
    return rows.length > 0;
  };

  it("refuses the add-with-drop that cuts a frozen player", async () => {
    // The hole, and it needed no concurrency: accept a trade, then cut the
    // player you promised through a different button. `dropPlayer` refused it
    // and this path did not, so the guard there was decorative.
    //
    // Worse than one lost player. `resolveTrade` throws `ASSET_GONE` and rolls
    // the whole swap back, so in a multi-asset trade dropping the *cheapest*
    // frozen player destroys the trade and returns everything else — a
    // unilateral cancel after acceptance, which `withdrawTrade` refuses on
    // purpose and which `RULES.md` §9 denies even the commissioner.
    const fx = await setupWithSecondLeague();
    const fa = await unrostered(fx, "fa");
    const p1 = fx.players.get("p1")!;

    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    await expect(
      addFreeAgent(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teams[0]!,
        addPlayerId: fa,
        dropPlayerId: p1,
        now: QUIET,
      }),
    ).rejects.toMatchObject({ code: "IN_A_TRADE" });

    // **The property, not the code.** An assertion on the error alone passes
    // against a check placed before the transaction — which would close this
    // hole and leave the racy read of part 3 exactly as it was.
    expect(await holds(fx, fx.teams[0]!, p1)).toBe(true);
    expect(await holds(fx, fx.teams[0]!, fa)).toBe(false);
  });

  it("fails a claim whose drop is frozen, and gives the player to the next priority", async () => {
    // **The half a per-player check at the write cannot do.**
    //
    // `resolveWaiverClaims` marks a player taken the moment a claim wins him and
    // fails every later claim with `PLAYER_TAKEN`. So refusing the winner's
    // award afterwards leaves the runner-up already rejected and the player
    // awarded to nobody — one manager's frozen drop silently denying him to the
    // whole league. Filtering before resolution lets the next priority win.
    const fx = await setupWithSecondLeague();
    const wire = await unrostered(fx, "wire");

    // Team 1 claims first, team 3 second — priority is the reverse of the draft
    // order, so seeding it descending makes team 1 the best.
    for (const [index, teamId] of fx.teams.entries()) {
      await fx.client.query("UPDATE teams SET draft_position = $1 WHERE id = $2", [
        fx.teams.length - index,
        teamId,
      ]);
    }
    await seedWaiverPriority(fx.client, fx.leagueId);

    // He has to be genuinely on the wire, or `submitClaim` sends the manager to
    // the add button instead.
    await fx.client.query(
      `INSERT INTO waiver_wire (league_id, player_id, clears_at) VALUES ($1, $2, $3)`,
      [fx.leagueId, wire, QUIET.toISOString()],
    );

    // The best priority claims him and offers `p1` — who is about to be frozen.
    await submitClaim(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teams[0]!,
      addPlayerId: wire,
      dropPlayerId: fx.players.get("p1")!,
      now: MONDAY,
    });
    await submitClaim(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teams[2]!,
      addPlayerId: wire,
      now: MONDAY,
    });

    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const outcome = await processWaivers(fx.client, fx.leagueId, QUIET);

    // The runner-up gets him. Under a check-at-the-write fix, nobody does.
    expect(await holds(fx, fx.teams[2]!, wire)).toBe(true);
    expect(outcome.awarded).toBe(1);
    expect(outcome.failed).toBe(1);
    expect(outcome.deferred).toBe(0);
  });

  it("still allows an ordinary drop while another player is frozen", async () => {
    // The negative that stops the fix being worse than the bug. A league with an
    // accepted trade in it must remain an ordinary league for everyone else.
    const fx = await setupWithSecondLeague();
    const spare = fx.players.get("spare")!;

    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    await expect(
      dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, spare, QUIET),
    ).resolves.toMatchObject({ destination: "WAIVERS" });
    expect(await holds(fx, fx.teams[0]!, spare)).toBe(false);
    expect(await holds(fx, fx.teams[0]!, fx.players.get("p1")!)).toBe(true);
  });

  it("lets the player go once the trade that froze him is vetoed", async () => {
    // The freeze is `state = 'ACCEPTED'` and nothing else, so it lifts by
    // itself. Widening it — to PROPOSED, say — would let any manager freeze an
    // opponent's roster for free, because a proposal needs no consent.
    const fx = await setupWithSecondLeague();
    const p1 = fx.players.get("p1")!;

    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[3]!, MONDAY);
    await settle(fx.client, fx.leagueId, AFTER_WINDOW);

    await expect(
      dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, p1, QUIET),
    ).resolves.toMatchObject({ destination: "WAIVERS" });
  });
});

describe("no double-spend across trades", () => {
  it("refuses a second accept that commits a player already in an accepted trade", async () => {
    // Two proposals can each offer the same player — only an *accepted* trade
    // freezes him. If the second accept is not re-checked, both trades execute
    // and the player is inserted onto two rosters, minted from nothing.
    const fx = await setup();
    const p1 = fx.players.get("p1")!;

    const a = await proposeTrade(fx.client, {
      leagueId: fx.leagueId,
      proposerTeamId: fx.teams[0]!,
      receiverTeamId: fx.teams[1]!,
      proposerGives: [p1],
      receiverGives: [fx.players.get("p2")!],
      now: MONDAY,
    });
    const b = await proposeTrade(fx.client, {
      leagueId: fx.leagueId,
      proposerTeamId: fx.teams[0]!,
      receiverTeamId: fx.teams[2]!,
      proposerGives: [p1],
      receiverGives: [fx.players.get("p3")!],
      now: MONDAY,
    });

    await acceptTrade(fx.client, a.tradeId, fx.teams[1]!, MONDAY);

    await expect(acceptTrade(fx.client, b.tradeId, fx.teams[2]!, MONDAY)).rejects.toMatchObject(
      {
        code: "PLAYER_IN_ANOTHER_TRADE",
      },
    );

    // The error code is not the property. **The property is that the player ends
    // up owned by exactly one team** — a test that stops at the throw passes
    // just as happily against a fix that closes this route and leaves another
    // open, which is what happened here.
    const trades = await listTrades(fx.client, fx.leagueId);
    expect(trades.find((t) => t.tradeId === b.tradeId)?.state).toBe("PROPOSED");

    await settle(fx.client, fx.leagueId, AFTER_WINDOW);

    const owners = await fx.client.query<{ team_id: string }>(
      "SELECT team_id FROM roster_entries WHERE player_id = $1 AND released_at IS NULL",
      [p1],
    );
    expect(owners).toHaveLength(1);
  });

  it("refuses to execute a trade whose asset left the roster after acceptance", async () => {
    // The last line of defence, and the only one that does not depend on knowing
    // *how* he left. Execution used to release from the old team — matching no
    // row — and then insert onto the new one unconditionally, so the player
    // existed twice. Every route to that outcome ends here.
    const fx = await setup();
    const p1 = fx.players.get("p1")!;

    const trade = await proposeTrade(fx.client, {
      leagueId: fx.leagueId,
      proposerTeamId: fx.teams[0]!,
      receiverTeamId: fx.teams[1]!,
      proposerGives: [p1],
      receiverGives: [fx.players.get("p2")!],
      now: MONDAY,
    });
    await acceptTrade(fx.client, trade.tradeId, fx.teams[1]!, MONDAY);

    // Straight to the table, standing in for any path that releases him without
    // consulting the freeze — a free-agent add's drop leg does exactly this.
    await fx.client.query(
      "UPDATE roster_entries SET released_at = now() WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL",
      [fx.teams[0]!, p1],
    );

    const [resolution] = await settle(fx.client, fx.leagueId, AFTER_WINDOW);

    // Recorded, not retried hourly for the rest of the season, and not executed.
    expect(resolution?.outcome).toBe("EXPIRED");

    const owners = await fx.client.query<{ team_id: string }>(
      "SELECT team_id FROM roster_entries WHERE player_id = $1 AND released_at IS NULL",
      [p1],
    );
    expect(owners).toHaveLength(0);

    // And the other side of the trade did not move either — all or nothing.
    const p2Owners = await fx.client.query<{ team_id: string }>(
      "SELECT team_id FROM roster_entries WHERE player_id = $1 AND released_at IS NULL",
      [fx.players.get("p2")!],
    );
    expect(p2Owners.map((row) => row.team_id)).toEqual([fx.teams[1]!]);
  });

  it("settles the other trades even when one cannot execute", async () => {
    // One trade that can never execute must not stop the rest from settling —
    // the same rule as every other loop in this repo.
    const fx = await setup();
    const p1 = fx.players.get("p1")!;
    const p3 = fx.players.get("p3")!;

    const broken = await proposeTrade(fx.client, {
      leagueId: fx.leagueId,
      proposerTeamId: fx.teams[0]!,
      receiverTeamId: fx.teams[1]!,
      proposerGives: [p1],
      receiverGives: [fx.players.get("p2")!],
      now: MONDAY,
    });
    const healthy = await proposeTrade(fx.client, {
      leagueId: fx.leagueId,
      proposerTeamId: fx.teams[2]!,
      receiverTeamId: fx.teams[3]!,
      proposerGives: [p3],
      receiverGives: [fx.players.get("p4")!],
      now: MONDAY,
    });

    await acceptTrade(fx.client, broken.tradeId, fx.teams[1]!, MONDAY);
    await acceptTrade(fx.client, healthy.tradeId, fx.teams[3]!, MONDAY);

    await fx.client.query(
      "UPDATE roster_entries SET released_at = now() WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL",
      [fx.teams[0]!, p1],
    );

    const resolutions = await settle(fx.client, fx.leagueId, AFTER_WINDOW);

    expect(resolutions.find((r) => r.tradeId === broken.tradeId)?.outcome).toBe("EXPIRED");
    expect(resolutions.find((r) => r.tradeId === healthy.tradeId)?.outcome).toBe("EXECUTED");
  });

  it("refuses to accept a trade whose offered player was dropped after it was proposed", async () => {
    const fx = await setup();
    const p1 = fx.players.get("p1")!;

    const { tradeId } = await proposeTrade(fx.client, {
      leagueId: fx.leagueId,
      proposerTeamId: fx.teams[0]!,
      receiverTeamId: fx.teams[1]!,
      proposerGives: [p1],
      receiverGives: [fx.players.get("p2")!],
      now: MONDAY,
    });

    await fx.client.query(
      `UPDATE roster_entries SET released_at = $3
        WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL`,
      [fx.teams[0], p1, MONDAY.toISOString()],
    );

    await expect(acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY)).rejects.toMatchObject({
      code: "NOT_YOUR_PLAYER",
    });
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

    // **The tally is the property, not the error code.** A refusal at the door
    // proves nothing about the count that actually decides the trade — that is
    // read separately, and it used to count every row regardless of league.
    const [trade] = await listTrades(fx.client, fx.leagueId);
    expect(trade?.vetoes).toBe(0);

    // And the trade the outsider tried to block still goes through.
    const [resolution] = await settle(fx.client, fx.leagueId, AFTER_WINDOW);
    expect(resolution?.outcome).toBe("EXECUTED");
  });

  it("cannot even record a veto row from outside the trade's league", async () => {
    // The guard in `vetoTrade` closes the door. This asserts the stronger thing:
    // after migration 0020 the row is *unrepresentable*, so a future path that
    // inserts one — or a hand-written statement — cannot reintroduce the bug.
    //
    // It matters because `trade_vetoes.team_id` is ON DELETE RESTRICT, so a bad
    // row could not be cleaned up by deleting the team afterwards.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const other = await createUser(fx.client, "outside@example.com", "Outside");
    const otherLeague = await createLeague(fx.client, NFL, {
      name: "Somewhere Else",
      commissionerId: other.id,
      rules: buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules,
    });
    const outsider = (await addTestTeam(fx.client, otherLeague.id, "Outsider")).teamId;

    // Claiming the trade's league does not help: the voter is not in it.
    await expect(
      fx.client.query(
        `INSERT INTO trade_vetoes (trade_id, team_id, league_id, created_at)
         VALUES ($1, $2, $3, $4)`,
        [tradeId, outsider, fx.leagueId, MONDAY.toISOString()],
      ),
    ).rejects.toThrow(/trade_vetoes_voter_in_league/);

    // Nor does claiming their own: the trade is not in it.
    await expect(
      fx.client.query(
        `INSERT INTO trade_vetoes (trade_id, team_id, league_id, created_at)
         VALUES ($1, $2, $3, $4)`,
        [tradeId, outsider, otherLeague.id, MONDAY.toISOString()],
      ),
    ).rejects.toThrow(/trade_vetoes_trade_in_league/);
  });

  it("refuses a proposal naming a team in another league", async () => {
    // Two closed player pools. A manager holding a team in each could propose in
    // one naming the other, accept from the far side, and let the cron execute
    // it — importing a player the receiving league's waiver queue never got to
    // allocate, and exporting one who never reaches its wire at all, because
    // `resolveTrade` releases with a direct UPDATE rather than through
    // `dropPlayer`.
    //
    // The same defect `vetoTrade` was fixed for, twenty lines away in the same
    // file, left standing on propose and accept.
    const fx = await setupWithSecondLeague();

    await expect(
      proposeTrade(fx.client, {
        leagueId: fx.leagueId,
        proposerTeamId: fx.teams[0]!,
        receiverTeamId: fx.otherTeams[0]!,
        proposerGives: [fx.players.get("p1")!],
        receiverGives: [fx.players.get("q1")!],
        now: MONDAY,
      }),
    ).rejects.toMatchObject({ code: "NOT_IN_LEAGUE" });

    // **The property, not the code.** A refusal at the door proves nothing about
    // where the players ended up, which is what actually matters — and a fix
    // that closed propose while leaving the resolution path open would satisfy
    // the assertion above.
    expect(await listTrades(fx.client, fx.leagueId)).toHaveLength(0);
    expect(await listTrades(fx.client, fx.otherLeagueId)).toHaveLength(0);

    expect(await ownerOf(fx, fx.players.get("q1")!)).toBe(fx.otherTeams[0]);
    expect(await ownerOf(fx, fx.players.get("p1")!)).toBe(fx.teams[0]);
  });

  it("says the team is not in this league rather than that it is a bot", async () => {
    // Ordering. The bot check queries teams by id with no league predicate, so
    // it answers correctly across leagues — which is the problem: reached first,
    // it turns a refusal into an oracle. `BOT_CANNOT_TRADE` confirms the id
    // names a real team, and that it is a bot, for an id the caller was never
    // entitled to resolve. `NOT_IN_LEAGUE` reveals nothing.
    //
    // The mirror of this test is "refuses a trade involving a bot" above: a bot
    // in *this* league must still say so. Either alone leaves the order free.
    const fx = await setupWithSecondLeague();
    await fx.client.query("UPDATE teams SET owner_id = NULL, is_bot = true WHERE id = $1", [
      fx.otherTeams[0],
    ]);

    await expect(
      proposeTrade(fx.client, {
        leagueId: fx.leagueId,
        proposerTeamId: fx.teams[0]!,
        receiverTeamId: fx.otherTeams[0]!,
        proposerGives: [fx.players.get("p1")!],
        receiverGives: [fx.players.get("q1")!],
        now: MONDAY,
      }),
    ).rejects.toMatchObject({ code: "NOT_IN_LEAGUE" });
  });

  it("cannot even record a trade whose teams are not in its league", async () => {
    // The guards in `proposeTrade` and `acceptTrade` close the doors. This
    // asserts the stronger thing, as `0020` did for vetoes: after `0026` the row
    // is unrepresentable, so a future caller — or a hand-written statement —
    // cannot reintroduce it.
    //
    // It is also why there is no test here for `acceptTrade` refusing a
    // cross-league trade: that state can no longer be constructed to accept.
    // A test that cannot build its own precondition would pass against the fix,
    // against the bug, and against no guard at all.
    const fx = await setupWithSecondLeague();

    await expect(
      fx.client.query(
        `INSERT INTO trades (league_id, proposer_team_id, receiver_team_id, state, proposed_at)
         VALUES ($1, $2, $3, 'PROPOSED', $4)`,
        [fx.leagueId, fx.teams[0], fx.otherTeams[0], MONDAY.toISOString()],
      ),
    ).rejects.toThrow(/trades_receiver_in_league/);

    await expect(
      fx.client.query(
        `INSERT INTO trades (league_id, proposer_team_id, receiver_team_id, state, proposed_at)
         VALUES ($1, $2, $3, 'PROPOSED', $4)`,
        [fx.otherLeagueId, fx.teams[0], fx.otherTeams[0], MONDAY.toISOString()],
      ),
    ).rejects.toThrow(/trades_proposer_in_league/);
  });

  it("still executes an ordinary trade with another league present", async () => {
    // The negative. Every other trade test runs in one league, so this is the
    // only one that would catch a league predicate scoped against the wrong
    // value — though not one scoped to the proposer's league rather than the
    // league being proposed in, since here those are the same. That mutation is
    // caught by "refuses a proposal naming a team in another league" and by
    // nothing else.
    const fx = await setupWithSecondLeague();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    const [resolution] = await settle(fx.client, fx.leagueId, AFTER_WINDOW);
    expect(resolution?.outcome).toBe("EXECUTED");

    expect(await ownerOf(fx, fx.players.get("p1")!)).toBe(fx.teams[1]);
    expect(await ownerOf(fx, fx.players.get("q1")!)).toBe(fx.otherTeams[0]);
  });

  it("does not count a veto from a bot or from a team in the trade", async () => {
    // The constraint scopes by league; it cannot express "not a bot" or "not a
    // party to this trade", so the tally still has to. Two rows, because two is
    // the threshold here — if they counted, this trade would be vetoed.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    // A bot in this league, and the proposer themselves.
    const [bot] = await fx.client.query<{ id: string }>(
      `INSERT INTO teams (league_id, owner_id, is_bot, name, slot)
       VALUES ($1, NULL, true, 'Bot', 99) RETURNING id`,
      [fx.leagueId],
    );
    for (const teamId of [bot!.id, fx.teams[0]!]) {
      await fx.client.query(
        `INSERT INTO trade_vetoes (trade_id, team_id, league_id, created_at)
         VALUES ($1, $2, $3, $4)`,
        [tradeId, teamId, fx.leagueId, MONDAY.toISOString()],
      );
    }

    const [trade] = await listTrades(fx.client, fx.leagueId);
    expect(trade?.vetoes).toBe(0);

    const [resolution] = await settle(fx.client, fx.leagueId, AFTER_WINDOW);
    expect(resolution?.outcome).toBe("EXECUTED");
  });

  it("still counts a veto from inside the league", async () => {
    // The scoping must not become a way to lose real votes. Two uninvolved
    // managers is the threshold here, so this is the mirror of the test above.
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);

    await vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[3]!, MONDAY);

    const [trade] = await listTrades(fx.client, fx.leagueId);
    expect(trade?.vetoes).toBe(2);

    const [resolution] = await settle(fx.client, fx.leagueId, AFTER_WINDOW);
    expect(resolution?.outcome).toBe("VETOED");
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

    const [resolution] = await settle(
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

    const resolved = await settle(
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

    const [resolution] = await settle(
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
    await settle(fx.client, fx.leagueId, AFTER);

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
    await settle(fx.client, fx.leagueId, AFTER);

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
    await settle(fx.client, fx.leagueId, AFTER);

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

    const [resolution] = await settle(fx.client, fx.leagueId, AFTER);

    expect(resolution?.outcome).toBe("VETOED");
    expect(resolution?.vetoes).toBe(2);
    expect(resolution?.required).toBe(2);
  });

  it("executes a trade one vote short", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY);

    const [resolution] = await settle(fx.client, fx.leagueId, AFTER);

    expect(resolution?.outcome).toBe("EXECUTED");
  });

  it("leaves rosters untouched when a trade is vetoed", async () => {
    const fx = await setup();
    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[2]!, MONDAY);
    await vetoTrade(fx.client, tradeId, fx.teams[3]!, MONDAY);
    await settle(fx.client, fx.leagueId, AFTER);

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
    await settle(fx.client, fx.leagueId, AFTER);

    const again = await settle(fx.client, fx.leagueId, new Date(AFTER.getTime() + HOUR));

    expect(again).toEqual([]);
    const owners = await fx.client.query<{ team_id: string }>(
      "SELECT team_id FROM roster_entries WHERE player_id = $1 AND released_at IS NULL",
      [fx.players.get("p1")],
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]?.team_id).toBe(fx.teams[1]);
  });

  it("expires a trade whose window closes in the gap after the deadline week", async () => {
    // **The bug this fixture exists for.** Week 11's games are all played, week
    // 12's have not started, and the league has been transacting in week 12
    // since Tuesday 00:00 ET. `currentWeek` still answers 11 here, because it
    // names the most recent kickoff — so the deadline used to read as unpassed,
    // and the swap landed in week 12's rosters days past a date members signed.
    const fx = await setup();
    const tradeId = await propose(fx, WEEK11_FRIDAY);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, WEEK11_FRIDAY);

    const [resolution] = await settle(fx.client, fx.leagueId, AFTER_WEEK12_LOCK);

    expect(resolution?.outcome).toBe("EXPIRED");

    const [row] = await fx.client.query<{ team_id: string }>(
      "SELECT team_id FROM roster_entries WHERE player_id = $1 AND released_at IS NULL",
      [fx.players.get("p1")],
    );
    expect(row?.team_id).toBe(fx.teams[0]);
  });

  it("executes one whose window closes before that week turns over", async () => {
    // Two hours earlier and the answer flips. The rule turns on the Tuesday lock
    // rather than on week 12's Thursday kickoff, so this pins where the boundary
    // is and not merely that one exists.
    const fx = await setup();
    const tradeId = await propose(fx, WEEK11_FRIDAY);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, WEEK11_FRIDAY);

    const [resolution] = await settle(fx.client, fx.leagueId, BEFORE_WEEK12_LOCK);

    expect(resolution?.outcome).toBe("EXECUTED");
  });

  it("expires rather than executing once the season's games are exhausted", async () => {
    // The regression the obvious version of this fix introduces, and the reason
    // a null execution week refuses. After the season's last Tuesday lock the
    // schedule cannot name a week at all, and the shape this replaced —
    // `week !== null && week > deadlineWeek` — read that as "not past the
    // deadline". A trade left accepted would then execute in January, which is
    // the exact free-for-all the deadline exists to prevent. A rule that cannot
    // be checked is not a rule that has lapsed.
    const fx = await setup();
    const tradeId = await propose(fx, WEEK11_FRIDAY);
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, WEEK11_FRIDAY);

    const [resolution] = await settle(fx.client, fx.leagueId, new Date("2027-01-20T12:00:00Z"));

    expect(resolution?.outcome).toBe("EXPIRED");
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
      now: MONDAY,
    });
    await acceptTrade(fx.client, tradeId, fx.teams[1]!, MONDAY);
    await settle(fx.client, fx.leagueId, AFTER);

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
      now: MONDAY,
    });
    await declineTrade(fx.client, gone, fx.teams[3]!, MONDAY);

    const proposed = await listTrades(fx.client, fx.leagueId, ["PROPOSED"]);

    expect(proposed.map((trade) => trade.tradeId)).toEqual([open]);
  });
});

describe("a veto cast while the trade is being resolved — #134", () => {
  /*
    `vetoTrade` read the trade's state through `loadTrade` — no lock, nothing
    binding that read to the insert — and then wrote the vote. So a member voting
    in the same hour `/api/cron/trades` resolved the trade had their vote written
    against a trade already decided: `resolveTrade` took its tally before the row
    landed, so the vote did not count, the row existed, and the screen showed the
    veto recorded.

    That is worse than refusing them. A member told their vote was late can go and
    persuade somebody else; a member whose vote is silently dropped believes the
    league declined to block a trade it may in fact have blocked.

    #133 guards every trade *state* write, and this is not one — a veto is a row
    in a different table, and the tally is a count taken earlier in the same run,
    so that guard cannot see it. It was deliberately left out of that PR rather
    than folded into one whose title would have implied coverage.
  */

  /**
   * Settles the trade at the instant the vote is about to be written.
   *
   * The state check at the top of vetoTrade passes — the trade really is
   * ACCEPTED when the voter looks — and the resolution lands before the insert.
   * That is the race, and it cannot be staged any other way on single-connection
   * PGlite: the two writers cannot genuinely overlap, but the ordering that
   * matters can be produced exactly.
   */
  function settlingBeforeTheVote(fx: Fixture): PGliteClient {
    let fired = false;
    return new Proxy(fx.client, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return async (sql: string, params?: unknown[]) => {
          const run = (
            target as unknown as {
              query: (s: string, p?: unknown[]) => Promise<unknown>;
            }
          ).query.bind(target);
          if (!fired && sql.includes("INSERT INTO trade_vetoes")) {
            fired = true;
            await settle(fx.client, fx.leagueId, AFTER_WINDOW);
          }
          return run(sql, params);
        };
      },
    }) as PGliteClient;
  }

  it("refuses a vote once the trade has been settled", async () => {
    const fx = await setupWithSecondLeague();

    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1], MONDAY);

    await expect(
      vetoTrade(settlingBeforeTheVote(fx), tradeId, fx.teams[2], MONDAY),
    ).rejects.toSatisfy((e) => e instanceof TradeError && e.code === "TRADE_ALREADY_SETTLED");
  });

  it("writes no vote row when it refuses", async () => {
    /*
      The half that matters. Refusing loudly is only an improvement if the row is
      genuinely absent — a vote recorded but uncounted is the original defect
      wearing an error message.
    */
    const fx = await setupWithSecondLeague();

    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1], MONDAY);
    await expect(
      vetoTrade(settlingBeforeTheVote(fx), tradeId, fx.teams[2], MONDAY),
    ).rejects.toThrow();

    const rows = await fx.client.query("SELECT team_id FROM trade_vetoes WHERE trade_id = $1", [
      tradeId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("still accepts a vote while the trade is genuinely open", async () => {
    // The control. Without it the refusal above passes just as well against a
    // rule that rejected every veto.
    const fx = await setupWithSecondLeague();

    const tradeId = await propose(fx);
    await acceptTrade(fx.client, tradeId, fx.teams[1], MONDAY);

    await expect(vetoTrade(fx.client, tradeId, fx.teams[2], MONDAY)).resolves.toBeDefined();

    const rows = await fx.client.query("SELECT team_id FROM trade_vetoes WHERE trade_id = $1", [
      tradeId,
    ]);
    expect(rows).toHaveLength(1);
  });
});
