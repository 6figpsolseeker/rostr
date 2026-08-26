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
  const positions = new Map(
    (
      await db!.query<{ id: string; key: string }>(
        "SELECT id, key FROM positions WHERE sport_id = $1",
        [sport!.id],
      )
    ).map((row) => [row.key, row.id]),
  );

  for (const abv of ["PHI", "DAL"]) {
    await db!.query(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $2, $3, $4)`,
      [sport!.id, `DST_${abv}`, positions.get("DEF")!, abv],
    );
  }

  /*
    One player for every other position the registry declares, which no test here
    references.

    They are here because #232 added a check that refuses a run whose player pool
    has any declared position at zero — a vanished position group is invisible to
    any per-game join ratio, and it zeroes every player in that group
    permanently. A pool holding only defences is a state a synced database never
    reaches, and the check caught this fixture the moment it was written.

    The same widening was needed in `box-scores.test.ts`. Both were staging a
    pool the product cannot produce, which is the failure this repo keeps paying
    for in the other direction.
  */
  for (const [ref, key] of [
    ["qb1", "QB"],
    ["rb1", "RB"],
    ["wr1", "WR"],
    ["te1", "TE"],
    ["k1", "K"],
  ] as const) {
    await db!.query(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $2, $3, 'PHI')`,
      [sport!.id, ref, positions.get(key)!],
    );
  }
}

