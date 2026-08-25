import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, generateSchedule, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { setLineup } from "./lineups.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { loadTeamMatchup, loadWeekMatchups } from "./matchup.js";
import { persistSchedule, resolveLeagueWeek } from "./week.js";

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
const BEFORE = new Date(KICKOFF.getTime() - 3600 * 1000);
const DURING = new Date(KICKOFF.getTime() + 2 * 3600 * 1000);
/** Past the 48-hour standard finalisation window. */
const AFTER = new Date(KICKOFF.getTime() + 49 * 3600 * 1000);

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  rules: LeagueRules;
  teamIds: string[];
  players: Map<string, string>;
  statKeys: Map<string, string>;
  sportId: string;
  positions: Map<string, string>;
}

/**
 * Four teams, one quarterback each, all playing in the same Sunday game.
 *
 * Deliberately minimal: this module scores through `scoreTeamLineup`, which has
 * its own tests, so the interesting cases here are about which number is
 * reported and what the screen is told about the state of a game.
 */
async function setup(): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = buildNflPprRules({ seasonYear: SEASON, draft: DRAFT }) as LeagueRules;
  const league = await createLeague(db, NFL, {
    name: "Matchup League",
    commissionerId: commissioner.id,
    rules,
  });

  const teamIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    teamIds.push((await addTestTeam(db, league.id, `Team ${i + 1}`)).teamId);
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
      "INSERT INTO roster_entries (team_id, player_id, acquired_via) VALUES ($1, $2, 'DRAFT')",
      [teamId, row!.id],
    );

    await setLineup(db, {
      leagueId: league.id,
      teamId,
      week: WEEK,
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: row!.id }],
      now: Math.floor(BEFORE.getTime() / 1000),
    });
  }

  await persistSchedule(db, league.id, generateSchedule(teamIds, 14, "seed"));

  return {
    client: db,
    leagueId: league.id,
    rules,
    teamIds,
    players,
    statKeys,
    sportId: sport!.id,
    positions,
  };
}

async function score(
  fx: Fixture,
  handle: string,
  passYards: number,
  revision = 0,
): Promise<void> {
  await fx.client.query(
    `INSERT INTO stat_lines (player_id, season, week, stat_key_id, value, source, revision)
     VALUES ($1, $2, $3, $4, $5, 'tank01', $6)`,
    [fx.players.get(handle), SEASON, WEEK, fx.statKeys.get("pass_yd"), passYards, revision],
  );
}

/**
 * A week whose games finished **and whose box scores were read.**
 *
 * The sync stamps are not decoration. Since #140 a FINAL game with no box score
 * holds the week — and past the window settles it while reporting that our
 * ingest, not the NFL, produced the zeroes. This helper marked only the status
 * until the #140 re-audit, so every finalisation in this file had silently been
 * running through that fallback rather than the clean path, and every outcome
 * carried `finalizedWithUnfinishedGames` with nothing asserting its absence.
 *
 * Nothing here was testing what it read as testing. The rule the sibling
 * `week.test.ts` already states: a fixture must stage a state the product
 * actually produces.
 */
const finishGames = (fx: Fixture) =>
  fx.client.query(
    `UPDATE games SET status = 'FINAL',
                      final_at = now() - interval '1 hour',
                      stats_synced_at = now(),
                      stats_attempted_at = now()
      WHERE season = $1 AND week = $2`,
    [SEASON, WEEK],
  );

/** The side of the week's matchups belonging to a given team. */
function sideOf(views: Awaited<ReturnType<typeof loadWeekMatchups>>, teamId: string) {
  for (const view of views) {
    if (view.home.teamId === teamId) return view.home;
    if (view.away?.teamId === teamId) return view.away;
  }
  return undefined;
}

describe("loadWeekMatchups", () => {
  it("pairs the teams the schedule paired", async () => {
    const fx = await setup();

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, DURING);

    expect(views).toHaveLength(2);
    const paired = views.flatMap((v) => [v.home.teamId, v.away?.teamId]);
    expect(new Set(paired)).toEqual(new Set(fx.teamIds));
  });

  it("scores live, before anything is finalised", async () => {
    const fx = await setup();
    await score(fx, "qb-0", 300); // 0.04/yd = 12 points

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, DURING);

    expect(sideOf(views, fx.teamIds[0]!)?.milliPoints).toBe(12_000);
  });

  it("names the players and what each one scored", async () => {
    const fx = await setup();
    await score(fx, "qb-0", 300);

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, DURING);
    const side = sideOf(views, fx.teamIds[0]!);

    expect(side?.starters).toHaveLength(1);
    expect(side?.starters[0]).toMatchObject({
      name: "qb-0",
      position: "QB",
      slot: "QB",
      milliPoints: 12_000,
      counted: true,
    });
  });

  it("agrees with the result the cron writes", async () => {
    // The whole point of scoring through `scoreTeamLineup` rather than a second
    // implementation. A screen that disagreed with the standings would be worse
    // than no screen.
    const fx = await setup();
    await score(fx, "qb-0", 317);
    await score(fx, "qb-1", 288);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);
    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, DURING);

    for (const result of outcome.results) {
      const home = sideOf(views, result.homeTeamId);
      expect(home?.milliPoints).toBe(result.homeMilliPoints);
      if (result.awayTeamId) {
        expect(sideOf(views, result.awayTeamId)?.milliPoints).toBe(result.awayMilliPoints);
      }
    }
  });

  it("returns nothing for a week with no schedule", async () => {
    const fx = await setup();
    expect(await loadWeekMatchups(fx.client, fx.leagueId, 99, DURING)).toEqual([]);
  });
});

