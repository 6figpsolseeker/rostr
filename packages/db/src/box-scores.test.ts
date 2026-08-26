import { afterEach, describe, expect, it } from "vitest";
import { NFL } from "@rostr/core";
import type { StatLine } from "@rostr/core";
import type { ProviderBoxScore, StatsProvider } from "@rostr/stats";
import { seedSport } from "./sports.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import {
  CONSECUTIVE_FAILURE_LIMIT,
  FAILED_RETRY_MINUTES,
  FINAL_RECHECK_HOURS,
  syncBoxScores,
  unresolvedStatsProblems,
} from "./box-scores.js";

/**
 * The producer, against the real translator.
 *
 * The fake below returns whatever it is handed, so what is exercised is the
 * writing half — revisions, retraction, failure isolation, and the work list.
 * The translation half is covered against a captured response in
 * `packages/stats/src/tank01/box-score.test.ts`; the seam between them is what
 * had never been run at all.
 */

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const SEASON = 2026;
const WEEK = 1;

const line = (statKey: string, value: number): StatLine => ({ statKey, value });

/*
  The refs a provider was asked for, in the order it was asked.

  The work list's ORDER BY decides which games a run spends its budget on when
  more are due than MAX_GAMES_PER_RUN allows, and nothing observed it: the test
  that claimed to check the priority ran its own hand-written copy of the same
  SQL and asserted the answer, which is a tautology about a query in this file.
  Deleting both priority keys from the producer left it green.
*/
function recordingProvider(byRef: Map<string, ProviderBoxScore | Error>): {
  provider: StatsProvider;
  asked: string[];
} {
  const asked: string[] = [];
  const inner = fakeProvider(byRef);
  return {
    asked,
    provider: {
      ...inner,
      getBoxScore: (gameRef: string) => {
        asked.push(gameRef);
        return (
          inner as { getBoxScore: (ref: string) => Promise<ProviderBoxScore> }
        ).getBoxScore(gameRef);
      },
    } as unknown as StatsProvider,
  };
}

function fakeProvider(byRef: Map<string, ProviderBoxScore | Error>): StatsProvider {
  return {
    name: "tank01",
    listPlayers: () => Promise.resolve([]),
    listByeWeeks: () => Promise.resolve(new Map()),
    listGames: () => Promise.resolve([]),
    getBoxScore: (gameRef: string) => {
      const answer = byRef.get(gameRef);
      if (answer instanceof Error) return Promise.reject(answer);
      if (!answer) return Promise.reject(new Error(`no fixture for ${gameRef}`));
      return Promise.resolve(answer);
    },
    listInjuries: () => Promise.resolve([]),
  } as unknown as StatsProvider;
}

const boxScore = (
  gameRef: string,
  players: Record<string, readonly StatLine[]>,
  warnings: readonly string[] = [],
  status: ProviderBoxScore["status"] = "FINAL",
): ProviderBoxScore => ({
  gameRef,
  // Deliberately zero, exactly as the real adapter returns them. If the producer
  // trusted these instead of the games row, every assertion below would fail.
  season: 0,
  week: 0,
  players: new Map(Object.entries(players)),
  warnings,
  /*
    The game's own status, which the real adapter now reads out of the response.

    Defaulting to FINAL keeps every existing test describing what it always
    described — a finished game — and `liveBoxScore` below is the deliberate
    opposite. The distinction is not cosmetic: a read the payload does not call
    final must not write a D/ST's allowed totals, because zero there is a
    shutout rather than an absence.
  */
  status,
  providerStatus: status === "FINAL" ? "Completed" : "In Progress",
  providerStatusCode: status === "FINAL" ? "2" : "1",
});

/** The same shape, mid-game. See `boxScore`. */
const liveBoxScore = (
  gameRef: string,
  players: Record<string, readonly StatLine[]>,
  warnings: readonly string[] = [],
): ProviderBoxScore => boxScore(gameRef, players, warnings, "IN_PROGRESS");

interface Fixture {
  client: PGliteClient;
  sportId: string;
  gameId: string;
  players: Map<string, string>;
}