/** What a healthy response looks like: both defenses present. */
const healthy = (gameRef: string, warnings: readonly string[] = []): ProviderBoxScore => ({
  gameRef,
  // Zero exactly as the real adapter returns them — the games row is what says
  // which season and week this is.
  season: 0,
  week: 0,
  players: new Map([
    ["DST_PHI", [{ statKey: "def_pts_allowed", value: 20 }]],
    ["DST_DAL", [{ statKey: "def_pts_allowed", value: 24 }]],
  ]),
  warnings,
  // A finished game, which is what these fixtures describe — both defenses
  // carry a points-allowed total, and a live read would not.
  status: "FINAL",
  providerStatus: "Completed",
  providerStatusCode: "2",
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
    // A real pool, or #232 layer one refuses the run before the provider is
    // called and this becomes a broken *season* rather than a failed game.
    await seedDefenses();

    // `syncBoxScores` catches a per-game failure and returns it rather than
    // throwing, which is right — one bad game must not stop the others. The
    // consequence is that without the `gameFailures` branch in the route, a run
    // where every game failed records exactly the same heartbeat as a run where
    // every game succeeded, and the heartbeat is the only thing anyone reads.
    const { provider } = fakeProvider(() => new Error("provider exploded"));

    const response = await runStatsJob(db, provider, NOW);
    const body = (await response.json()) as { runs: { failures: unknown[] }[] };

    expect(body.runs[0]?.failures).toHaveLength(1);
    /*
      Contains, not equals. A game that failed to ingest is also a game with no
      usable box score in a week that can still be corrected, so the blocking
      clause fires alongside this one — correctly, and it is the more urgent of
      the two. Pinning the exact string asserted that no other reason could ever
      be true at the same time, which is the opposite of what a heartbeat that
      reports every reason is for.
    */
    expect(await lastOutcome()).toContain("1 game(s) failed to ingest");
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
    /*
      Contains, not equals. A game that failed to ingest is also a game with no
      usable box score in a week that can still be corrected, so the blocking
      clause fires alongside this one — correctly, and it is the more urgent of
      the two. Pinning the exact string asserted that no other reason could ever
      be true at the same time, which is the opposite of what a heartbeat that
      reports every reason is for.
    */
    expect(await lastOutcome()).toContain("1 game(s) failed to ingest");
  });

  /**
   * Warnings, which reached a human as the word "failed" and nothing else.
   *
   * The translator's whole `fatal`/`warnings` split exists so that a discrepancy
   * does not discard a game — and then every warning it raised was pushed onto
   * `failures` and announced as "N game(s) failed to ingest" on a run where
   * every player landed correctly. The cost is not the wording. A week finalises
   * after 48 hours and is never rescored, so the window for acting on a warning
   * is short, and a channel that cries failure on healthy runs is one people
   * stop opening — which is exactly how a novel play type stays invisible for
   * two seasons.
   */
  it("reports a warning as a warning, not as a failed ingest", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026);
    await seedDefenses();
    await finishedGame(2026, "g1");

    const { provider } = fakeProvider((gameRef) =>
      healthy(gameRef, ['scoreType "XPR" has not been seen before']),
    );

    const response = await runStatsJob(db, provider, NOW);
    const body = (await response.json()) as {
      gameWarnings: number;
      runs: { failures: unknown[]; warnings: { warning: string }[] }[];
    };

    expect(body.runs[0]?.failures).toEqual([]);
    expect(body.runs[0]?.warnings?.[0]?.warning).toContain("XPR");
    // **Reversed 2026-08-19, deliberately.** This asserted the warning reached
    // `last_outcome`, and that is exactly what made the field useless:
    // `cronJobState` reads any non-null value as FAILING, ahead of staleness, so
    // one self-contradicting game turned `pnpm cron:status` red for the rest of
    // the season. #157 makes such games common enough to matter.
    //
    // The warning is not lost — it is in the response body, in
    // `games.stats_error`, and on /ops/stats. What it no longer does is raise an
    // alarm on the deployment's only heartbeat.
    expect(await lastOutcome()).toBeNull();
    expect(body.gameWarnings).toBe(1);
  });

  it("reports the failure and keeps the warning out of the heartbeat", async () => {
    // Renamed. It used to assert both reached `last_outcome`, on the reasoning
    // that a heartbeat is read once so it should say everything. True of
    // failures, wrong for warnings: any non-null value is FAILING, so including
    // them made a self-contradicting game indistinguishable from a dead cron.
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026);
    await seedDefenses();
    await finishedGame(2026, "g1");
    await finishedGame(2026, "g2");

    const { provider } = fakeProvider((gameRef) =>
      gameRef === "g1"
        ? new Error("provider exploded")
        : healthy(gameRef, ["something did not add up"]),
    );

    const response = await runStatsJob(db, provider, NOW);
    const body = (await response.json()) as { gameWarnings: number };

    // The failure still reaches the heartbeat — the narrowing must not have
    // traded a false alarm for a silent one — and the warning no longer does.
    /*
      Contains, not equals. A game that failed to ingest is also a game with no
      usable box score in a week that can still be corrected, so the blocking
      clause fires alongside this one — correctly, and it is the more urgent of
      the two. Pinning the exact string asserted that no other reason could ever
      be true at the same time, which is the opposite of what a heartbeat that
      reports every reason is for.
    */
    expect(await lastOutcome()).toContain("1 game(s) failed to ingest");
    expect(body.gameWarnings).toBe(1);
  });

  /**
   * A heartbeat does not remember, and `games.stats_error` does.
   *
   * `cron_runs` holds one row per job and the next run overwrites it, so a
   * warning raised at noon is gone by ten past — and the run that follows a
   * troubled one is usually the quiet Tuesday run that fetched nothing at all.
   * `unresolvedStatsProblems` reads the column that survives.
   */
  it("keeps reporting a game that is still broken on a run that touched nothing", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026);
    await seedDefenses();
    await finishedGame(2026, "g1");

    const { provider } = fakeProvider((gameRef) =>
      healthy(gameRef, ["something did not add up"]),
    );
    await runStatsJob(db, provider, NOW);

    // Nothing is due now — the game was just read and its retry is paced — so
    // this run does no work at all and would once have recorded itself clean.
    const quiet = fakeProvider(() => new Error("must not be called"));
    const quietResponse = await runStatsJob(db, quiet.provider, NOW);
    const quietBody = (await quietResponse.json()) as {
      outstanding: { total: number };
    };

    expect(quiet.calls).toEqual([]);
    // Also reversed. `unresolvedStatsProblems` is unbounded by season and by
    // correction window on purpose, so a game past its window can never be
    // re-read, its `stats_error` is permanent by construction, and this count
    // only ever grows. A health signal that can never return to green is not a
    // health signal. The backlog is still in the response and on /ops/stats.
    expect(await lastOutcome()).toBeNull();
    expect(quietBody.outstanding.total).toBe(1);
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