describe("what is still to come", () => {
  it("counts a starter whose game has not kicked off", async () => {
    const fx = await setup();

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, BEFORE);
    const side = sideOf(views, fx.teamIds[0]!);

    expect(side?.yetToPlay).toBe(1);
    expect(side?.inProgress).toBe(0);
    expect(side?.starters[0]?.gameState).toBe("YET_TO_PLAY");
  });

  it("counts a starter whose game is under way", async () => {
    const fx = await setup();

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, DURING);
    const side = sideOf(views, fx.teamIds[0]!);

    expect(side?.yetToPlay).toBe(0);
    expect(side?.inProgress).toBe(1);
  });

  it("calls a scoreless player in a started game in-progress, not still to come", async () => {
    // Reading zero points as "has not played yet" would tell a manager they are
    // still live when they are not — the one thing this number exists to say.
    const fx = await setup();

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, DURING);
    const side = sideOf(views, fx.teamIds[0]!);

    expect(side?.starters[0]?.milliPoints).toBe(0);
    expect(side?.starters[0]?.gameState).toBe("IN_PROGRESS");
  });

  it("counts nobody once every game is final", async () => {
    const fx = await setup();
    await finishGames(fx);

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, DURING);
    const side = sideOf(views, fx.teamIds[0]!);

    expect(side?.yetToPlay).toBe(0);
    expect(side?.inProgress).toBe(0);
    expect(side?.starters[0]?.gameState).toBe("FINAL");
  });

  it("shows a player on a bye as a bye, not as still to play", async () => {
    // He has no game to be waiting for. Counting him as yet-to-play would tell a
    // manager points are still coming when none are.
    const fx = await setup();
    await fx.client.query("UPDATE players SET team_ref = 'DEN' WHERE external_ref = 'qb-0'");
    await recordBye(fx, "qb-0", WEEK);

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, BEFORE);
    const side = sideOf(views, fx.teamIds[0]!);

    expect(side?.starters[0]?.gameState).toBe("BYE");
    expect(side?.yetToPlay).toBe(0);
    expect(side?.unscheduled).toBe(0);
  });

  it("calls an undated fixture unscheduled, not a bye", async () => {
    // The live case that prompted this: the NFL dates its late-December games
    // last, `syncGames` skips a game with no kickoff time, and the player's team
    // then looks exactly like a team on a bye. One means he cannot score and the
    // other means he will — in the weeks that decide a championship.
    const fx = await setup();
    await fx.client.query("UPDATE players SET team_ref = 'DEN' WHERE external_ref = 'qb-0'");
    await recordBye(fx, "qb-0", WEEK + 5);

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, BEFORE);
    const side = sideOf(views, fx.teamIds[0]!);

    expect(side?.starters[0]?.gameState).toBe("UNSCHEDULED");
    expect(side?.unscheduled).toBe(1);
  });

  it("does not count an undated fixture as still to play", async () => {
    // `yetToPlay` means "points are coming, at a known time". Folding an undated
    // fixture into it would put a kickoff on a game that has none.
    const fx = await setup();
    await fx.client.query("UPDATE players SET team_ref = 'DEN' WHERE external_ref = 'qb-0'");
    await recordBye(fx, "qb-0", WEEK + 5);

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, BEFORE);
    const side = sideOf(views, fx.teamIds[0]!);

    expect(side?.yetToPlay).toBe(0);
    expect(side?.inProgress).toBe(0);
  });

  it("falls back to a bye when no bye week is recorded", async () => {
    // Never claim a fixture is coming on the strength of a row we do not hold.
    // A missing `player_seasons` row keeps the answer this screen gave before.
    const fx = await setup();
    await fx.client.query("UPDATE players SET team_ref = 'DEN' WHERE external_ref = 'qb-0'");

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, BEFORE);
    const side = sideOf(views, fx.teamIds[0]!);

    expect(side?.starters[0]?.gameState).toBe("BYE");
    expect(side?.unscheduled).toBe(0);
  });
});

/** Give a player's team a bye week, which is what separates a bye from an
 * undated fixture. */
async function recordBye(fx: Fixture, handle: string, week: number): Promise<void> {
  const playerId = fx.players.get(handle);
  await fx.client.query(
    `INSERT INTO player_seasons (player_id, season, team_ref, bye_week)
     VALUES ($1, $2, 'DEN', $3)
     ON CONFLICT (player_id, season) DO UPDATE SET bye_week = EXCLUDED.bye_week`,
    [playerId, SEASON, week],
  );
}

