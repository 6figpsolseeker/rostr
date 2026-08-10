import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { advancePlayoffs, championship, enterPlayoffs, playoffState } from "./playoffs.js";
import { loadWeekResults } from "./week.js";

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

const FINAL = new Date("2026-12-15T12:00:00Z");

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  rules: LeagueRules;
  /** The league's teams in join order. Seeds are decided by the fixture's results. */
  teams: string[];
}

/**
 * `teamCount` teams (eight by default) and a one-week "regular season" that
 * produces a known order.
 *
 * The season is short on purpose. `advancePlayoffs` cares that every regular
 * game is final, not that fourteen weeks were played, so one round of results is
 * a complete season as far as seeding is concerned — and it keeps the seed order
 * legible: winners on points descending, then losers on points descending.
 *
 * At the default eight, seeds end up 1..8 as `t0, t2, t4, t6, t1, t3, t5, t7`;
 * six make the playoffs and the last two are the consolation bracket. Smaller
 * counts exist to exercise a field smaller than `playoffTeams`, where the
 * frozen bye count no longer fits.
 */
async function setup(overrides?: Partial<LeagueRules>, teamCount = 8): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = {
    ...buildNflPprRules({ seasonYear: 2026, draft: DRAFT }),
    ...overrides,
  } as LeagueRules;
  const league = await createLeague(db, NFL, {
    name: "Bracket League",
    commissionerId: commissioner.id,
    rules,
  });

  const teams: string[] = [];
  for (let i = 0; i < teamCount; i++) {
    teams.push((await addTestTeam(db, league.id, `Team ${i + 1}`)).teamId);
  }

  // Distinct, descending totals so the seed order is deterministic. The 8-team
  // values are kept verbatim because the seeding tests assert against them.
  const points =
    teamCount === 8
      ? [200_000, 100_000, 190_000, 90_000, 180_000, 80_000, 170_000, 70_000]
      : teams.map((_, i) => 200_000 - i * 5_000);
  for (let i = 0; i + 1 < teamCount; i += 2) {
    await db.query(
      `INSERT INTO matchups
         (league_id, week, phase, home_team_id, away_team_id,
          home_milli_points, away_milli_points, finalized_at)
       VALUES ($1, 1, 'REGULAR', $2, $3, $4, $5, $6)`,
      [league.id, teams[i], teams[i + 1], points[i], points[i + 1], FINAL.toISOString()],
    );
  }

  await db.query("UPDATE leagues SET state = 'IN_SEASON' WHERE id = $1", [league.id]);

  return { client: db, leagueId: league.id, rules, teams };
}

/** Score a bracket game that has already been laid, and finalise it. */
async function score(
  fx: Fixture,
  week: number,
  homeTeamId: string,
  homePoints: number,
  awayPoints: number,
): Promise<void> {
  await fx.client.query(
    `UPDATE matchups
        SET home_milli_points = $3, away_milli_points = $4, finalized_at = $5
      WHERE league_id = $1 AND week = $2 AND home_team_id = $6 AND phase <> 'REGULAR'`,
    [fx.leagueId, week, homePoints, awayPoints, FINAL.toISOString(), homeTeamId],
  );
}

async function fixtures(fx: Fixture, week: number) {
  return fx.client.query<{ home_team_id: string; away_team_id: string; phase: string }>(
    `SELECT home_team_id, away_team_id, phase FROM matchups
      WHERE league_id = $1 AND week = $2 AND phase <> 'REGULAR'`,
    [fx.leagueId, week],
  );
}

/**
 * A week's fixtures as home -> away.
 *
 * A Map rather than an array because row order is not meaningful: the primary
 * key is a random uuid, so two runs return the same games in different orders. A
 * home team appears at most once in a week, which makes the map total.
 */
async function pairings(
  fx: Fixture,
  week: number,
  phase: string,
): Promise<Map<string, string>> {
  const rows = await fixtures(fx, week);
  return new Map(
    rows
      .filter((row) => row.phase === phase)
      .map((row) => [row.home_team_id, row.away_team_id]),
  );
}

