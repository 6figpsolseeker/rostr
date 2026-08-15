import { afterEach, describe, expect, it } from "vitest";
import { NFL } from "@rostr/core";
import type { StatLine } from "@rostr/core";
import type { ProviderBoxScore, StatsProvider } from "@rostr/stats";
import { seedSport } from "./sports.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { syncBoxScores } from "./box-scores.js";

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
): ProviderBoxScore => ({
  gameRef,
  // Deliberately zero, exactly as the real adapter returns them. If the producer
  // trusted these instead of the games row, every assertion below would fail.
  season: 0,
  week: 0,
  players: new Map(Object.entries(players)),
  warnings,
});

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
  const roster: [string, string][] = [
    ["qb1", "QB"],
    ["rb1", "RB"],
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
    await fx.client.query("UPDATE games SET stats_synced_at = now() - interval '2 days'");

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

    await fx.client.query("UPDATE games SET stats_synced_at = now() - interval '2 days'");
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

    await fx.client.query("UPDATE games SET stats_synced_at = now() - interval '2 days'");
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

    await fx.client.query("UPDATE games SET stats_synced_at = now() - interval '2 days'");
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
    expect(result.failures[0]?.reason).toContain("def_pts_allowed");

    const [row] = await fx.client.query<{ stats_error: string | null }>(
      "SELECT stats_error FROM games WHERE id = $1",
      [fx.gameId],
    );
    expect(row?.stats_error).toContain("DST_PHI");
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

  it("leaves a scheduled game alone", async () => {
    const fx = await setup("SCHEDULED");
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
      "UPDATE games SET kickoff_at = now() - interval '30 hours', stats_synced_at = now()",
    );

    const result = await syncBoxScores(fx.client, fakeProvider(new Map()), NFL.key, SEASON);

    expect(result.games).toBe(0);
  });

  it("still reads a game that is genuinely in progress", async () => {
    // The control. Without it the test above passes just as well against a rule
    // that never treats anything as live.
    const fx = await setup("IN_PROGRESS");
    await fx.client.query(
      "UPDATE games SET kickoff_at = now() - interval '2 hours', stats_synced_at = now()",
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
    const fx = await setup();
    await fx.client.query(
      `UPDATE games SET stats_error = 'fgMade disagrees with the parsed plays',
                       stats_synced_at = now() - interval '1 hour',
                       final_at = now() - interval '9 days'`,
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