describe("a finalised week", () => {
  it("reports the stored total, not a fresh recompute", async () => {
    // The stored number decided a win, a seed, and possibly a payout. A
    // correction arriving afterwards must not silently change it.
    const fx = await setup();
    await score(fx, "qb-0", 300);
    await finishGames(fx);
    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER);

    // A correction lands as a new revision, doubling the yardage.
    await score(fx, "qb-0", 600, 1);

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, AFTER);
    const side = sideOf(views, fx.teamIds[0]!);

    expect(side?.milliPoints).toBe(12_000);
  });

  it("says so when a late correction disagrees with it", async () => {
    // Reported rather than hidden: a correction that arrived too late to count
    // is a real event, and showing only one of the two numbers would be exactly
    // the kind of silent restatement this project exists to prevent.
    const fx = await setup();
    await score(fx, "qb-0", 300);
    await finishGames(fx);
    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER);
    await score(fx, "qb-0", 600, 1);

    const side = sideOf(
      await loadWeekMatchups(fx.client, fx.leagueId, WEEK, AFTER),
      fx.teamIds[0]!,
    );

    expect(side?.restatedMilliPoints).toBe(24_000);
  });

  it("says nothing when the recompute agrees", async () => {
    const fx = await setup();
    await score(fx, "qb-0", 300);
    await finishGames(fx);
    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER);

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, AFTER);

    expect(views.every((view) => view.finalized)).toBe(true);
    expect(sideOf(views, fx.teamIds[0]!)?.restatedMilliPoints).toBeNull();
  });

  it("keeps recomputing while the week is unfinalised", async () => {
    // Before finalisation a correction should move the number — that is what
    // makes a live score live.
    const fx = await setup();
    await score(fx, "qb-0", 300);
    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);
    await score(fx, "qb-0", 600, 1);

    const side = sideOf(
      await loadWeekMatchups(fx.client, fx.leagueId, WEEK, DURING),
      fx.teamIds[0]!,
    );

    expect(side?.milliPoints).toBe(24_000);
    expect(side?.restatedMilliPoints).toBeNull();
  });
});

describe("loadTeamMatchup", () => {
  it("finds the matchup a team is in, from either side", async () => {
    const fx = await setup();

    for (const teamId of fx.teamIds) {
      const view = await loadTeamMatchup(fx.client, fx.leagueId, teamId, WEEK, DURING);
      expect([view?.home.teamId, view?.away?.teamId]).toContain(teamId);
    }
  });

  it("is null for a team not playing that week", async () => {
    const fx = await setup();
    expect(
      await loadTeamMatchup(fx.client, fx.leagueId, fx.teamIds[0]!, 99, DURING),
    ).toBeNull();
  });
});

describe("byes", () => {
  it("leaves the away side null and still reports the home team", async () => {
    // An odd league gives somebody a bye every week. The row has to exist — the
    // week is not complete without it — and the screen has to say so rather than
    // rendering an opponent scoring zero.
    const fx = await setup();
    const odd = (await addTestTeam(fx.client, fx.leagueId, "Team 5")).teamId;

    await fx.client.query("DELETE FROM matchups WHERE league_id = $1", [fx.leagueId]);
    await persistSchedule(
      fx.client,
      fx.leagueId,
      generateSchedule([...fx.teamIds, odd], 14, "seed"),
    );

    const views = await loadWeekMatchups(fx.client, fx.leagueId, WEEK, DURING);
    const bye = views.filter((view) => view.away === null);

    expect(bye).toHaveLength(1);
    expect(bye[0]?.home.teamId).toBeTruthy();
  });
});

describe("the bench", () => {
  it("is scored and returned, never counted", async () => {
    // Managers want to see what they left out. `counted: false` is what keeps it
    // out of the total.
    const fx = await setup();

    const [spare] = await fx.client.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, 'spare', 'spare', $2, 'CIN') RETURNING id`,
      [fx.sportId, fx.positions.get("QB")!],
    );
    await fx.client.query(
      "INSERT INTO roster_entries (team_id, player_id, acquired_via) VALUES ($1, $2, 'DRAFT')",
      [fx.teamIds[0], spare!.id],
    );
    await fx.client.query(
      `INSERT INTO stat_lines (player_id, season, week, stat_key_id, value, source, revision)
       VALUES ($1, $2, $3, $4, 500, 'tank01', 0)`,
      [spare!.id, SEASON, WEEK, fx.statKeys.get("pass_yd")],
    );

    const side = sideOf(
      await loadWeekMatchups(fx.client, fx.leagueId, WEEK, DURING),
      fx.teamIds[0]!,
    );

    expect(side?.bench.map((line) => line.name)).toEqual(["spare"]);
    expect(side?.bench[0]?.milliPoints).toBe(20_000);
    // Twenty points on the bench, and the team still scored nothing.
    expect(side?.milliPoints).toBe(0);
  });
});
