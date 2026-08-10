import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, computeStandings, generateSchedule, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules, MatchupResult } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { setLineup } from "./lineups.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import {
  finalizationHours,
  loadScheduledWeek,
  loadWeekResults,
  persistSchedule,
  resolveLeagueWeek,
  resolveLeagueWeeksThrough,
} from "./week.js";

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

const SEASON = 2026;
const WEEK = 1;

const KICKOFF = new Date("2026-09-13T17:00:00Z");
const DURING = new Date(KICKOFF.getTime() + 2 * 3600 * 1000);
/** Past the 48-hour standard window. */
const AFTER_STANDARD = new Date(KICKOFF.getTime() + 49 * 3600 * 1000);
/** Past the 168-hour paying window. */
const AFTER_PAYING = new Date(KICKOFF.getTime() + 169 * 3600 * 1000);

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  rules: LeagueRules;
  teamIds: string[];
  players: Map<string, string>;
  statKeys: Map<string, string>;
}

async function setup(teamCount = 4): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = buildNflPprRules({ seasonYear: SEASON, draft: DRAFT }) as LeagueRules;
  const league = await createLeague(db, NFL, {
    name: "Week League",
    commissionerId: commissioner.id,
    rules,
  });

  const teamIds: string[] = [];
  for (let i = 0; i < teamCount; i++) {
    teamIds.push((await addTestTeam(db, league.id, `Bot ${i + 1}`)).teamId);
  }

  const [sport] = await db.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    NFL.key,
  ]);
  const positions = new Map(
    (
      await db.query<{ id: string; key: string }>(
        "SELECT id, key FROM positions WHERE sport_id = $1",
        [sport!.id],
      )
    ).map((row) => [row.key, row.id]),
  );
  const statKeys = new Map(
    (
      await db.query<{ id: string; key: string }>(
        "SELECT id, key FROM stat_keys WHERE sport_id = $1",
        [sport!.id],
      )
    ).map((row) => [row.key, row.id]),
  );

  await db.query(
    `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at, status)
     VALUES ($1, 'g1', $2, $3, 'CIN', 'BAL', $4, 'SCHEDULED')`,
    [sport!.id, SEASON, WEEK, KICKOFF],
  );

  // One quarterback each, so every team has something to score.
  const players = new Map<string, string>();
  for (const [index, teamId] of teamIds.entries()) {
    const handle = `qb-${index}`;
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $3, $4, 'CIN') RETURNING id`,
      [sport!.id, handle, handle, positions.get("QB")!],
    );
    players.set(handle, row!.id);

    await db.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via) VALUES ($1, $2, 'DRAFT')`,
      [teamId, row!.id],
    );

    await setLineup(db, {
      leagueId: league.id,
      teamId,
      week: WEEK,
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: row!.id }],
      now: Math.floor(KICKOFF.getTime() / 1000) - 3600,
    });
  }

  return { client: db, leagueId: league.id, rules, teamIds, players, statKeys };
}

/**
 * Give a player passing yards for the week.
 *
 * A later value is a new **revision**, not a second row — the table is
 * append-only and the unique constraint enforces it, because a settled week has
 * to stay auditable against exactly the data it settled on. `stat_lines_current`
 * reads the highest revision.
 */
async function score(
  fx: Fixture,
  handle: string,
  passYards: number,
  revision = 0,
): Promise<void> {
  await fx.client.query(
    `INSERT INTO stat_lines (player_id, season, week, stat_key_id, value, source, revision)
     VALUES ($1, $2, $3, $4, $5, 'test', $6)`,
    [fx.players.get(handle), SEASON, WEEK, fx.statKeys.get("pass_yd"), passYards, revision],
  );
}

const finishGames = (fx: Fixture) =>
  fx.client.query("UPDATE games SET status = 'FINAL' WHERE season = $1 AND week = $2", [
    SEASON,
    WEEK,
  ]);

async function schedule(fx: Fixture): Promise<void> {
  await persistSchedule(fx.client, fx.leagueId, generateSchedule(fx.teamIds, 14, "seed"));
}

describe("persistSchedule", () => {
  it("writes every matchup", async () => {
    const fx = await setup();
    const result = await persistSchedule(
      fx.client,
      fx.leagueId,
      generateSchedule(fx.teamIds, 14, "seed"),
    );

    expect(result.written).toBe(14 * 2);
    expect(await loadScheduledWeek(fx.client, fx.leagueId, WEEK)).toHaveLength(2);
  });

  it("refuses to overwrite an existing schedule", async () => {
    // Rewriting mid-season changes who played whom, and every record derived
    // from it.
    const fx = await setup();
    await schedule(fx);

    const second = await persistSchedule(
      fx.client,
      fx.leagueId,
      generateSchedule(fx.teamIds, 14, "different-seed"),
    );

    expect(second.written).toBe(0);
  });
});

