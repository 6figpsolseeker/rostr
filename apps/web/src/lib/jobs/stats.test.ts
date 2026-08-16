import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { LeagueRules } from "@rostr/core";
import type { ProviderBoxScore, StatsProvider } from "@rostr/stats";
import { createLeague, createUser, listCronRuns, seedSport } from "@rostr/db";
import { createTestDatabase } from "@rostr/db/testing";
import type { PGliteClient } from "@rostr/db/testing";
import { runStatsJob } from "./stats.js";

/**
 * The stats cron, against a fake provider.
 *
 * What is under test here is the **job**, not `syncBoxScores` — the ingest is
 * covered against the real translator in `packages/db/src/box-scores.test.ts`.
 * Three things belong to this file and to nothing else: that a deployment with
 * no leagues makes no provider call at all, that per-game failures reach the
 * heartbeat rather than the run reporting itself healthy, and that one season's
 * trouble does not stop the next season being read.
 *
 * It needs no credentials, and that is the reason the job is a separate module
 * from the route rather than only a concession to Next's route contract. The job
 * takes a client and a provider, so this runs on PGlite in `pnpm test`; the
 * route reads `TANK01_API_KEY` and builds a real HTTP client, and a suite that
 * calls a metered third-party API is one that fails when somebody else's quota
 * runs out.
 */

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const NOW = new Date("2026-09-13T21:00:00Z");

const DRAFT = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
} as const;

/** Counts what it was asked for, so "made no call" is an assertion. */
function fakeProvider(behaviour: (gameRef: string) => ProviderBoxScore | Error): {
  provider: StatsProvider;
  calls: string[];
} {
  const calls: string[] = [];
  const provider = {
    name: "tank01",
    listPlayers: () => Promise.resolve([]),
    listByeWeeks: () => Promise.resolve(new Map()),
    listGames: () => Promise.resolve([]),
    listInjuries: () => Promise.resolve([]),
    getBoxScore: (gameRef: string) => {
      calls.push(gameRef);
      const answer = behaviour(gameRef);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  } as unknown as StatsProvider;

  return { provider, calls };
}

let leagueCount = 0;

async function league(season: number): Promise<void> {
  leagueCount += 1;
  const commissioner = await createUser(
    db!,
    `stats-cron-${leagueCount}@example.test`,
    `Commish ${leagueCount}`,
  );
  await createLeague(db!, NFL, {
    name: `Stats League ${leagueCount}`,
    commissionerId: commissioner.id,
    rules: buildNflPprRules({ seasonYear: season, draft: DRAFT }) as LeagueRules,
  });
}

/** A finished game nobody has read yet, so it is on the work list. */
async function finishedGame(season: number, ref: string): Promise<void> {
  const [sport] = await db!.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    NFL.key,
  ]);

  await db!.query(
    `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                        kickoff_at, status, final_at)
     VALUES ($1, $2, $3, 1, 'PHI', 'DAL', now() - interval '4 hours', 'FINAL',
             now() - interval '1 hour')`,
    [sport!.id, ref, season],
  );
}

/**
 * Both team defenses, as player rows.
 *
 * Needed because a box score that does not carry a DST for each side is
 * *reported as a problem* by the ingest, which is correct — a finished game with
 * no defence in it is a broken response, not an empty one. Without these the
 * "clean run" assertion below would be measuring a fixture that is itself a
 * failure, and would have passed against a route that reported every run as
 * broken.
 */
async function seedDefenses(): Promise<void> {
  const [sport] = await db!.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    NFL.key,
  ]);
  const [def] = await db!.query<{ id: string }>(
    "SELECT id FROM positions WHERE sport_id = $1 AND key = 'DEF'",
    [sport!.id],
  );

  for (const abv of ["PHI", "DAL"]) {
    await db!.query(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $2, $3, $4)`,
      [sport!.id, `DST_${abv}`, def!.id, abv],
    );
  }
}

/** What a healthy response looks like: both defenses present. */
const healthy = (gameRef: string): ProviderBoxScore => ({
  gameRef,
  // Zero exactly as the real adapter returns them — the games row is what says
  // which season and week this is.
  season: 0,
  week: 0,
  players: new Map([
    ["DST_PHI", [{ statKey: "def_pts_allowed", value: 20 }]],
    ["DST_DAL", [{ statKey: "def_pts_allowed", value: 24 }]],
  ]),
  warnings: [],
});

const lastOutcome = async (): Promise<string | null | undefined> =>
  (await listCronRuns(db!)).find((entry) => entry.name === "stats")?.lastOutcome;

describe("the stats cron", () => {
  it("makes no provider call when no league is playing", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);
    // A game exists, and no league does. The work list must come from the
    // seasons someone is actually playing, or a fresh deployment polls a
    // metered API every ten minutes for nobody.
    await finishedGame(2026, "g1");

    const { provider, calls } = fakeProvider(() => new Error("must not be called"));
    const response = await runStatsJob(db, provider, NOW);

    expect(calls).toEqual([]);
    expect(await response.json()).toMatchObject({ seasons: 0, runs: [] });
  });

  it("records a clean run with no problem", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026);
    await seedDefenses();
    await finishedGame(2026, "g1");

    const { provider, calls } = fakeProvider(healthy);

    await runStatsJob(db, provider, NOW);

    expect(calls).toEqual(["g1"]);
    expect(await lastOutcome()).toBeNull();
  });

  it("reports games that failed to ingest, rather than looking healthy", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026);
    await finishedGame(2026, "g1");

    // `syncBoxScores` catches a per-game failure and returns it rather than
    // throwing, which is right — one bad game must not stop the others. The
    // consequence is that without the `gameFailures` branch in the route, a run
    // where every game failed records exactly the same heartbeat as a run where
    // every game succeeded, and the heartbeat is the only thing anyone reads.
    const { provider } = fakeProvider(() => new Error("provider exploded"));

    const response = await runStatsJob(db, provider, NOW);
    const body = (await response.json()) as { runs: { failures: unknown[] }[] };

    expect(body.runs[0]?.failures).toHaveLength(1);
    expect(await lastOutcome()).toBe("1 game(s) failed to ingest");
  });

  it("moves on to the next season after one season's game fails", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026);
    await league(2027);
    await seedDefenses();
    await finishedGame(2026, "g1");
    await finishedGame(2027, "g2");

    const { provider, calls } = fakeProvider((gameRef) =>
      gameRef === "g1" ? new Error("2026 fell over") : healthy(gameRef),
    );

    const response = await runStatsJob(db, provider, NOW);
    const body = (await response.json()) as { seasons: number; runs: { season: number }[] };

    expect(body.seasons).toBe(2);
    expect(calls).toEqual(["g1", "g2"]);
    expect(body.runs.map((entry) => entry.season)).toEqual([2026, 2027]);
    expect(await lastOutcome()).toBe("1 game(s) failed to ingest");
  });

  /**
   * The route's own `try`/`catch` around a whole season is **not** exercised
   * here, and saying so is better than a test named as if it were.
   *
   * A provider that throws is caught inside `syncBoxScores` and reported as a
   * game failure, which is the test above. Reaching the season-level catch means
   * the work-list query or `loadSportIds` failing — the same client, the same
   * sport key, for every season in the loop — so there is no way to break it for
   * one season and not the others without stubbing the module, and a test whose
   * subject is a stub proves the stub.
   *
   * It is kept because the alternative is a bare `throw` aborting every
   * remaining season, which is the shape the score-week cron shipped with and
   * had to be fixed. See `score-week/route.test.ts` for that property tested
   * where it can be.
   */
});