describe("seeding", () => {
  it("orders the field by the regular season", async () => {
    const fx = await setup();
    const state = await playoffState(fx.client, fx.leagueId);

    expect(state.playoffs?.field).toEqual([
      fx.teams[0],
      fx.teams[2],
      fx.teams[4],
      fx.teams[6],
      fx.teams[1],
      fx.teams[3],
    ]);
  });

  it("puts everyone else in the consolation bracket", async () => {
    const fx = await setup();
    const state = await playoffState(fx.client, fx.leagueId);

    expect(state.consolation?.field).toEqual([fx.teams[5], fx.teams[7]]);
  });

  it("names the best regular-season record, which is a prize of its own", async () => {
    const fx = await setup();
    const state = await playoffState(fx.client, fx.leagueId);

    expect(state.regularSeasonWinner).toBe(fx.teams[0]);
  });

  it("skips the consolation bracket when the league has none", async () => {
    const base = buildNflPprRules({ seasonYear: 2026, draft: DRAFT });
    const fx = await setup({
      schedule: { ...base.schedule, consolationBracket: false },
      // The payout cannot keep a consolation share with no bracket to win it.
      pot: null,
    });

    expect((await playoffState(fx.client, fx.leagueId)).consolation).toBeNull();
  });
});

describe("laying the first round", () => {
  it("writes 3v6 and 4v5, with the top two seeds on a bye", async () => {
    const fx = await setup();
    await advancePlayoffs(fx.client, fx.leagueId);

    expect(await pairings(fx, 15, "PLAYOFF")).toEqual(
      new Map([
        [fx.teams[4]!, fx.teams[3]!],
        [fx.teams[6]!, fx.teams[1]!],
      ]),
    );
  });

  it("gives a bye team no fixture at all", async () => {
    // A bye is not a game. A row for it would put a lineup requirement on a team
    // that is not playing, and `ensureLineups` would fill one.
    const fx = await setup();
    await advancePlayoffs(fx.client, fx.leagueId);

    const week15 = await fixtures(fx, 15);
    const playing = week15.flatMap((row) => [row.home_team_id, row.away_team_id]);

    expect(playing).not.toContain(fx.teams[0]);
    expect(playing).not.toContain(fx.teams[2]);
  });

  it("puts a two-team consolation bracket in the last week, not the first", async () => {
    // Two teams need one round. Playing it in week 15 would leave them nothing
    // to do for two weeks and settle the prize before the week that pays it.
    const fx = await setup();
    await advancePlayoffs(fx.client, fx.leagueId);

    expect(await fixtures(fx, 15)).toHaveLength(2);
    expect(await pairings(fx, 17, "CONSOLATION")).toEqual(
      new Map([[fx.teams[5]!, fx.teams[7]!]]),
    );
  });

  it("refuses while a regular-season game is unfinished", async () => {
    // Seeding off a partial season produces a bracket that changes under the
    // teams in it.
    const fx = await setup();
    await fx.client.query(
      `INSERT INTO matchups (league_id, week, phase, home_team_id, away_team_id)
       VALUES ($1, 2, 'REGULAR', $2, $3)`,
      [fx.leagueId, fx.teams[0], fx.teams[1]],
    );

    await expect(advancePlayoffs(fx.client, fx.leagueId)).rejects.toMatchObject({
      code: "REGULAR_SEASON_UNFINISHED",
    });
  });

  it("is idempotent", async () => {
    const fx = await setup();
    const first = await advancePlayoffs(fx.client, fx.leagueId);
    const second = await advancePlayoffs(fx.client, fx.leagueId);

    expect(first.written).toBe(3);
    expect(second.written).toBe(0);
    expect(await fixtures(fx, 15)).toHaveLength(2);
  });
});