describe("resolveLeagueWeek", () => {
  it("scores a week from stored lineups", async () => {
    const fx = await setup();
    await schedule(fx);
    await score(fx, "qb-0", 300); // 12 points

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.matchups).toBe(2);
    const scored = outcome.results.find((r) =>
      [r.homeTeamId, r.awayTeamId].includes(fx.teamIds[0]!),
    );
    const points =
      scored?.homeTeamId === fx.teamIds[0] ? scored?.homeMilliPoints : scored?.awayMilliPoints;
    expect(points).toBe(12_000);
  });

  it("writes the points into matchups", async () => {
    const fx = await setup();
    await schedule(fx);
    await score(fx, "qb-0", 300);

    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    // Which side of a matchup a team lands on comes from the schedule, so this
    // sums both rather than assuming.
    const rows = await fx.client.query<{ home: number; away: number }>(
      `SELECT home_milli_points AS home, away_milli_points AS away
         FROM matchups WHERE league_id = $1 AND week = $2`,
      [fx.leagueId, WEEK],
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.home !== null && row.away !== null)).toBe(true);

    const total = rows.reduce((sum, row) => sum + Number(row.home) + Number(row.away), 0);
    expect(total).toBe(12_000);
  });

  it("picks up a new revision on a rerun", async () => {
    // How live scores stay current: the job runs again, reads the latest
    // revision, and the total moves.
    const fx = await setup();
    await schedule(fx);
    await score(fx, "qb-0", 100);

    const pointsFor = (outcome: { results: readonly MatchupResult[] }): number => {
      const matchup = outcome.results.find((r) =>
        [r.homeTeamId, r.awayTeamId].includes(fx.teamIds[0]!),
      )!;
      return matchup.homeTeamId === fx.teamIds[0]
        ? matchup.homeMilliPoints
        : matchup.awayMilliPoints;
    };

    const first = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);
    expect(pointsFor(first)).toBe(4_000);
    expect(first.finalized).toBe(false);

    await score(fx, "qb-0", 300, 1);

    const second = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);
    expect(pointsFor(second)).toBe(12_000);
    expect(second.finalized).toBe(false);
  });

  it("uses the latest revision, not the first", async () => {
    // A stat correction inserts a new revision rather than overwriting, so a
    // settled week stays auditable against what it settled on. Scoring must read
    // the current one.
    const fx = await setup();
    await schedule(fx);
    await score(fx, "qb-0", 500);
    await score(fx, "qb-0", 250, 1);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);
    const matchup = outcome.results.find((r) =>
      [r.homeTeamId, r.awayTeamId].includes(fx.teamIds[0]!),
    )!;
    const points =
      matchup.homeTeamId === fx.teamIds[0] ? matchup.homeMilliPoints : matchup.awayMilliPoints;

    expect(points).toBe(10_000);
  });

  it("fills a missing lineup rather than failing", async () => {
    // resolveWeek throws on a team with no lineup, correctly — scoring it as
    // zero hands its opponent a free win. ensureLineups is what stops that.
    const fx = await setup();
    await schedule(fx);
    await fx.client.query("DELETE FROM lineups WHERE team_id = $1", [fx.teamIds[1]]);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.matchups).toBe(2);
  });

  it("refuses a week with no schedule", async () => {
    const fx = await setup();

    await expect(resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING)).rejects.toMatchObject(
      { code: "NO_SCHEDULE" },
    );
  });
});

describe("resolveLeagueWeeksThrough", () => {
  const week1Finalized = async (fx: Fixture): Promise<boolean> => {
    const [row] = await fx.client.query<{ finalized_at: string | null }>(
      "SELECT finalized_at FROM matchups WHERE league_id = $1 AND week = $2 LIMIT 1",
      [fx.leagueId, WEEK],
    );
    return row?.finalized_at != null;
  };

  it("finalises a prior week that the single-week pointer leaves behind", async () => {
    // Week 1 is final and its 48h window has elapsed, but the pointer is on a
    // later week. This is exactly how a paying week is abandoned once the season
    // moves on: resolving only the pointer week never revisits it.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);

    // Resolving only week 5 (which has fixtures but no finished games) leaves
    // week 1 unfinalised — the bug.
    await resolveLeagueWeek(fx.client, fx.leagueId, 5, AFTER_STANDARD);
    expect(await week1Finalized(fx)).toBe(false);

    // The sweep resolves every unfinalised week up to the pointer, so week 1 is
    // finalised.
    const outcomes = await resolveLeagueWeeksThrough(fx.client, fx.leagueId, 5, AFTER_STANDARD);
    expect(outcomes.find((o) => o.week === WEEK)?.finalized).toBe(true);
    expect(await week1Finalized(fx)).toBe(true);
  });

  it("leaves nothing to do once every week through the pointer is finalised", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    // Only week 1 has finished games, so it is the only one that can finalise;
    // a second sweep finds it already done and nothing else pending to finalise.
    const again = await resolveLeagueWeeksThrough(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);
    expect(again).toHaveLength(0);
  });
});