/** One week-1 game, two rostered players and both team defenses. */
async function setup(status = "FINAL"): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

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

  const [game] = await db.query<{ id: string }>(
    `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                        kickoff_at, status, final_at)
     VALUES ($1, 'g1', $2, $3, 'PHI', 'DAL', now() - interval '4 hours', $4,
             CASE WHEN $4 = 'FINAL' THEN now() - interval '1 hour' ELSE NULL END)
     RETURNING id`,
    [sport!.id, SEASON, WEEK, status],
  );

  const players = new Map<string, string>();
  /*
    Every position the sport registry declares, not only the ones a test uses.

    A real pool always carries all six — the live table holds hundreds of each —
    and #232 added a check that refuses a run whose pool has a position group at
    zero, because a vanished group is invisible to any per-game join ratio. A
    fixture seeding three of six was staging a pool the product cannot produce,
    and the check caught it the moment it was written.

    `wr1`, `te1` and `k1` exist to make the pool real. No test needs to reference
    them.
  */
  const roster: [string, string][] = [
    ["qb1", "QB"],
    ["rb1", "RB"],
    ["wr1", "WR"],
    ["wr2", "WR"],
    ["wr3", "WR"],
    ["rb2", "RB"],
    ["te1", "TE"],
    ["te2", "TE"],
    ["k1", "K"],
    ["DST_PHI", "DEF"],
    ["DST_DAL", "DEF"],
  ];

  for (const [ref, position] of roster) {
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $2, $3, 'PHI') RETURNING id`,
      [sport!.id, ref, positions.get(position)!],
    );
    players.set(ref, row!.id);
  }

  return { client: db, sportId: sport!.id, gameId: game!.id, players };
}

const bothDefenses = {
  DST_PHI: [line("def_pts_allowed", 20)],
  DST_DAL: [line("def_pts_allowed", 24)],
};

const currentValue = async (
  fx: Fixture,
  ref: string,
  statKey: string,
): Promise<number | null> => {
  const [row] = await fx.client.query<{ value: number }>(
    `SELECT c.value FROM stat_lines_current c
       JOIN stat_keys k ON k.id = c.stat_key_id
      WHERE c.player_id = $1 AND c.season = $2 AND c.week = $3 AND k.key = $4`,
    [fx.players.get(ref), SEASON, WEEK, statKey],
  );
  return row ? Number(row.value) : null;
};

describe("syncBoxScores", () => {
  it("writes a first ingest at revision 0", async () => {
    const fx = await setup();
    const provider = fakeProvider(
      new Map([["g1", boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses })]]),
    );

    const result = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    expect(result.games).toBe(1);
    expect(result.inserted).toBe(3);
    expect(result.revised).toBe(0);
    expect(await currentValue(fx, "qb1", "pass_yd")).toBe(300);
  });

  it("writes nothing at all on an unchanged re-run", async () => {
    // The anti-inflation assertion. `stat_lines_current` would stay correct
    // either way — it takes the newest revision — so the damage of writing
    // unconditionally is entirely to the audit trail a settled week has to be
    // checkable against. At a ten-minute cadence over a seven-day correction
    // window, a stat sitting at revision 47 because a cron ran 47 times makes
    // that column unreadable.
    const fx = await setup();
    const box = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });
    const provider = fakeProvider(new Map([["g1", box]]));

    await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    // Force it back onto the work list, as a recheck inside the window would.
    await fx.client.query(
      "UPDATE games SET stats_synced_at = now() - interval '2 days', stats_attempted_at = now() - interval '2 days'",
    );

    const again = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    expect(again.inserted).toBe(0);
    expect(again.revised).toBe(0);
    expect(again.retracted).toBe(0);
    expect(again.unchanged).toBe(3);

    const [count] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM stat_lines",
    );
    expect(Number(count?.n)).toBe(3);
  });

  it("writes a new revision when a value actually changes", async () => {
    const fx = await setup();
    const provider = fakeProvider(
      new Map([["g1", boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses })]]),
    );
    await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    await fx.client.query(
      "UPDATE games SET stats_synced_at = now() - interval '2 days', stats_attempted_at = now() - interval '2 days'",
    );
    const corrected = fakeProvider(
      new Map([["g1", boxScore("g1", { qb1: [line("pass_yd", 312)], ...bothDefenses })]]),
    );
    const result = await syncBoxScores(fx.client, corrected, NFL.key, SEASON);

    expect(result.revised).toBe(1);
    expect(await currentValue(fx, "qb1", "pass_yd")).toBe(312);

    // The superseded row survives — that is what append-only is for.
    const [count] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM stat_lines",
    );
    expect(Number(count?.n)).toBe(4);
  });

  it("zeroes a stat that vanished from the box score", async () => {
    // A touchdown reassigned to another player. Without this the first player
    // keeps the points and the second gains them, so the play pays twice.
    const fx = await setup();
    await syncBoxScores(
      fx.client,
      fakeProvider(
        new Map([
          [
            "g1",
            boxScore("g1", { rb1: [line("rush_td", 1), line("rush_yd", 40)], ...bothDefenses }),
          ],
        ]),
      ),
      NFL.key,
      SEASON,
    );

    await fx.client.query(
      "UPDATE games SET stats_synced_at = now() - interval '2 days', stats_attempted_at = now() - interval '2 days'",
    );
    const result = await syncBoxScores(
      fx.client,
      fakeProvider(
        new Map([["g1", boxScore("g1", { rb1: [line("rush_yd", 40)], ...bothDefenses })]]),
      ),
      NFL.key,
      SEASON,
    );

    expect(result.retracted).toBe(1);
    expect(await currentValue(fx, "rb1", "rush_td")).toBe(0);
    expect(await currentValue(fx, "rb1", "rush_yd")).toBe(40);
  });

  it("never retracts points allowed, because zero there is a shutout", async () => {
    // The most important exclusion in the file. Retracting writes 0, and 0 for
    // this key is the top tier of the only tiered rule in the sport — worth ten
    // points. A D/ST that dropped out of a response must not be awarded one.
    const fx = await setup();
    await syncBoxScores(
      fx.client,
      fakeProvider(
        new Map([["g1", boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses })]]),
      ),
      NFL.key,
      SEASON,
    );

    await fx.client.query(
      "UPDATE games SET stats_synced_at = now() - interval '2 days', stats_attempted_at = now() - interval '2 days'",
    );
    // Both defenses still present, so they are "covered" and therefore eligible
    // for retraction — but points allowed is excluded by key.
    await syncBoxScores(
      fx.client,
      fakeProvider(
        new Map([
          [
            "g1",
            boxScore("g1", {
              qb1: [line("pass_yd", 300)],
              DST_PHI: [line("def_pts_allowed", 20)],
              DST_DAL: [line("def_pts_allowed", 24)],
            }),
          ],
        ]),
      ),
      NFL.key,
      SEASON,
    );

    expect(await currentValue(fx, "DST_PHI", "def_pts_allowed")).toBe(20);
    expect(await currentValue(fx, "DST_DAL", "def_pts_allowed")).toBe(24);
  });

  it("does not write a defense that is missing points allowed", async () => {
    // A partial D/ST scores wrongly and looks right. Skipped, and the game is
    // left flagged so it is re-read — but the player lines still land.
    const fx = await setup();
    const result = await syncBoxScores(
      fx.client,
      fakeProvider(
        new Map([
          [
            "g1",
            boxScore("g1", {
              qb1: [line("pass_yd", 300)],
              DST_PHI: [line("def_sack", 2)],
              DST_DAL: [line("def_pts_allowed", 24)],
            }),
          ],
        ]),
      ),
      NFL.key,
      SEASON,
    );

    expect(await currentValue(fx, "DST_PHI", "def_sack")).toBeNull();
    expect(await currentValue(fx, "qb1", "pass_yd")).toBe(300);

    // **A warning, not a failure**, and this assertion read `failures` until
    // 2026-08-17. The game was ingested — the quarterback's line is right there
    // on the line above — so calling it a failed ingest is false in both
    // directions: it raises a false alarm on a run that worked, and it puts a
    // discrepancy in the same count as a game nobody could read at all.
    expect(result.failures).toEqual([]);
    expect(result.warnings[0]?.warning).toContain("def_pts_allowed");
    expect(result.warnings[0]?.gameRef).toBe("g1");

    const [row] = await fx.client.query<{ stats_error: string | null }>(
      "SELECT stats_error FROM games WHERE id = $1",
      [fx.gameId],
    );
    expect(row?.stats_error).toContain("DST_PHI");
  });

  it("keeps a translator warning apart from a game that could not be read", async () => {
    // The distinction the `fatal`/`warnings` split makes upstream, carried
    // through to the caller. Both games below produce something worth saying;
    // only one of them lost any data.
    const fx = await setup();
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    await fx.client.query(
      `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                          kickoff_at, status, final_at)
       VALUES ($1, 'g2', $2, $3, 'BUF', 'NYJ', now() - interval '3 hours', 'FINAL',
               now() - interval '1 hour')`,
      [sport!.id, SEASON, WEEK],
    );

    const result = await syncBoxScores(
      fx.client,
      fakeProvider(
        new Map<string, ProviderBoxScore | Error>([
          [
            "g1",
            boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses }, [
              'scoreType "XPR" has not been seen before',
              "Somebody: unparseable field goal",
            ]),
          ],
          ["g2", new Error("provider exploded")],
        ]),
      ),
      NFL.key,
      SEASON,
    );

    // Both warnings survive as separate entries rather than one joined string,
    // so a caller can count them and a reader can read them.
    expect(result.warnings.map((entry) => entry.gameRef)).toEqual(["g1", "g1"]);
    expect(result.warnings[0]?.warning).toContain("XPR");
    expect(result.failures.map((entry) => entry.gameRef)).toEqual(["g2"]);

    // And the stats still landed for the game that warned.
    expect(await currentValue(fx, "qb1", "pass_yd")).toBe(300);
  });

  it("reads unresolved problems back out of the column that stores them", async () => {
    // `games.stats_error` has been written since `0027` and read by nothing, so
    // a discrepancy survived the run that found it and was visible to nobody:
    // `cron_runs` holds one row per job and the next clean run overwrites it.
    const fx = await setup();

    await syncBoxScores(
      fx.client,
      fakeProvider(
        new Map([
          ["g1", boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses }, ["odd"])],
        ]),
      ),
      NFL.key,
      SEASON,
    );

    const outstanding = await unresolvedStatsProblems(fx.client, NFL.key);

    expect(outstanding.total).toBe(1);
    /*
      The row carries more than it did, and the additions are the whole of #233.

      `finalAt` alone answered "can this still be corrected" and nothing else —
      so a game with no box score at all and a field-goal count disagreeing with
      itself came back identical, and the screen drew them identically under a
      sentence claiming both had been ingested and scored.

      `ingest` is the fact that was missing. `syncedAt`, `isFinal` and
      `kickoffAt` are the evidence behind it, and `weekLastKickoff` is the
      instant `finalizationHold` measures from — which this screen did not, and
      so disagreed with by about a day.
    */
    expect(outstanding.games).toEqual([
      {
        gameRef: "g1",
        season: SEASON,
        week: WEEK,
        ingest: "DISCREPANCY",
        problem: "odd",
        kickoffAt: expect.any(Date),
        finalAt: expect.any(Date),
        syncedAt: expect.any(Date),
        isFinal: true,
        weekLastKickoff: expect.any(Date),
      },
    ]);
  });

  it("reports nothing once the game has been re-read cleanly", async () => {
    // The other half: a problem has to be able to stop being reported, or the
    // count only ever grows and becomes noise. `stats_error` is overwritten on
    // every ingest, including with null.
    const fx = await setup();
    const good = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });

    await syncBoxScores(
      fx.client,
      fakeProvider(
        new Map([
          ["g1", boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses }, ["odd"])],
        ]),
      ),
      NFL.key,
      SEASON,
    );
    expect((await unresolvedStatsProblems(fx.client, NFL.key)).total).toBe(1);

    // The retry clause needs the last attempt to be older than
    // FAILED_RETRY_MINUTES, which it is not in a test that just ran.
    await fx.client.query(
      "UPDATE games SET stats_synced_at = now() - interval '1 hour', stats_attempted_at = now() - interval '1 hour' WHERE id = $1",
      [fx.gameId],
    );
    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", good]])), NFL.key, SEASON);

    expect((await unresolvedStatsProblems(fx.client, NFL.key)).total).toBe(0);
  });

  it("keeps going when one game cannot be read", async () => {
    const fx = await setup();
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    await fx.client.query(
      `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                          kickoff_at, status, final_at)
       VALUES ($1, 'g2', $2, $3, 'BUF', 'NYJ', now() - interval '3 hours', 'FINAL',
               now() - interval '1 hour')`,
      [sport!.id, SEASON, WEEK],
    );

    const result = await syncBoxScores(
      fx.client,
      fakeProvider(
        new Map<string, ProviderBoxScore | Error>([
          ["g1", new Error("provider exploded")],
          [
            "g2",
            boxScore("g2", {
              qb1: [line("pass_yd", 250)],
              // g2's own teams. Using another game's defenses would make the
              // producer flag it — correctly — and mask what this test is about.
              DST_BUF: [line("def_pts_allowed", 17)],
              DST_NYJ: [line("def_pts_allowed", 10)],
            }),
          ],
        ]),
      ),
      NFL.key,
      SEASON,
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.gameRef).toBe("g1");
    // The second game still landed.
    expect(await currentValue(fx, "qb1", "pass_yd")).toBe(250);
  });

  it("names unmatched refs rather than counting them", async () => {
    const fx = await setup();
    const result = await syncBoxScores(
      fx.client,
      fakeProvider(
        new Map([
          ["g1", boxScore("g1", { "nobody-we-know": [line("pass_yd", 1)], ...bothDefenses })],
        ]),
      ),
      NFL.key,
      SEASON,
    );

    expect(result.unmatched).toContain("nobody-we-know");
  });

  /*
    This test used to be "leaves a scheduled game alone" and it asserted the
    defect. Issue #256.

    `setup` kicks its game off four hours ago, so the old assertion was: a game
    that has been under way all afternoon must not be read, because a job that
    runs once a day at 05:20 Eastern has not got round to relabelling it. It
    passed, it would have gone on passing forever, and it was the only test
    standing between the work list and live scoring.

    The pair below replaces it, and the second is what the first is really
    claiming: SCHEDULED was never the interesting fact. The clock is.
  */
  it("reads a game the daily sync still calls SCHEDULED, once it has kicked off", async () => {
    const fx = await setup("SCHEDULED");
    const box = boxScore("g1", { qb1: [line("pass_yd", 120)], ...bothDefenses });

    const result = await syncBoxScores(
      fx.client,
      fakeProvider(new Map([["g1", box]])),
      NFL.key,
      SEASON,
    );

    expect(result.games).toBe(1);
  });

  it("leaves a scheduled game alone until it has kicked off", async () => {
    // The bound that keeps `stats_attempted_at IS NULL` finite. Without it the
    // first tick of the season selects all 256 fixtures.
    const fx = await setup("SCHEDULED");
    await fx.client.query("UPDATE games SET kickoff_at = now() + interval '2 hours'");

    const result = await syncBoxScores(fx.client, fakeProvider(new Map()), NFL.key, SEASON);

    expect(result.games).toBe(0);
  });

  it("does not read a game in the first minutes after kickoff", async () => {
    // There is nothing to read yet. An empty response costs a metered call and
    // then throws, so without the offset every healthy game on every Sunday
    // records a failure on its first tick and is paced as though broken.
    const fx = await setup("SCHEDULED");
    await fx.client.query("UPDATE games SET kickoff_at = now() - interval '5 minutes'");

    const result = await syncBoxScores(fx.client, fakeProvider(new Map()), NFL.key, SEASON);

    expect(result.games).toBe(0);
  });

  it("ignores a game whose kickoff time is only a stand-in", async () => {
    /*
      Migration 0030: `kickoff_tbd` marks a fixture whose hour the NFL has not
      fixed, and the stored time is the earliest it *could* start. Eight of them
      sit in weeks 16 and 17 — the playoff and championship weeks — because those
      hours are held back for flex scheduling.

      Reading the clock passing a stand-in as the game having started polls a
      20:20 game from 13:00 and gives up forty minutes into the real one.
    */
    const fx = await setup("SCHEDULED");
    await fx.client.query("UPDATE games SET kickoff_tbd = true");

    const result = await syncBoxScores(fx.client, fakeProvider(new Map()), NFL.key, SEASON);

    expect(result.games).toBe(0);
  });

  it("stops re-reading once the correction window has passed", async () => {
    const fx = await setup();
    await syncBoxScores(
      fx.client,
      fakeProvider(
        new Map([["g1", boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses })]]),
      ),
      NFL.key,
      SEASON,
    );

    await fx.client.query(
      `UPDATE games SET final_at = now() - interval '8 days',
                        stats_synced_at = now() - interval '7 days'`,
    );

    const result = await syncBoxScores(fx.client, fakeProvider(new Map()), NFL.key, SEASON);
    expect(result.games).toBe(0);
  });
});

/**
 * The work list is the only thing pacing a metered provider.
 *
 * The loop inside `syncBoxScores` has no delay in it, so a clause that can stay
 * true indefinitely is a provider call every ten minutes until the season ends.
 * Each of the three below was unbounded, and none of them had a test — which is
 * how they stayed unbounded.
 */
describe("the work list bounds what one run can spend", () => {
  /** A second game, so a fixture can express more than one due row. */
  async function addGame(fx: Fixture, ref: string, columns: string): Promise<void> {
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    await fx.client.query(
      `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                          kickoff_at, status, final_at)
       VALUES ($1, $2, $3, $4, 'PHI', 'DAL', ${columns})`,
      [sport!.id, ref, SEASON, WEEK],
    );
  }

  it("stops treating a game as live once it is long over", async () => {
    // An in-progress game is re-read every run, which is the point. What it must
    // not do is run forever — and a status that never advances is not
    // hypothetical, because `mapGameStatus` answers SCHEDULED for wording it
    // does not recognise and only two of the five statuses have been observed.
    const fx = await setup("IN_PROGRESS");
    await fx.client.query(
      "UPDATE games SET kickoff_at = now() - interval '30 hours', stats_synced_at = now(), stats_attempted_at = now()",
    );

    const result = await syncBoxScores(fx.client, fakeProvider(new Map()), NFL.key, SEASON);

    expect(result.games).toBe(0);
  });

  it("still reads a game that is genuinely in progress", async () => {
    // The control. Without it the test above passes just as well against a rule
    // that never treats anything as live.
    //
    // The attempt stamp is deliberately older than LIVE_POLL_MINUTES: the live
    // clause is paced now, so a game read a moment ago is correctly skipped and
    // this test would otherwise assert against the pacing rather than the window.
    const fx = await setup("IN_PROGRESS");
    await fx.client.query(
      `UPDATE games SET kickoff_at = now() - interval '2 hours',
                       stats_synced_at = now() - interval '31 minutes',
                       stats_attempted_at = now() - interval '31 minutes'`,
    );

    const box = boxScore("g1", { qb1: [line("pass_yd", 120)], ...bothDefenses });
    const result = await syncBoxScores(
      fx.client,
      fakeProvider(new Map([["g1", box]])),
      NFL.key,
      SEASON,
    );

    expect(result.games).toBe(1);
  });

  it("stops retrying a warning-bearing game once its window closes", async () => {
    // `stats_error` is set by ordinary warnings, not only failures — a
    // field-goal count that disagrees with the plays parsed from it, a defence
    // missing from the box score. Those do not resolve on a re-read, so without
    // a window bound one such game was fetched seventy-two times a day for the
    // rest of the season, and sixteen of them would exceed the daily quota.
    //
    // The bound is `kickoff_at` rather than `final_at` — see the clause. So the
    // kickoff moves here too; a game whose `final_at` is nine days old but which
    // supposedly kicked off four hours ago is not a state the season produces,
    // and pinning the expiry against it would pin the wrong column.
    const fx = await setup();
    await fx.client.query(
      `UPDATE games SET stats_error = 'fgMade disagrees with the parsed plays',
                       stats_synced_at = now() - interval '1 hour',
                       stats_attempted_at = now() - interval '1 hour',
                       kickoff_at = now() - interval '9 days',
                       final_at = now() - interval '9 days'`,
    );

    const result = await syncBoxScores(fx.client, fakeProvider(new Map()), NFL.key, SEASON);

    expect(result.games).toBe(0);
  });

  it("keeps retrying a warning-bearing game whose whistle was never observed", async () => {
    /*
      The hole the kickoff bound closes.

      A game read cleanly at 19:50 whose provider then fails for the rest of the
      window carries `stats_error` and **no `final_at`** — nothing observed the
      whistle. Bounded on `final_at`, this clause compared against NULL, was
      false, and the sweep was false for the same reason: the game fell out of
      the work list entirely until the daily sync stamped `final_at` the next
      morning, and the week's numbers were a thirteen-hour-old third-quarter
      snapshot.
    */
    const fx = await setup("IN_PROGRESS");
    await fx.client.query(
      `UPDATE games SET stats_error = 'Tank01 returned HTTP 503',
                       stats_synced_at = now() - interval '9 hours',
                       stats_attempted_at = now() - interval '1 hour',
                       kickoff_at = now() - interval '9 hours',
                       final_at = NULL`,
    );

    const box = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });
    const result = await syncBoxScores(
      fx.client,
      fakeProvider(new Map([["g1", box]])),
      NFL.key,
      SEASON,
    );

    expect(result.games).toBe(1);
  });

  it("does not read a live game twice inside its polling interval", async () => {
    /*
      The constant that keeps LIVE_WINDOW_HOURS a ceiling rather than a budget.

      Unpaced, the live clause fires on every tick — six an hour, times a
      five-hour window, times fourteen concurrent games on a Sunday. That is the
      753-call afternoon the work list's own comment rejects.
    */
    const fx = await setup("SCHEDULED");
    await fx.client.query(
      `UPDATE games SET kickoff_at = now() - interval '2 hours',
                       stats_synced_at = now() - interval '5 minutes',
                       stats_attempted_at = now() - interval '5 minutes'`,
    );

    const result = await syncBoxScores(fx.client, fakeProvider(new Map()), NFL.key, SEASON);

    expect(result.games).toBe(0);
  });

  it("still retries a warning-bearing game inside its window", async () => {
    // The control for the bound above.
    const fx = await setup();
    await fx.client.query(
      `UPDATE games SET stats_error = 'fgMade disagrees with the parsed plays',
                       stats_synced_at = now() - interval '1 hour',
                       -- Aged too, or clause one ("never attempted") selects this
                       -- game and the retry clause this test is the control for
                       -- never runs.
                       stats_attempted_at = now() - interval '1 hour',
                       final_at = now() - interval '2 hours'`,
    );

    const box = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });
    const result = await syncBoxScores(
      fx.client,
      fakeProvider(new Map([["g1", box]])),
      NFL.key,
      SEASON,
    );

    expect(result.games).toBe(1);
  });

  it("fetches at most MAX_GAMES_PER_RUN in one pass", async () => {
    // A season backfill puts every game of a played season inside the correction
    // window at once, because `final_at` is stamped when a game is first
    // *observed* final rather than when it was played. `pnpm db:sync 2025` is a
    // planned task, and without a ceiling its first run fetches hundreds of box
    // scores in a tight loop against a metered provider.
    // Twenty-five is a literal, not `MAX_GAMES_PER_RUN + 5`. Sizing the fixture
    // from the constant under test makes the assertion move with it, so raising
    // the ceiling — or deleting the LIMIT — would leave this green. The number
    // is a spend bound; changing it should have to be deliberate and visible.
    const DUE = 25;
    const fx = await setup();
    const boxes = new Map([["g1", boxScore("g1", { qb1: [line("pass_yd", 1)] })]]);
    for (let i = 2; i <= DUE; i++) {
      const ref = `g${i}`;
      await addGame(fx, ref, "now() - interval '4 hours', 'FINAL', now() - interval '1 hour'");
      boxes.set(ref, boxScore(ref, { qb1: [line("pass_yd", i)] }));
    }

    const result = await syncBoxScores(fx.client, fakeProvider(boxes), NFL.key, SEASON);

    expect(result.games).toBe(20);
    expect(result.games, "every due game was fetched — the LIMIT is not binding").toBeLessThan(
      DUE,
    );
  });

  it("reads a never-read game before re-reading one it already has", async () => {
    // The ordering earns its keep only once there is a LIMIT: a game nobody has
    // read scores its players zero *right now*, where a re-read only refines a
    // number that already exists. Plain kickoff order would let a backlog of old
    // games starve today's.
    const fx = await setup();
    await fx.client.query(
      // The original game is old, already read, and due only for a recheck.
      `UPDATE games SET kickoff_at = now() - interval '5 days',
                       stats_synced_at = now() - interval '7 hours',
                       final_at = now() - interval '5 days'`,
    );
    await addGame(fx, "g2", "now() - interval '3 hours', 'FINAL', now() - interval '1 hour'");

    const boxes = new Map([
      ["g1", boxScore("g1", { qb1: [line("pass_yd", 1)] })],
      ["g2", boxScore("g2", { qb1: [line("pass_yd", 2)] })],
    ]);

    // Both are due; only one may be fetched.
    const [first] = await fx.client.query<{ external_ref: string }>(
      `SELECT external_ref FROM games
        ORDER BY (stats_synced_at IS NULL) DESC, (status = 'IN_PROGRESS') DESC, kickoff_at
        LIMIT 1`,
    );
    expect(first?.external_ref).toBe("g2");

    const result = await syncBoxScores(fx.client, fakeProvider(boxes), NFL.key, SEASON);
    expect(result.games).toBe(2);
  });
});

describe("a game whose ingest failed — #227", () => {
  /*
    `syncBoxScores` stamps `stats_synced_at = now()` on **both** paths: on
    success, and on failure alongside the reason. The failure stamp is deliberate
    — it paces the retry, so a game that cannot be read is not re-fetched every
    ten minutes forever.

    The cost is that the column means two things at once: "when did we last try"
    and "do we have stats". #140's hold reads it as the second, counting FINAL
    games with `stats_synced_at IS NULL`, so it catches a game nobody ever tried
    to read and **misses one somebody tried and failed on** — which is exactly
    what a 429 mid-Sunday produces.

    These tests drive the real producer against a failing provider rather than
    hand-writing the row, so they keep describing what the product actually does
    when the two columns are separated.
  */

  it("does not claim to have synced a game it could not read", async () => {
    const fx = await setup();
    const provider = fakeProvider(
      new Map([["g1", new Error("Tank01 refused the request (HTTP 429)")]]),
    );

    const result = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    expect(result.failures).toHaveLength(1);

    const [row] = await fx.client.query<{
      stats_synced_at: string | null;
      stats_attempted_at: string | null;
      stats_error: string | null;
    }>("SELECT stats_synced_at, stats_attempted_at, stats_error FROM games WHERE id = $1", [
      fx.gameId,
    ]);

    // The attempt is recorded, so the retry stays paced.
    expect(row?.stats_attempted_at).not.toBeNull();
    expect(row?.stats_error).toContain("429");

    // But nothing was synced, and the column that says so must not claim it was.
    // This is the assertion #140's hold depends on.
    expect(row?.stats_synced_at).toBeNull();
  });

  it("records both when the read succeeds", async () => {
    // The other half: a successful ingest sets both, so nothing that paces on
    // the attempt loses its pacing.
    const fx = await setup();

    const provider = fakeProvider(
      new Map([["g1", boxScore("g1", { qb1: [line("pass_yd", 300)] })]]),
    );
    await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    const [row] = await fx.client.query<{
      stats_synced_at: string | null;
      stats_attempted_at: string | null;
    }>("SELECT stats_synced_at, stats_attempted_at FROM games WHERE id = $1", [fx.gameId]);

    expect(row?.stats_synced_at).not.toBeNull();
    expect(row?.stats_attempted_at).not.toBeNull();
  });

  it("does re-read a failed game once the pacing interval has passed", async () => {
    /*
      **The control the pacing test had no partner for, and it was load-bearing.**

      Its sibling below asserts a failed game is NOT re-read immediately. On its
      own that assertion is satisfied by a game which is never re-read *again*,
      which is the strictly worse outcome and exactly what one plausible edit
      produces: point the retry clause back at "stats_synced_at" and a failed
      game — whose sync stamp is NULL since #227 — matches no clause in the work
      list, forever. The pacing test then passes harder, and the game silently
      leaves the queue with its players scoring zero.

      Recovery is the whole point of pacing a retry. A Sunday 429 that clears
      twenty minutes later has to be picked up.
    */
    const fx = await setup();
    const failing = fakeProvider(
      new Map([["g1", new Error("Tank01 refused the request (HTTP 429)")]]),
    );

    expect((await syncBoxScores(fx.client, failing, NFL.key, SEASON)).games).toBe(1);
    expect((await syncBoxScores(fx.client, failing, NFL.key, SEASON)).games).toBe(0);

    // The provider recovers, and so must the queue.
    await fx.client.query(
      `UPDATE games SET stats_attempted_at = now() - make_interval(mins => $2::int)
        WHERE id = $1`,
      [fx.gameId, FAILED_RETRY_MINUTES + 5],
    );

    const provider = fakeProvider(
      new Map([["g1", boxScore("g1", { qb1: [line("pass_yd", 300)] })]]),
    );
    const recovered = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    expect(recovered.games).toBe(1);
    expect(recovered.failures).toHaveLength(0);

    const [row] = await fx.client.query<{ stats_synced_at: string | null }>(
      "SELECT stats_synced_at FROM games WHERE id = $1",
      [fx.gameId],
    );
    expect(row?.stats_synced_at).not.toBeNull();
  });

  it("does not erase an earlier successful sync when a later read fails", async () => {
    /*
      A game is re-read for the whole 168h correction window, so one transient
      429 during that window lands on a row that has already ingested cleanly.
      The failure path must record the attempt and the error and leave the sync
      stamp exactly where it was.

      Nothing pinned this: every failure staged in this file happens on a row
      that had never synced, so nulling "stats_synced_at" on the failure path
      was undetectable. The cost of the missing assertion is not a lost stat
      line — the stats are already stored — it is that #140's hold reads that
      column, so the week would report a game that ingested perfectly as
      "never ingested, the cause is our stats pipeline", and hold or settle on
      that basis.
    */
    const fx = await setup();

    const good = fakeProvider(
      new Map([["g1", boxScore("g1", { qb1: [line("pass_yd", 300)] })]]),
    );
    await syncBoxScores(fx.client, good, NFL.key, SEASON);

    const [synced] = await fx.client.query<{ stats_synced_at: string }>(
      "SELECT stats_synced_at FROM games WHERE id = $1",
      [fx.gameId],
    );
    expect(synced?.stats_synced_at).not.toBeNull();

    // Age both columns past the correction sweep so the game is due again.
    await fx.client.query(
      `UPDATE games SET stats_synced_at = now() - make_interval(hours => $2::int),
                        stats_attempted_at = now() - make_interval(hours => $2::int)
        WHERE id = $1`,
      [fx.gameId, FINAL_RECHECK_HOURS + 1],
    );
    const [aged] = await fx.client.query<{ stats_synced_at: string }>(
      "SELECT stats_synced_at FROM games WHERE id = $1",
      [fx.gameId],
    );

    const failing = fakeProvider(
      new Map([["g1", new Error("Tank01 refused the request (HTTP 429)")]]),
    );
    const result = await syncBoxScores(fx.client, failing, NFL.key, SEASON);
    expect(result.failures).toHaveLength(1);

    const [after] = await fx.client.query<{
      stats_synced_at: string | null;
      stats_error: string | null;
    }>("SELECT stats_synced_at, stats_error FROM games WHERE id = $1", [fx.gameId]);

    expect(after?.stats_error).toContain("429");
    expect(after?.stats_synced_at).toEqual(aged?.stats_synced_at);
  });

  it("paces the correction sweep on the attempt, not only on the sync", async () => {
    /*
      **A hole this fix opened in the fix before it.**

      #227 moved pacing onto "stats_attempted_at" and re-pointed three of the
      four clauses that select a game for re-read. The fourth — the NFL
      stat-correction sweep — kept reading the sync time, justified as "a game
      being re-read for corrections has stats already". True at selection,
      false at pacing: the failure path no longer touches the sync stamp, so
      once a synced game starts failing that predicate is frozen true and
      re-selects it on every tick. Six calls an hour, for up to 168 hours,
      against a metered provider — roughly a thousand calls for one game, and
      a rate limit fails a whole slate at once, so the loop feeds the outage
      that caused it.

      The retry clause could not restrain it: they are OR siblings.
    */
    const fx = await setup();

    await syncBoxScores(
      fx.client,
      fakeProvider(new Map([["g1", boxScore("g1", { qb1: [line("pass_yd", 300)] })]])),
      NFL.key,
      SEASON,
    );
    await fx.client.query(
      `UPDATE games SET stats_synced_at = now() - make_interval(hours => $2::int),
                        stats_attempted_at = now() - make_interval(hours => $2::int)
        WHERE id = $1`,
      [fx.gameId, FINAL_RECHECK_HOURS + 1],
    );

    const failing = fakeProvider(
      new Map([["g1", new Error("Tank01 refused the request (HTTP 429)")]]),
    );

    // The sweep legitimately picks it up once.
    expect((await syncBoxScores(fx.client, failing, NFL.key, SEASON)).games).toBe(1);

    // And must not pick it up again on the next tick, ten minutes later. The
    // sync stamp is still hours old and always will be; only the attempt moved.
    expect((await syncBoxScores(fx.client, failing, NFL.key, SEASON)).games).toBe(0);
  });

  it("reads the newest unread game first, so a backlog cannot starve the slate", async () => {
    /*
      **The ordering inverted meaning without a character changing.**

      Before #227 a failed game carried a sync stamp, so it sorted into the last
      tier — behind never-read games and behind live ones. #227 stopped stamping
      the sync on failure, which is correct, and thereby promoted every failed
      game into the *front* tier. The tie-break underneath was kickoff ascending.

      So an outage that fails a whole slate at once leaves 16–32 games which, on
      the next tick, sort ahead of the current afternoon's and consume the entire
      LIMIT oldest-first. Live scoring stops for every league, and the newest
      failures are read last. The comment directly above the clause promised the
      opposite — "plain kickoff order would let a backlog of old games starve
      today's" — and had become false at the moment it was written.

      Newest-first within a tier is the fix: the game closest to now is the one
      whose zero is about to be seen on a scoreboard or frozen by a finalisation.

      This asserts the producer's own ordering by recording what the provider was
      asked for, rather than re-running the query and agreeing with itself.
    */
    const fx = await setup();
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );

    // A five-day-old failure, still inside its 168h correction window, and today's unread game.
    await fx.client.query(
      `UPDATE games SET stats_attempted_at = now() - interval '2 hours',
                        stats_error = 'Tank01 refused the request (HTTP 429)',
                        kickoff_at = now() - interval '5 days',
                        final_at = now() - interval '5 days'
        WHERE id = $1`,
      [fx.gameId],
    );
    await fx.client.query(
      `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                          kickoff_at, status, final_at)
       VALUES ($1, 'today', $2, $3, 'NYG', 'WAS', now() - interval '4 hours', 'FINAL',
               now() - interval '1 hour')`,
      [sport!.id, SEASON, WEEK],
    );

    const { provider, asked } = recordingProvider(
      new Map([
        ["g1", boxScore("g1", { qb1: [line("pass_yd", 100)] })],
        ["today", boxScore("today", { qb1: [line("pass_yd", 200)] })],
      ]),
    );

    const result = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    // Both are due — the point is which one a budget-limited run reaches first.
    expect(result.games).toBe(2);
    expect(asked[0]).toBe("today");
  });

  it("does not re-read a failed game on the very next tick", async () => {
    /*
      The reason the failure stamp existed in the first place, preserved.

      `stats_error` is set by ordinary warnings as much as by failures, so
      without pacing one game with a permanent discrepancy was re-read seventy-two
      times a day — sixteen of those would have exceeded the daily quota outright.
      Moving the pace onto `stats_attempted_at` must not lose that.
    */
    const fx = await setup();
    const provider = fakeProvider(
      new Map([["g1", new Error("Tank01 refused the request (HTTP 429)")]]),
    );

    const first = await syncBoxScores(fx.client, provider, NFL.key, SEASON);
    expect(first.games).toBe(1);

    const second = await syncBoxScores(fx.client, provider, NFL.key, SEASON);
    expect(second.games).toBe(0);
  });
});

describe("a box score whose players do not join — #232", () => {
  /*
    The defect: unresolvable refs went into their own array and never reached
    `problems`, so a game where almost nothing joined recorded a clean success —
    `stats_error` NULL (clearing any prior error), `stats_synced_at` stamped, the
    week finalising at zero, and nothing on any of nine surfaces showing it.

    The two D/ST refs are what let it through: they are synthesised
    `DST_<abv>` names matched against thirty-two stable rows, carrying a
    `def_pts_allowed` written even at nought, so they clear the "translated to no
    stat lines" guard on their own while every skill player fails.
  */

  it("refuses a game where most scoring players did not join", async () => {
    const fx = await setup();

    // 14 scoring refs: 2 D/ST that join, 12 ghosts that do not. 12 of 14 is
    // 8571 bps, far past the 2500 threshold, and 14 clears the floor of 12.
    const players: Record<string, ReturnType<typeof line>[]> = { ...bothDefenses };
    for (let i = 0; i < 12; i++) players[`ghost-${i}`] = [line("pass_yd", 10)];

    const provider = fakeProvider(new Map([["g1", boxScore("g1", players)]]));
    const result = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toMatch(/did not match the player pool/);

    /*
      The assertion that makes this issue #232 rather than a nicety.

      `stats_synced_at` is what the week's finalisation hold reads. Left unset,
      the game counts as unread, the week holds for its correction window, and
      the twenty-minute retry runs — all of which the existing per-game catch
      already provides, which is why this throws rather than recording a warning.
    */
    const [row] = await fx.client.query<{
      stats_synced_at: string | null;
      stats_error: string | null;
    }>("SELECT stats_synced_at, stats_error FROM games WHERE id = $1", [fx.gameId]);

    expect(row?.stats_synced_at).toBeNull();
    expect(row?.stats_error).toMatch(/did not match the player pool/);

    // Nothing was written, so `failures`' promise stays literally true.
    const [lines] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM stat_lines",
    );
    expect(lines?.n).toBe(0);
  });

  it("stays silent on the healthy shape, where most refs never join", async () => {
    /*
      **The regression test for the measurement this fix is built on.**

      Sixty to seventy percent of a real box score never joins and never should:
      it carries everyone who took a snap, and `players` holds the six positions
      a fantasy roster can field. Across thirteen corpus games the unmatched rate
      over *all* refs is 67-71%.

      So a guard on the wrong denominator fires on every game ever ingested. This
      stages that shape — two joining scorers, sixty non-scoring strangers — and
      must stay green forever.
    */
    const fx = await setup();

    const players: Record<string, ReturnType<typeof line>[]> = {
      qb1: [line("pass_yd", 300)],
      rb1: [line("rush_yd", 80)],
      ...bothDefenses,
    };
    for (let i = 0; i < 60; i++) players[`lineman-${i}`] = [];

    const provider = fakeProvider(new Map([["g1", boxScore("g1", players)]]));
    const result = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    expect(result.failures).toHaveLength(0);
    expect(result.unmatched).toHaveLength(60);

    const [row] = await fx.client.query<{
      stats_synced_at: string | null;
      stats_error: string | null;
    }>("SELECT stats_synced_at, stats_error FROM games WHERE id = $1", [fx.gameId]);
    expect(row?.stats_synced_at).not.toBeNull();
    expect(row?.stats_error).toBeNull();
  });

  it("tolerates the innocent misses a real game carries", async () => {
    /*
      Five of 277 scoring refs across thirteen real games fail to join, and every
      one is a defensive or special-teams player credited with a return
      touchdown — nobody can roster them, so they cost no points. The worst
      single game is two of twenty-two, which is 909 bps against a 2500
      threshold.

      Two unjoinable scorers among fourteen is 1428 bps: past the worst observed
      game and still comfortably silent.
    */
    const fx = await setup();

    const players: Record<string, ReturnType<typeof line>[]> = {
      qb1: [line("pass_yd", 300)],
      rb1: [line("rush_yd", 80)],
      wr1: [line("rec_yd", 40)],
      te1: [line("rec_yd", 20)],
      k1: [line("fg_0_39", 1)],
      "returner-a": [line("ret_td", 1)],
      "returner-b": [line("ret_td", 1)],
      ...bothDefenses,
    };
    for (let i = 0; i < 5; i++) players[`extra-${i}`] = [];

    const provider = fakeProvider(new Map([["g1", boxScore("g1", players)]]));
    const result = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    expect(result.failures).toHaveLength(0);
    expect(result.unmatched).toContain("returner-a");
  });

  it("catches a single position group vanishing from the box score", async () => {
    /*
      **The break that decides the constant, rather than a preference.**

      Running backs are roughly a fifth of a pool and five or six of a games
      twenty-odd scoring refs, so losing them is 23-27 percent. At 2500 bps that
      fires; at the looser 3333 it does not, and every rostered running back in
      every league scores zero permanently while the guard reads green.

      Four unmatched of fourteen is 2857 bps, which sits between the two — so
      this test is what makes the threshold a decision rather than a number
      nobody can move.

      Note this is the case layer one cannot help with: the pool still has
      running backs, it is the box scores refs for them that stopped matching.
    */
    const fx = await setup();

    const players: Record<string, ReturnType<typeof line>[]> = {
      qb1: [line("pass_yd", 300)],
      wr1: [line("rec_yd", 90)],
      te1: [line("rec_yd", 30)],
      k1: [line("fg_0_39", 1)],
      ...bothDefenses,
    };
    // Eleven refs that join, four that do not: 4 of 15 is 2666 bps — above 2500
    // and below 3333. The band is the whole point of the test.
    for (const ref of ["rb2", "wr2", "wr3", "te2"]) players[ref] = [line("rec_yd", 15)];
    for (let i = 0; i < 4; i++) players[`rb-unmatched-${i}`] = [line("rush_yd", 40)];

    const provider = fakeProvider(new Map([["g1", boxScore("g1", players)]]));
    const result = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    expect(result.failures).toHaveLength(1);
  });

  it("abstains below the denominator floor, so a live read is not judged", async () => {
    /*
      The floor is on the **denominator** — refs carrying stat lines — and never
      on the matched count. A floor on matches is circular: a wholly broken pool
      produces two matched refs, below any floor, so the guard would abstain
      exactly when it must fire.

      A return touchdown is as likely on the opening kickoff as in the fourth
      quarter, and the work list takes IN_PROGRESS games — so one unrosterable
      returner plus the two D/ST units is one unmatched of three at 13:01 on a
      Sunday. That is 33% and entirely healthy.
    */
    const fx = await setup("IN_PROGRESS");

    const provider = fakeProvider(
      new Map([["g1", boxScore("g1", { returner: [line("ret_td", 1)], ...bothDefenses })]]),
    );
    const result = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    expect(result.failures).toHaveLength(0);
  });

  it("refuses the whole run when a position group has vanished", async () => {
    /*
      The failure no per-game ratio can see, and the reason this layer exists.

      Kickers are roughly two of twenty scoring refs, so losing every kicker in
      the league moves the per-game ratio to about 9% — under the threshold, on
      every game, forever, while every kicker scores zero permanently. The damage
      is uniform across teams, so the standings look plausible and nothing
      downstream notices either.

      Checked once per run against our own database, before a single metered call
      is spent. No threshold: it fires only at zero.
    */
    const fx = await setup();
    await fx.client.query(
      `DELETE FROM players WHERE primary_position_id =
         (SELECT id FROM positions WHERE sport_id = $1 AND key = 'K')`,
      [fx.sportId],
    );

    const provider = fakeProvider(
      new Map([["g1", boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses })]]),
    );

    await expect(syncBoxScores(fx.client, provider, NFL.key, SEASON)).rejects.toThrow(
      /player pool has no K/,
    );
  });

  it("names the empty groups rather than counting them", async () => {
    // The idiom this file already uses, and for the reason recorded there: a
    // bare count once hid every kicker in the league.
    const fx = await setup();
    await fx.client.query(
      `DELETE FROM players WHERE primary_position_id IN
         (SELECT id FROM positions WHERE sport_id = $1 AND key IN ('K', 'TE'))`,
      [fx.sportId],
    );

    const provider = fakeProvider(new Map([["g1", boxScore("g1", bothDefenses)]]));

    await expect(syncBoxScores(fx.client, provider, NFL.key, SEASON)).rejects.toThrow(
      /no K, TE/,
    );
  });
});

describe("the box score reports the game's own status — #256", () => {
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  const statusOf = async (fx: Fixture) =>
    (
      await fx.client.query<{
        status: string;
        final_at: string | null;
        provider_status: string | null;
        provider_status_code: string | null;
      }>(
        "SELECT status, final_at, provider_status, provider_status_code FROM games WHERE id = $1",
        [fx.gameId],
      )
    )[0]!;

  it("marks a game final from the box score, not from the daily schedule sync", async () => {
    /*
      The half of #256 that makes everything downstream true. `games.status` had
      one writer, on a cron at 09:20 UTC, so a game that ended at 16:15 Eastern
      stayed SCHEDULED until the following morning — and the scoreboard went on
      reporting its starters as "playing" for seventeen hours.
    */
    const fx = await setup("SCHEDULED");
    const box = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });

    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", box]])), NFL.key, SEASON);

    const row = await statusOf(fx);
    expect(row.status).toBe("FINAL");
    expect(row.final_at).not.toBeNull();
  });

  it("records the vendor's verbatim wording, so a live Sunday settles what it says", async () => {
    // Evidence, not control flow. IN_PROGRESS has never been observed from this
    // provider and `mapGameStatus`'s three live spellings are guesses; there is
    // one live Sunday before the season in which to find out.
    const fx = await setup("SCHEDULED");
    const box = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });

    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", box]])), NFL.key, SEASON);

    const row = await statusOf(fx);
    expect(row.provider_status).toBe("Completed");
    expect(row.provider_status_code).toBe("2");
  });

  it("refuses to call a game final before one could possibly have finished", async () => {
    /*
      The guard for the one risk this design carries: no mid-game box score has
      ever been fetched from this provider, so if `gameStatus` reads "Completed"
      from the moment the row exists, an ungated stamp would set `final_at` at
      kickoff, open the 168h correction window three hours early, and settle the
      week on a first-quarter box score. Silently.

      Requiring a previous successful read does not close it — the second read is
      twenty minutes in. The clock does.
    */
    const fx = await setup("SCHEDULED");
    await fx.client.query("UPDATE games SET kickoff_at = now() - interval '40 minutes'");
    const box = boxScore("g1", { qb1: [line("pass_yd", 40)], ...bothDefenses });

    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", box]])), NFL.key, SEASON);

    const row = await statusOf(fx);
    expect(row.status).toBe("SCHEDULED");
    expect(row.final_at).toBeNull();
    // Still recorded, which is how we find out the vendor does this at all.
    expect(row.provider_status).toBe("Completed");
  });

  it("never moves final_at once it is set", async () => {
    // The 168h correction window keys on it. A later read restarting it would
    // hold a settled week open for another week.
    const fx = await setup();
    const first = (await statusOf(fx)).final_at;
    const box = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });

    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", box]])), NFL.key, SEASON);

    expect((await statusOf(fx)).final_at).toEqual(first);
  });

  it("does not walk a final game backwards, whichever writer asks", async () => {
    /*
      Migration 0043. `syncGames` writes `status = EXCLUDED.status`
      unconditionally and `mapGameStatus` answers SCHEDULED for wording it does
      not recognise, so a settled game could be un-finalled by one unfamiliar
      string — and `finalizationHold` counts a game as unread only when it reads
      FINAL, so the week would then settle blaming section 10 for our own ingest.

      The trigger clamps rather than raising: a throw here would take the
      ten-minute ingest down on a Sunday, which is when it must not stop.
    */
    const fx = await setup();
    await fx.client.query("UPDATE games SET status = 'SCHEDULED', final_at = NULL");

    const row = await statusOf(fx);
    expect(row.status).toBe("FINAL");
    expect(row.final_at).not.toBeNull();
  });
});

describe("a team defense is never scored from an unfinished game — #256", () => {
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  /** A live read: kicked off, inside the window, paced so it is selectable. */
  const midGame = async (fx: Fixture) =>
    fx.client.query(
      `UPDATE games SET status = 'SCHEDULED', final_at = NULL,
                       kickoff_at = now() - interval '75 minutes'`,
    );

  it("writes no team defense while the game is still being played", async () => {
    /*
      Both tiered ladders top out at zero — def_pts_allowed at 0 pays 5, and
      def_yds_allowed at 0-99 pays 5 — so a first-quarter read does not describe
      a defense that has conceded nothing yet. It describes a **shutout**, ten
      points before a single sack, for every unit in every game, counting down
      all afternoon as real yards land.

      This is the only new wrongness reading during play introduces, and it
      exists only because of the fix.
    */
    const fx = await setup("SCHEDULED");
    await midGame(fx);
    const box = liveBoxScore("g1", {
      qb1: [line("pass_yd", 80)],
      DST_PHI: [line("def_pts_allowed", 0)],
      DST_DAL: [line("def_pts_allowed", 0)],
    });

    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", box]])), NFL.key, SEASON);

    expect(await currentValue(fx, "DST_PHI", "def_pts_allowed")).toBeNull();
    expect(await currentValue(fx, "DST_DAL", "def_pts_allowed")).toBeNull();
    // The players in the same response are written as normal — this withholds a
    // defense, it does not discard the read.
    expect(await currentValue(fx, "qb1", "pass_yd")).toBe(80);
  });

  it("does not report a withheld defense as a problem", async () => {
    /*
      The trap. Both `problems.push` sites below the skip would fire on every
      live read, `stats_error` would be set on a perfectly healthy Sunday, and
      the retry clause would then pace the game at three reads an hour on top of
      the live clause, all afternoon, every week.
    */
    const fx = await setup("SCHEDULED");
    await midGame(fx);
    const box = liveBoxScore("g1", {
      qb1: [line("pass_yd", 80)],
      DST_PHI: [line("def_pts_allowed", 0)],
      DST_DAL: [line("def_pts_allowed", 0)],
    });

    const result = await syncBoxScores(
      fx.client,
      fakeProvider(new Map([["g1", box]])),
      NFL.key,
      SEASON,
    );

    expect(result.warnings).toEqual([]);
    const [row] = await fx.client.query<{ stats_error: string | null }>(
      "SELECT stats_error FROM games WHERE id = $1",
      [fx.gameId],
    );
    expect(row?.stats_error).toBeNull();
  });

  it("does not retract a defense it withheld", async () => {
    /*
      The sharpest edge in this change. The retraction pass writes an explicit
      zero for any non-zero key belonging to a ref the response **covered** and
      did not carry — so a withheld unit that still counted as covered would have
      the retraction machinery *manufacture* the shutout it was withheld to
      prevent.

      Withholding is expressed as "not covered by this read", never as "carried
      as absent".
    */
    const fx = await setup();
    const final = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });
    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", final]])), NFL.key, SEASON);
    expect(await currentValue(fx, "DST_PHI", "def_pts_allowed")).toBe(20);

    await midGame(fx);
    const live = liveBoxScore("g1", { qb1: [line("pass_yd", 80)] });
    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", live]])), NFL.key, SEASON);

    expect(await currentValue(fx, "DST_PHI", "def_pts_allowed")).toBe(20);
  });

  it("writes the defense as soon as the game is final", async () => {
    // The control. Without it every test above passes against a rule that never
    // writes a team defense at all.
    const fx = await setup();
    const box = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });

    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", box]])), NFL.key, SEASON);

    expect(await currentValue(fx, "DST_PHI", "def_pts_allowed")).toBe(20);
  });
});

describe("a run gives up on a provider that has stopped answering — #256", () => {
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  /** N finished games, none of them read yet, newest first in the work list. */
  async function slate(fx: Fixture, count: number): Promise<string[]> {
    const refs: string[] = [];
    for (let i = 0; i < count; i++) {
      const ref = `slate-${i}`;
      await fx.client.query(
        `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                            kickoff_at, status, final_at)
         VALUES ($1, $2, $3, $4, 'PHI', 'DAL',
                 now() - interval '4 hours', 'FINAL', now() - interval '1 hour')`,
        [fx.sportId, ref, SEASON, WEEK],
      );
      refs.push(ref);
    }
    return refs;
  }

  it("stops after four games in a row fail, rather than spending the whole limit", async () => {
    /*
      One bad game must not cost the other fifteen their read — that is the catch
      inside the loop, and it is right. Fifteen failing in a row is a different
      thing: one outage, and every call after the first few is spend against a
      provider that has already answered.

      It matters more now that selection is clock-keyed. A slate the provider
      cannot serve is fourteen games selected on every tick at up to three HTTP
      attempts each; unbroken, one bad Sunday exceeds the day's quota and leaves
      nothing for the recovery.
    */
    const fx = await setup();
    await slate(fx, 9);
    const { provider, asked } = recordingProvider(new Map());

    const result = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    expect(asked).toHaveLength(CONSECUTIVE_FAILURE_LIMIT);
    expect(result.failures).toHaveLength(CONSECUTIVE_FAILURE_LIMIT);
    expect(result.deferred.length).toBeGreaterThan(0);
  });

  it("does not stamp the games it deferred", async () => {
    /*
      Deferred is not failed. Nothing was attempted for these, so nothing is
      recorded against them — and that is what lets the next tick reach them once
      the games that genuinely failed are paced out by `FAILED_RETRY_MINUTES`.

      Stamping them would make four unreadable games block the slate for as long
      as the outage lasted, which is worse than the spend the breaker exists to
      prevent.
    */
    const fx = await setup();
    await slate(fx, 9);
    const { provider } = recordingProvider(new Map());

    const result = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    for (const ref of result.deferred) {
      const [row] = await fx.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM games
          WHERE external_ref = $1 AND stats_attempted_at IS NULL AND stats_error IS NULL`,
        [ref],
      );
      expect(row?.n).toBe(1);
    }
  });

  it("resets the count on a success, so one bad game never stops the slate", async () => {
    /*
      Consecutive, not cumulative. A single unreadable game among healthy ones is
      the ordinary case — a novel play type, a defence missing from one response
      — and a running total would let three of those across an afternoon shut the
      run down.
    */
    const fx = await setup();
    const refs = await slate(fx, 8);
    const total = refs.length + 1; // `setup` seeds one game of its own.

    /*
      Alternating on **call order**, not on the ref.

      Every game here shares a kickoff, so the work list's `kickoff_at DESC` tier
      leaves their relative order unspecified — an alternation keyed on the ref
      would depend on which order the database happened to return, and would pass
      or fail by luck.
    */
    const asked: string[] = [];
    const provider = {
      ...fakeProvider(new Map()),
      getBoxScore: (gameRef: string) => {
        asked.push(gameRef);
        return asked.length % 2 === 0
          ? Promise.resolve(boxScore(gameRef, { qb1: [line("pass_yd", 100)], ...bothDefenses }))
          : Promise.reject(new Error("bad game"));
      },
    } as unknown as StatsProvider;

    const result = await syncBoxScores(fx.client, provider, NFL.key, SEASON);

    expect(asked).toHaveLength(total);
    expect(result.deferred).toEqual([]);
  });
});