describe("small leagues (fewer teams than the playoff field)", () => {
  /** The first round the bracket actually plays, with its byes and pairings. */
  const firstRound = async (fx: Fixture) => {
    const state = await playoffState(fx.client, fx.leagueId);
    const round = state.playoffs?.bracket.rounds[0];
    if (!round) throw new Error("no first round");
    return round;
  };

  it("seats a five-team field on three byes rather than throwing", async () => {
    // A pot league gets no bots, so five friends is a five-team league. The
    // frozen bye count is 2, sized for a six-team field; applied to five it
    // leaves three to pair — odd — and the bracket threw, which the shared
    // scoring cron rethrew, taking every other league's scoring down with it.
    const fx = await setup(undefined, 5);

    await expect(advancePlayoffs(fx.client, fx.leagueId)).resolves.toBeDefined();

    // Asserting the shape, not merely that it resolved. `resolves.toBeDefined()`
    // passes on any bracket at all, including a wrongly seeded one.
    const round = await firstRound(fx);
    expect(round.byes).toHaveLength(3);
    expect(round.games).toHaveLength(1);
    expect(round.entrants).toHaveLength(5);
    // Byes go to the best seeds, so the single game is the two worst. With five
    // teams the fixture seeds t0, t2, t1, t3, t4 — two winners on points, then
    // the rest on points — so seeds 4 and 5 are t3 and t4.
    expect(round.byes.map((b) => b.seed)).toEqual([1, 2, 3]);
    expect([round.games[0]?.homeTeamId, round.games[0]?.awayTeamId].sort()).toEqual(
      [fx.teams[3], fx.teams[4]].sort(),
    );
  });

  it("seats a four-team field, which never threw and was silently mis-seeded", async () => {
    // The quiet half of this bug, and the reason it is not only about crashes.
    // Two byes and one game is a *legal* round, so four teams produced no error
    // — it just played a bracket nobody agreed to: seeds 1 and 2 both idle in
    // week 15, three alive in week 16, so seed 1 byes twice and plays a single
    // game all postseason. With byes sized to the real field, all four play.
    const fx = await setup(undefined, 4);

    await advancePlayoffs(fx.client, fx.leagueId);

    const round = await firstRound(fx);
    expect(round.byes).toHaveLength(0);
    expect(round.games).toHaveLength(2);
  });

  it("seats a three-team field", async () => {
    const fx = await setup(undefined, 3);

    await expect(advancePlayoffs(fx.client, fx.leagueId)).resolves.toBeDefined();

    const round = await firstRound(fx);
    expect(round.byes).toHaveLength(1);
    expect(round.games).toHaveLength(1);
  });

  it("gives a two-team league a bracket with no byes", async () => {
    const fx = await setup(undefined, 2);

    await expect(advancePlayoffs(fx.client, fx.leagueId)).resolves.toBeDefined();

    const round = await firstRound(fx);
    expect(round.byes).toHaveLength(0);
    expect(round.games).toHaveLength(1);
  });

  it("still honours the signed bye count when the field is the size it was frozen for", async () => {
    // The derived count must not quietly replace the signed one everywhere —
    // `byeSeeds` is a number members agreed to, and it wins wherever it applies.
    // `byesFor(6)` is 2 as well, so this asserts the branch, not the arithmetic:
    // an eight-team league fills all six playoff seats.
    const fx = await setup(undefined, 8);

    await advancePlayoffs(fx.client, fx.leagueId);

    const round = await firstRound(fx);
    expect(round.entrants).toHaveLength(6);
    expect(round.byes.map((b) => b.seed)).toEqual([1, 2]);
  });
});