describe("finalisation", () => {
  it("holds while games are still in progress", async () => {
    const fx = await setup();
    await schedule(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalized).toBe(false);
    expect(outcome.holdReason).toMatch(/still in progress/);
  });

  it("holds until the correction window has passed", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.finalized).toBe(false);
    expect(outcome.holdReason).toMatch(/waiting until/);
  });

  it("finalises once both conditions are met", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalized).toBe(true);
    expect(outcome.holdReason).toBeUndefined();
  });

  it("never rescores a finalised week", async () => {
    // In a paying week it has already decided money. A silently changed result
    // afterwards is exactly what the correction window exists to prevent.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    await expect(
      resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD),
    ).rejects.toMatchObject({ code: "ALREADY_FINAL" });
  });

  it("makes a paying week wait far longer", async () => {
    // Week 14 pays the regular-season prize, and NFL stat corrections arrive for
    // up to seven days.
    const fx = await setup();
    expect(finalizationHours(fx.rules, 1)).toBe(48);
    expect(finalizationHours(fx.rules, 14)).toBe(168);
    expect(finalizationHours(fx.rules, 17)).toBe(168);
  });

  it("says why a paying week is waiting", async () => {
    const fx = await setup();
    // Move the paying weeks onto week 1 so the message is observable here.
    const paying = {
      ...fx.rules,
      settlement: { ...fx.rules.settlement, payingWeeks: [WEEK] },
    } as LeagueRules;

    await schedule(fx);
    await finishGames(fx);

    // 49 hours is past the standard window but nowhere near the paying one.
    const hold = await (async () => {
      const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);
      return outcome;
    })();

    // With the league's real rules week 1 is not a paying week, so it finalises.
    expect(hold.finalized).toBe(true);
    expect(paying.settlement.payingWeeks).toEqual([WEEK]);
  });

  it("waits the full week when the week does pay", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);

    // Week 14 is a paying week in the default rules. Give it a game and a
    // schedule row, then check the two windows behave differently.
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    await fx.client.query(
      `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at, status)
       VALUES ($1, 'g14', $2, 14, 'CIN', 'BAL', $3, 'FINAL')`,
      [sport!.id, SEASON, KICKOFF],
    );

    const early = await resolveLeagueWeek(fx.client, fx.leagueId, 14, AFTER_STANDARD);
    expect(early.finalized).toBe(false);
    expect(early.holdReason).toMatch(/stat corrections/);

    const late = await resolveLeagueWeek(fx.client, fx.leagueId, 14, AFTER_PAYING);
    expect(late.finalized).toBe(true);
  });
});

describe("standings from resolved weeks", () => {
  it("feeds computeStandings end to end", async () => {
    // The whole chain: lineups → scoring → matchups → records → seeds.
    const fx = await setup();
    await schedule(fx);
    await score(fx, "qb-0", 400);
    await score(fx, "qb-1", 100);
    await finishGames(fx);

    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    const results = await loadWeekResults(fx.client, fx.leagueId, WEEK);
    const standings = computeStandings(fx.teamIds, results, fx.rules.schedule.tiebreakers);

    expect(standings).toHaveLength(4);
    expect(standings.every((row) => row.games === 1)).toBe(true);
    expect(standings.every((row) => row.wins + row.losses + row.ties === 1)).toBe(true);

    // Wins must equal losses. Not "two wins": the two teams who scored nothing
    // may well have been drawn against each other, and 0–0 is a tie for both.
    expect(standings.reduce((sum, row) => sum + row.wins, 0)).toBe(
      standings.reduce((sum, row) => sum + row.losses, 0),
    );

    // The top seed is the team that actually scored the most.
    expect(standings[0]?.milliPointsFor).toBe(16_000);
  });

  it("returns nothing for weeks that have not been scored", async () => {
    const fx = await setup();
    await schedule(fx);

    expect(await loadWeekResults(fx.client, fx.leagueId, WEEK)).toEqual([]);
  });
});