describe("what the operator screen can tell apart — #233", () => {
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  const problems = (fx: Fixture) => unresolvedStatsProblems(fx.client, NFL.key, 50);

  /** A second game in the same week, so the week's clock is not this game's. */
  const addGame = async (fx: Fixture, ref: string, kickoff: string) =>
    fx.client.query(
      `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                          kickoff_at, status, final_at)
       VALUES ($1, $2, $3, $4, 'NYG', 'WAS', now() + ($5)::interval, 'SCHEDULED', NULL)`,
      [fx.sportId, ref, SEASON, WEEK, kickoff],
    );

  it("reports a game whose every read failed as having no stats", async () => {
    // The headline. This and a field-goal count disagreeing with itself were the
    // same row on the screen, under a sentence claiming both had been ingested
    // and scored.
    const fx = await setup();
    await fx.client.query(
      `UPDATE games SET stats_error = 'Tank01 returned HTTP 503',
                       stats_attempted_at = now() - interval '1 hour',
                       stats_synced_at = NULL`,
    );

    const { games } = await problems(fx);

    expect(games).toHaveLength(1);
    expect(games[0]?.ingest).toBe("NO_STATS");
  });

  it("reports an ingested game carrying a warning as a discrepancy", async () => {
    const fx = await setup();
    const box = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses }, [
      "fgMade disagrees with the parsed plays",
    ]);
    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", box]])), NFL.key, SEASON);

    const { games } = await problems(fx);

    expect(games).toHaveLength(1);
    expect(games[0]?.ingest).toBe("DISCREPANCY");
  });

  it("reports a game read cleanly and then failing as stale", async () => {
    /*
      **The state #256 created, which #233's own filed predicate cannot reach.**

      Before live reads existed, the first read of any game was necessarily after
      the whistle — so a game either had a sync stamp or it did not, and the
      issue's two-row table was complete. Now a game can carry stats *and* a
      failing latest attempt. The discriminator is the ordering of the two
      stamps, not the nullness of one.
    */
    const fx = await setup();
    const box = boxScore("g1", { qb1: [line("pass_yd", 120)], ...bothDefenses });
    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", box]])), NFL.key, SEASON);
    await fx.client.query(
      `UPDATE games SET stats_error = 'Tank01 returned HTTP 503',
                       stats_attempted_at = stats_synced_at + interval '20 minutes'`,
    );

    const { games } = await problems(fx);

    expect(games[0]?.ingest).toBe("STALE");
  });

  it("finds a played game with no stats and no error at all", async () => {
    /*
      **The largest gap, and every design missed it before it was pointed out.**

      A game starved by MAX_GAMES_PER_RUN on a fourteen-game slate, or skipped by
      the consecutive-failure breaker — which deliberately stamps nothing,
      because it did not attempt them — carries no error, no sync stamp, and
      whatever status the daily sync last wrote. That is exactly the class this
      screen exists for, and every predicate keyed on `stats_error` misses it.

      Found by the clock instead, which is #256's lesson one layer up.
    */
    const fx = await setup("SCHEDULED");
    await fx.client.query(
      "UPDATE games SET stats_error = NULL, stats_attempted_at = NULL, stats_synced_at = NULL",
    );

    const { games } = await problems(fx);

    expect(games).toHaveLength(1);
    expect(games[0]?.ingest).toBe("NO_STATS");
    expect(games[0]?.problem).toBeNull();
  });

  it("does not report a game that has not plausibly been played yet", async () => {
    // The floor. Without it every unplayed fixture of the season is a problem.
    const fx = await setup("SCHEDULED");
    await fx.client.query(
      `UPDATE games SET stats_error = NULL, stats_attempted_at = NULL, stats_synced_at = NULL,
                       kickoff_at = now() - interval '40 minutes'`,
    );

    expect((await problems(fx)).games).toEqual([]);
  });

  it("does not report a fixture whose kickoff time is only a stand-in", async () => {
    // Eight week-16 and week-17 fixtures carry a provisional hour. A blank row
    // for one is a false alarm in the playoff and championship weeks.
    const fx = await setup("SCHEDULED");
    await fx.client.query(
      `UPDATE games SET stats_error = NULL, stats_attempted_at = NULL, stats_synced_at = NULL,
                       kickoff_tbd = true`,
    );

    expect((await problems(fx)).games).toEqual([]);
  });

  it("does not report a discrepancy on a game still being played", async () => {
    /*
      A partial box score disagreeing with itself is not a defect. The
      translator's warnings are ungated, so without this a slate's worth of
      transient noise lands here every Sunday — and a page that is amber every
      Sunday is a page nobody opens.
    */
    const fx = await setup("SCHEDULED");
    await fx.client.query(
      `UPDATE games SET stats_error = 'fgMade disagrees with the parsed plays',
                       stats_synced_at = now(), stats_attempted_at = now(),
                       final_at = NULL, kickoff_at = now() - interval '90 minutes'`,
    );

    expect((await problems(fx)).games).toEqual([]);
  });

  it("never reports a postponed game as having no stats", async () => {
    // RULES.md §10 already scores those players zero, and no box score is ever
    // coming. Without the exclusion it would sit here for the rest of the season.
    const fx = await setup("POSTPONED");
    await fx.client.query(
      "UPDATE games SET stats_error = NULL, stats_attempted_at = NULL, stats_synced_at = NULL",
    );

    expect((await problems(fx)).games).toEqual([]);
  });

  it("says nothing at all about a healthy game", async () => {
    const fx = await setup();
    const box = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });
    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", box]])), NFL.key, SEASON);

    expect((await problems(fx)).games).toEqual([]);
  });

  it("carries the week's last kickoff, not the game's own", async () => {
    /*
      Issue #233, finding 8. `finalizationHold` measures the correction window
      from the week's last kickoff; this screen measured from the game's own
      `final_at`, which is a different clock rather than a different latency — so
      an early Sunday game read CLOSED about 28 hours before its week settled.
    */
    const fx = await setup();
    await fx.client.query(
      "UPDATE games SET stats_error = 'fgMade disagrees with the parsed plays'",
    );
    await addGame(fx, "g1-monday", "50 hours");

    const { games } = await problems(fx);

    expect(games[0]?.weekLastKickoff.getTime()).toBeGreaterThan(Date.now() + 40 * 3_600_000);
  });

  it("does not let the week's anchor be computed from the flagged games alone", async () => {
    /*
      **The trap in the obvious implementation, and it was in two of the three
      designs.** A window function evaluates *after* WHERE, so
      `max(kickoff_at) OVER (PARTITION BY season, week)` sees only the rows that
      survived the filter and returns the last *flagged* kickoff.

      On a week where only the Thursday game is flagged that lands almost five
      days early — and in the dangerous direction, reporting a week closed to
      corrections while it is still fully open. Measured against PGlite, not
      reasoned about.
    */
    const fx = await setup();
    await fx.client.query(
      `UPDATE games SET stats_error = 'boom', kickoff_at = now() - interval '96 hours'`,
    );
    await addGame(fx, "g1-later", "2 hours");

    const { games } = await problems(fx);

    // The later fixture is unflagged, so a window function would never see it.
    expect(games[0]?.weekLastKickoff.getTime()).toBeGreaterThan(Date.now());
  });

  it("puts a game with no stats ahead of a newer discrepancy under truncation", async () => {
    /*
      This used to be `ORDER BY kickoff_at DESC` alone, so a page of routine
      warnings pushed the one game whose players all score zero off the end. The
      same argument the work list already makes for its own tiers: under
      truncation, the row that decides money goes first.
    */
    const fx = await setup();
    await fx.client.query(
      `UPDATE games SET stats_error = 'no stats here', stats_synced_at = NULL,
                       stats_attempted_at = now(), kickoff_at = now() - interval '30 hours'`,
    );
    await fx.client.query(
      `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                          kickoff_at, status, final_at, stats_error,
                          stats_synced_at, stats_attempted_at)
       VALUES ($1, 'g1-fresh', $2, $3, 'NYG', 'WAS', now() - interval '4 hours', 'FINAL',
               now() - interval '1 hour', 'a field goal disagrees', now(), now())`,
      [fx.sportId, SEASON, WEEK],
    );

    const { games } = await unresolvedStatsProblems(fx.client, NFL.key, 1);

    expect(games).toHaveLength(1);
    expect(games[0]?.ingest).toBe("NO_STATS");
  });

  it("names the same games the finalisation hold is waiting on", async () => {
    /*
      **The test that would have caught #233 in the first place**, and it is only
      writable because the predicate is now one shared SQL fragment rather than
      three hand-written copies.

      The thing that stops a week settling must be the thing the producer goes
      and fetches, and the thing an operator is shown. Three spellings could
      disagree; one cannot.
    */
    const fx = await setup();
    await fx.client.query(
      `UPDATE games SET stats_synced_at = final_at - interval '2 hours',
                       stats_attempted_at = final_at - interval '2 hours',
                       final_at = now() - interval '3 hours'`,
    );

    const [held] = await fx.client.query<{ unread: number }>(
      `SELECT count(*) FILTER (
                WHERE g.status = 'FINAL'
                  AND (g.stats_synced_at IS NULL
                       OR (g.final_at IS NOT NULL AND g.stats_synced_at < g.final_at))
              )::int AS unread
         FROM games g WHERE g.sport_id = $1`,
      [fx.sportId],
    );

    const { games } = await problems(fx);

    expect(held?.unread).toBe(1);
    expect(games.filter((g) => g.ingest === "NO_STATS")).toHaveLength(1);
  });

  it("keeps the alarm count bounded while the screen's total is not", async () => {
    /*
      A screen may grow; an alarm may not. A game past its window stays listed
      forever — correctly, as evidence that the provider failed — but a heartbeat
      that latches red for a fact nobody can act on stops being read, which is
      the failure this whole page is about.
    */
    const fx = await setup();
    await fx.client.query(
      `UPDATE games SET stats_error = 'Tank01 returned HTTP 503', stats_synced_at = NULL,
                       stats_attempted_at = now(),
                       kickoff_at = now() - interval '200 hours',
                       final_at = now() - interval '199 hours'`,
    );

    const { total, blockingRecent } = await problems(fx);

    expect(total).toBe(1);
    expect(blockingRecent).toBe(0);
  });

  it("raises the alarm while the week can still be corrected", async () => {
    // The control for the bound above.
    const fx = await setup();
    await fx.client.query(
      `UPDATE games SET stats_error = 'Tank01 returned HTTP 503', stats_synced_at = NULL,
                       stats_attempted_at = now(),
                       kickoff_at = now() - interval '10 hours',
                       final_at = now() - interval '7 hours'`,
    );

    expect((await problems(fx)).blockingRecent).toBe(1);
  });
});