describe("advancing round by round", () => {
  it("writes nothing for the next week until this one is scored", async () => {
    const fx = await setup();
    await advancePlayoffs(fx.client, fx.leagueId);

    await advancePlayoffs(fx.client, fx.leagueId);
    expect(await fixtures(fx, 16)).toHaveLength(0);
  });

  it("lays the semifinals once the quarterfinals are in", async () => {
    const fx = await setup();
    await advancePlayoffs(fx.client, fx.leagueId);

    // Seed 3 (t4) beats seed 6 (t3); seed 5 (t1) beats seed 4 (t6).
    await score(fx, 15, fx.teams[4]!, 120_000, 100_000);
    await score(fx, 15, fx.teams[6]!, 90_000, 130_000);

    const outcome = await advancePlayoffs(fx.client, fx.leagueId);

    expect(outcome.written).toBe(2);
    expect(await pairings(fx, 16, "PLAYOFF")).toEqual(
      new Map([
        // Top seed takes the lower survivor: seed 5, not seed 3.
        [fx.teams[0]!, fx.teams[1]!],
        [fx.teams[2]!, fx.teams[4]!],
      ]),
    );
  });

  it("lays the final and the third-place game together", async () => {
    const fx = await setup();
    await advancePlayoffs(fx.client, fx.leagueId);
    await score(fx, 15, fx.teams[4]!, 120_000, 100_000);
    await score(fx, 15, fx.teams[6]!, 90_000, 130_000);
    await advancePlayoffs(fx.client, fx.leagueId);

    // Seed 1 (t0) beats seed 5 (t1); seed 4... seed 3 (t4) beats seed 2 (t2).
    await score(fx, 16, fx.teams[0]!, 130_000, 100_000);
    await score(fx, 16, fx.teams[2]!, 100_000, 130_000);

    await advancePlayoffs(fx.client, fx.leagueId);

    expect(await pairings(fx, 17, "PLAYOFF")).toEqual(
      new Map([
        // The final, and the third-place game between the beaten semifinalists.
        [fx.teams[0]!, fx.teams[4]!],
        [fx.teams[2]!, fx.teams[1]!],
      ]),
    );
  });

  it("names a champion off the scores, with nothing declaring one", async () => {
    const fx = await setup();
    await advancePlayoffs(fx.client, fx.leagueId);
    await score(fx, 15, fx.teams[4]!, 120_000, 100_000);
    await score(fx, 15, fx.teams[6]!, 90_000, 130_000);
    await advancePlayoffs(fx.client, fx.leagueId);
    await score(fx, 16, fx.teams[0]!, 130_000, 100_000);
    await score(fx, 16, fx.teams[2]!, 100_000, 130_000);
    await advancePlayoffs(fx.client, fx.leagueId);

    await score(fx, 17, fx.teams[0]!, 140_000, 120_000); // final
    await score(fx, 17, fx.teams[2]!, 90_000, 110_000); // third place
    await score(fx, 17, fx.teams[5]!, 100_000, 90_000); // consolation final

    const result = await championship(fx.client, fx.leagueId);

    expect(result.champion).toBe(fx.teams[0]);
    expect(result.runnerUp).toBe(fx.teams[4]);
    expect(result.thirdPlace).toBe(fx.teams[1]);
    expect(result.regularSeason).toBe(fx.teams[0]);
    expect(result.consolation).toBe(fx.teams[5]);
    expect(result.complete).toBe(true);
  });

  it("is incomplete while any prize is undecided", async () => {
    const fx = await setup();
    await advancePlayoffs(fx.client, fx.leagueId);

    const result = await championship(fx.client, fx.leagueId);
    expect(result.champion).toBeNull();
    expect(result.complete).toBe(false);
  });
});

describe("bracket games and the standings", () => {
  it("keeps playoff results out of the regular-season records", async () => {
    // Seeds are a regular-season fact. A bracket game counting toward a record
    // would move the seeds the bracket was built from — the standings would
    // chase the results they produced.
    const fx = await setup();
    await advancePlayoffs(fx.client, fx.leagueId);
    await score(fx, 15, fx.teams[4]!, 120_000, 100_000);
    await score(fx, 15, fx.teams[6]!, 90_000, 130_000);

    const regular = await loadWeekResults(fx.client, fx.leagueId, 17);

    expect(regular).toHaveLength(4);
    expect(regular.every((row) => row.week === 1)).toBe(true);
  });

  it("keeps the field fixed once the playoffs have started", async () => {
    const fx = await setup();
    await advancePlayoffs(fx.client, fx.leagueId);
    await score(fx, 15, fx.teams[4]!, 120_000, 100_000);
    await score(fx, 15, fx.teams[6]!, 90_000, 130_000);

    const state = await playoffState(fx.client, fx.leagueId);
    expect(state.playoffs?.field[0]).toBe(fx.teams[0]);
    expect(state.playoffs?.field).toHaveLength(6);
  });
});

describe("league state", () => {
  it("moves a finished regular season into PLAYOFFS", async () => {
    const fx = await setup();

    expect(await enterPlayoffs(fx.client, fx.leagueId)).toBe(true);

    const [league] = await fx.client.query<{ state: string }>(
      "SELECT state FROM leagues WHERE id = $1",
      [fx.leagueId],
    );
    expect(league?.state).toBe("PLAYOFFS");
  });

  it("leaves a league with games still to play alone", async () => {
    const fx = await setup();
    await fx.client.query(
      `INSERT INTO matchups (league_id, week, phase, home_team_id, away_team_id)
       VALUES ($1, 2, 'REGULAR', $2, $3)`,
      [fx.leagueId, fx.teams[0], fx.teams[1]],
    );

    expect(await enterPlayoffs(fx.client, fx.leagueId)).toBe(false);
  });

  it("does not move a league twice", async () => {
    const fx = await setup();
    await enterPlayoffs(fx.client, fx.leagueId);

    expect(await enterPlayoffs(fx.client, fx.leagueId)).toBe(false);
  });
});