describe("a slate that was under way and read nothing — #256", () => {
  /*
    The check that would have caught the defect the ingest was fixed for.

    `problem` was computed from failed seasons and failed games alone, so a
    Sunday on which the work list matched *nothing at all* recorded
    `last_outcome = null`. `pnpm cron:status` — the command CLAUDE.md tells every
    arriving session to run first — read green through sixteen hours of a
    pipeline that was not running, every ten minutes, for as long as it lasted.
  */

  /** A game being played: kicked off, inside the live window, not final. */
  async function liveGame(season: number, ref: string): Promise<void> {
    const [sport] = await db!.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
      NFL.key,
    ]);
    await db!.query(
      `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                          kickoff_at, status, final_at)
       VALUES ($1, $2, $3, 1, 'PHI', 'DAL', now() - interval '90 minutes', 'SCHEDULED', NULL)`,
      [sport!.id, ref, season],
    );
  }

  it("reports a slate the work list never selected", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026);
    await seedDefenses();
    await liveGame(2026, "g1");
    // The pacing stamp stands in for a work list that selected nothing: the
    // observable shape is the same and it is the one that matters.
    await db.query("UPDATE games SET stats_attempted_at = now(), stats_synced_at = now()");

    const { provider, calls } = fakeProvider(healthy);
    await runStatsJob(db, provider, NOW);

    expect(calls).toEqual([]);
    expect(await lastOutcome()).toMatch(/under way/);
  });

  it("stays quiet on a day with no games", async () => {
    /*
      The half that keeps this usable. A run over zero games genuinely is a
      healthy run in June, and an alarm that cannot go quiet is one nobody reads
      — a mistake this repo has already made twice, in `season-sync`'s undated
      fixtures and in `outstanding.total`. The predicate is bounded at both ends
      of `kickoff_at`, so it can only fire while a game is being played.
    */
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026);
    await seedDefenses();
    await liveGame(2026, "g1");
    await db.query("UPDATE games SET kickoff_at = now() + interval '3 days'");

    const { provider } = fakeProvider(healthy);
    await runStatsJob(db, provider, NOW);

    expect(await lastOutcome()).toBeNull();
  });

  it("does not count a game whose kickoff time is only a stand-in", async () => {
    /*
      `kickoff_tbd` marks a fixture whose hour the NFL has not fixed — eight of
      them across weeks 16 and 17, held back for flex scheduling — and the stored
      time is the earliest it *could* start. Reading the clock passing a stand-in
      as a game being played would raise this alarm for seven hours before a
      week-17 game that has not kicked off.

      This is also the only consumer that pins `kickoff_tbd` inside the shared
      `UNDER_WAY_SQL` fragment. The work list carries the same bound on its outer
      gate, so dropping it from the fragment is invisible there and visible here.
    */
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026);
    await seedDefenses();
    await liveGame(2026, "g1");
    await db.query(
      "UPDATE games SET kickoff_tbd = true, stats_attempted_at = now(), stats_synced_at = now()",
    );

    const { provider } = fakeProvider(healthy);
    await runStatsJob(db, provider, NOW);

    expect(await lastOutcome()).toBeNull();
  });

  it("stays quiet when the slate was read", async () => {
    /*
      The control. Without it every test above passes against an alarm that never
      fires at all.

      The response carries a **player** line rather than only the two defenses
      `healthy` describes, and that is not incidental. A live read withholds a
      D/ST — zero points allowed is a shutout, not an absence — so a mid-game
      response containing nothing else translates to no stat lines and correctly
      throws. Which is what this fixture did on first writing, and it is the same
      shape as #232's: a fixture staging a state the product does not produce.
    */
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026);
    await seedDefenses();
    await liveGame(2026, "g1");

    const { provider, calls } = fakeProvider((gameRef) => ({
      ...healthy(gameRef),
      players: new Map([["qb1", [{ statKey: "pass_yd", value: 120 }]]]),
      status: "IN_PROGRESS" as const,
      providerStatus: "In Progress",
      providerStatusCode: "1",
    }));
    await runStatsJob(db, provider, NOW);

    expect(calls).toEqual(["g1"]);
    expect(await lastOutcome()).toBeNull();
  });
});