describe("the two stamps are one instant — #233", () => {
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it("writes the sync, the attempt and the whistle from a single now()", async () => {
    /*
      **The contract three readers depend on and nobody had written down.**

      `finalizationHold`, the work list's post-final clause and the operator
      screen all compare `stats_synced_at` against `final_at`, and all three read
      "equal" as "this read saw the whistle". That holds only because
      `ingestOneGame`'s success UPDATE assigns them together and Postgres `now()`
      is transaction time.

      Split that statement — a repair script, a writer that stamps the sync
      separately — and every healthy game in the league reads as unread: weeks
      hold that should settle, and the operator screen turns amber for the whole
      slate, which is the noise floor that stops a screen being read at all.

      Strictly equal, with no tolerance. A window would let a genuine failure a
      moment later read as success, and that is the direction that costs a
      settled week.
    */
    const fx = await setup("SCHEDULED");
    const box = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });

    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", box]])), NFL.key, SEASON);

    const [row] = await fx.client.query<{
      stats_synced_at: string;
      stats_attempted_at: string;
      final_at: string;
    }>("SELECT stats_synced_at, stats_attempted_at, final_at FROM games WHERE id = $1", [
      fx.gameId,
    ]);

    expect(row?.stats_attempted_at).toEqual(row?.stats_synced_at);
    expect(row?.final_at).toEqual(row?.stats_synced_at);
  });

  it("leaves a clean ingest out of the stale tier", async () => {
    // The same contract, seen from the reader. If the UPDATE is ever split, this
    // is where it surfaces — as every healthy game on the page going amber.
    const fx = await setup("SCHEDULED");
    const box = boxScore("g1", { qb1: [line("pass_yd", 300)], ...bothDefenses });

    await syncBoxScores(fx.client, fakeProvider(new Map([["g1", box]])), NFL.key, SEASON);

    const { games } = await unresolvedStatsProblems(fx.client, NFL.key, 50);
    expect(games.filter((g) => g.ingest === "STALE")).toEqual([]);
  });
});
