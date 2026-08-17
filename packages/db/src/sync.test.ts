import { afterEach, describe, expect, it } from "vitest";
import { NFL } from "@rostr/core";
import type {
  ProviderBoxScore,
  ProviderGame,
  ProviderHealth,
  ProviderInjury,
  ProviderPlayer,
} from "@rostr/stats";
import {
  loadDraftBoard,
  loadProjections,
  syncByeWeeks,
  syncGames,
  syncPlayers,
  syncProjections,
  syncRankings,
} from "./sync.js";
import type { AdpCapableProvider, ProjectionCapableProvider } from "./sync.js";
import { seedSport } from "./sports.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

/**
 * A provider with no network behind it.
 *
 * The sync logic never learns which provider it is talking to, which is what
 * makes this possible — and what makes swapping providers a one-file change.
 */
class FakeProvider implements AdpCapableProvider {
  readonly name = "fake";

  constructor(
    private players: ProviderPlayer[] = [],
    private games: ProviderGame[] = [],
    private adp: {
      externalRef: string;
      fullName: string;
      overallMilli: number;
      positionRank: string | null;
    }[] = [],
    private adpDate = "2026-08-05",
  ) {}

  healthCheck(): Promise<ProviderHealth> {
    return Promise.resolve({ ok: true, provider: this.name, detail: "fake" });
  }
  listPlayers(): Promise<readonly ProviderPlayer[]> {
    return Promise.resolve(this.players);
  }
  listGames(): Promise<readonly ProviderGame[]> {
    return Promise.resolve(this.games);
  }
  getBoxScore(): Promise<ProviderBoxScore> {
    throw new Error("not used");
  }
  listInjuries(): Promise<readonly ProviderInjury[]> {
    return Promise.resolve([]);
  }
  listAdp(): Promise<{
    asOf: string;
    rankingType: string;
    entries: readonly {
      externalRef: string;
      fullName: string;
      overallMilli: number;
      positionRank: string | null;
    }[];
  }> {
    return Promise.resolve({ asOf: this.adpDate, rankingType: "PPR", entries: this.adp });
  }

  setPlayers(players: ProviderPlayer[]): void {
    this.players = players;
  }
  setAdp(
    adp: {
      externalRef: string;
      fullName: string;
      overallMilli: number;
      positionRank: string | null;
    }[],
    date?: string,
  ): void {
    this.adp = adp;
    if (date) this.adpDate = date;
  }
}

const player = (ref: string, name: string, position: string, team = "PHI"): ProviderPlayer => ({
  externalRef: ref,
  fullName: name,
  positions: [position],
  teamRef: team,
  active: true,
});

async function fresh(): Promise<PGliteClient> {
  db = await createTestDatabase();
  await seedSport(db, NFL);
  return db;
}

describe("syncPlayers", () => {
  it("inserts players", async () => {
    const client = await fresh();
    const provider = new FakeProvider([
      player("1", "Jalen Hurts", "QB"),
      player("2", "Saquon Barkley", "RB"),
    ]);

    const result = await syncPlayers(client, provider, "nfl", 2026);
    expect(result).toMatchObject({ inserted: 2, updated: 0, skipped: 0 });
  });

  it("is idempotent — a re-run updates rather than duplicating", async () => {
    // Syncs run on a schedule and re-run after failures. Duplicating a player
    // pool on retry would corrupt drafts quietly.
    const client = await fresh();
    const provider = new FakeProvider([player("1", "Jalen Hurts", "QB")]);

    await syncPlayers(client, provider, "nfl", 2026);
    const second = await syncPlayers(client, provider, "nfl", 2026);

    expect(second).toMatchObject({ inserted: 0, updated: 1 });

    const [row] = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM players",
    );
    expect(Number(row?.count)).toBe(1);
  });

  it("updates a player who changed team", async () => {
    const client = await fresh();
    const provider = new FakeProvider([player("1", "Saquon Barkley", "RB", "NYG")]);
    await syncPlayers(client, provider, "nfl", 2026);

    provider.setPlayers([player("1", "Saquon Barkley", "RB", "PHI")]);
    await syncPlayers(client, provider, "nfl", 2026);

    const [row] = await client.query<{ team_ref: string }>(
      "SELECT team_ref FROM players WHERE external_ref = '1'",
    );
    expect(row?.team_ref).toBe("PHI");
  });

  it("skips a position the sport does not define rather than failing", async () => {
    // A provider adding a position we do not model should not stop the other
    // players from syncing.
    const client = await fresh();
    const provider = new FakeProvider([
      player("1", "Jalen Hurts", "QB"),
      player("99", "Some Linebacker", "LB"),
    ]);

    const result = await syncPlayers(client, provider, "nfl", 2026);
    expect(result).toMatchObject({ inserted: 1, skipped: 1 });
  });

  it("records team defenses as rosterable players", async () => {
    const client = await fresh();
    const provider = new FakeProvider([player("DST_PHI", "Philadelphia Eagles", "DEF")]);

    await syncPlayers(client, provider, "nfl", 2026);

    const [row] = await client.query<{ full_name: string; key: string }>(
      `SELECT p.full_name, pos.key
         FROM players p JOIN positions pos ON pos.id = p.primary_position_id
        WHERE p.external_ref = 'DST_PHI'`,
    );
    expect(row?.key).toBe("DEF");
  });
});

describe("syncGames", () => {
  const game = (ref: string, week: number, kickoff: number): ProviderGame => ({
    externalRef: ref,
    season: 2026,
    week,
    homeTeamRef: "PHI",
    awayTeamRef: "DAL",
    kickoffAt: kickoff,
    kickoffTbd: kickoff <= 0,
    gameDate: null,
    status: "SCHEDULED",
  });

  /** A fixture the NFL has dated but not timed, as Tank01 actually sends it. */
  const undated = (ref: string, week: number, date: string): ProviderGame => ({
    ...game(ref, week, 0),
    gameDate: date,
  });

  const dated = (ref: string, week: number, kickoff: number, date: string): ProviderGame => ({
    ...game(ref, week, kickoff),
    gameDate: date,
  });

  it("inserts games", async () => {
    const client = await fresh();
    const provider = new FakeProvider([], [game("g1", 1, 1_757_031_600)]);

    expect(await syncGames(client, provider, "nfl", 2026)).toMatchObject({ inserted: 1 });
  });

  it("skips a game with no kickoff time and no dated sibling", async () => {
    // kickoffAt drives lineup locks and every scheduled job. Storing zero would
    // lock lineups at the epoch, and with nothing on the same date there is no
    // conservative time to stand in for it.
    const client = await fresh();
    const provider = new FakeProvider([], [game("g1", 1, 0)]);

    expect(await syncGames(client, provider, "nfl", 2026)).toMatchObject({
      inserted: 0,
      skipped: 1,
    });
  });

  describe("a fixture the NFL has dated but not timed", () => {
    // The live case: weeks 16 and 17 were each four games short because the
    // kickoff hour was pending, in the two weeks that decide a championship.
    const SUNDAY_1PM = 1_798_988_400;
    const SUNDAY_820PM = 1_798_914_000 + 98_400;

    it("stores it, using the earliest kickoff known on the same date", async () => {
      const client = await fresh();
      const provider = new FakeProvider(
        [],
        [
          dated("early", 16, SUNDAY_1PM, "20261227"),
          dated("late", 16, SUNDAY_820PM, "20261227"),
          undated("pending", 16, "20261227"),
        ],
      );

      expect(await syncGames(client, provider, "nfl", 2026)).toMatchObject({
        inserted: 3,
        skipped: 0,
      });

      const [row] = await client.query<{ kickoff_at: string; kickoff_tbd: boolean }>(
        "SELECT kickoff_at, kickoff_tbd FROM games WHERE external_ref = 'pending'",
      );
      expect(row?.kickoff_tbd).toBe(true);
      // The earliest, not the latest: a slot that locks early costs a manager
      // flexibility, where one that locks late lets them start a player they
      // have already watched score.
      expect(Math.floor(new Date(row!.kickoff_at).getTime() / 1000)).toBe(SUNDAY_1PM);
    });

    it("does not mark a properly timed game as provisional", async () => {
      const client = await fresh();
      const provider = new FakeProvider(
        [],
        [dated("early", 16, SUNDAY_1PM, "20261227"), undated("pending", 16, "20261227")],
      );
      await syncGames(client, provider, "nfl", 2026);

      const [row] = await client.query<{ kickoff_tbd: boolean }>(
        "SELECT kickoff_tbd FROM games WHERE external_ref = 'early'",
      );
      expect(row?.kickoff_tbd).toBe(false);
    });

    it("will not borrow a time from a different date", async () => {
      // Thursday's kickoff is no evidence about Sunday's game, and standing it
      // in would lock the Sunday slot three days early.
      const client = await fresh();
      const provider = new FakeProvider(
        [],
        [
          dated("thursday", 16, SUNDAY_1PM - 3 * 86_400, "20261224"),
          undated("pending", 16, "20261227"),
        ],
      );

      expect(await syncGames(client, provider, "nfl", 2026)).toMatchObject({
        inserted: 1,
        skipped: 1,
      });
    });

    it("clears the flag once the real time arrives", async () => {
      const client = await fresh();
      const first = new FakeProvider(
        [],
        [dated("early", 16, SUNDAY_1PM, "20261227"), undated("pending", 16, "20261227")],
      );
      await syncGames(client, first, "nfl", 2026);

      const second = new FakeProvider(
        [],
        [
          dated("early", 16, SUNDAY_1PM, "20261227"),
          dated("pending", 16, SUNDAY_820PM, "20261227"),
        ],
      );
      await syncGames(client, second, "nfl", 2026);

      const [row] = await client.query<{ kickoff_at: string; kickoff_tbd: boolean }>(
        "SELECT kickoff_at, kickoff_tbd FROM games WHERE external_ref = 'pending'",
      );
      expect(row?.kickoff_tbd).toBe(false);
      expect(Math.floor(new Date(row!.kickoff_at).getTime() / 1000)).toBe(SUNDAY_820PM);
    });
  });

  it("is idempotent and updates status", async () => {
    const client = await fresh();
    const scheduled = game("g1", 1, 1_757_031_600);
    const provider = new FakeProvider([], [scheduled]);
    await syncGames(client, provider, "nfl", 2026);

    const finished = new FakeProvider([], [{ ...scheduled, status: "FINAL" }]);
    const result = await syncGames(client, finished, "nfl", 2026);

    expect(result).toMatchObject({ inserted: 0, updated: 1 });

    const [row] = await client.query<{ status: string }>(
      "SELECT status FROM games WHERE external_ref = 'g1'",
    );
    expect(row?.status).toBe("FINAL");
  });
});

describe("syncRankings", () => {
  it("stores the draft board", async () => {
    const client = await fresh();
    const provider = new FakeProvider([
      player("1", "Jahmyr Gibbs", "RB"),
      player("2", "Bijan Robinson", "RB"),
    ]);
    await syncPlayers(client, provider, "nfl", 2026);

    provider.setAdp([
      { externalRef: "1", fullName: "Jahmyr Gibbs", overallMilli: 3200, positionRank: "RB1" },
      { externalRef: "2", fullName: "Bijan Robinson", overallMilli: 3400, positionRank: "RB2" },
    ]);

    const result = await syncRankings(client, provider, "nfl", 2026);
    expect(result).toMatchObject({ inserted: 2, skipped: 0, asOf: "2026-08-05" });
  });

  it("skips a ranked player we have never seen", async () => {
    // The provider ranks players our player list may not carry. Inventing a row
    // would create a draftable player with no position.
    const client = await fresh();
    const provider = new FakeProvider([]);
    provider.setAdp([
      { externalRef: "ghost", fullName: "Nobody", overallMilli: 1000, positionRank: "RB1" },
    ]);

    expect(await syncRankings(client, provider, "nfl", 2026)).toMatchObject({ skipped: 1 });
  });

  it("keeps rankings per date rather than overwriting", async () => {
    // ADP moves daily through the preseason. A draft should stay explicable
    // from the board as it stood that day.
    const client = await fresh();
    const provider = new FakeProvider([player("1", "Jahmyr Gibbs", "RB")]);
    await syncPlayers(client, provider, "nfl", 2026);

    provider.setAdp(
      [{ externalRef: "1", fullName: "Jahmyr Gibbs", overallMilli: 3200, positionRank: "RB1" }],
      "2026-08-01",
    );
    await syncRankings(client, provider, "nfl", 2026);

    provider.setAdp(
      [{ externalRef: "1", fullName: "Jahmyr Gibbs", overallMilli: 2100, positionRank: "RB1" }],
      "2026-08-05",
    );
    await syncRankings(client, provider, "nfl", 2026);

    const rows = await client.query<{ as_of: string; overall_milli: number }>(
      "SELECT as_of, overall_milli FROM player_rankings ORDER BY as_of",
    );
    expect(rows).toHaveLength(2);

    // The current view takes the latest.
    const [current] = await client.query<{ overall_milli: number }>(
      "SELECT overall_milli FROM player_rankings_current",
    );
    expect(current?.overall_milli).toBe(2100);
  });
});

describe("syncByeWeeks", () => {
  it("records a bye week against every player on the team", async () => {
    const client = await fresh();
    const provider = new FakeProvider([
      player("1", "Jalen Hurts", "QB", "PHI"),
      player("2", "Dak Prescott", "QB", "DAL"),
    ]);
    await syncPlayers(client, provider, "nfl", 2026);

    await syncByeWeeks(client, "nfl", 2026, new Map([["PHI", 14]]));

    const rows = await client.query<{ bye_week: number; external_ref: string }>(
      `SELECT ps.bye_week, p.external_ref
         FROM player_seasons ps JOIN players p ON p.id = ps.player_id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.external_ref).toBe("1");
    expect(Number(rows[0]?.bye_week)).toBe(14);
  });
});

describe("loadDraftBoard", () => {
  it("orders by ranking, unranked players last", async () => {
    const client = await fresh();
    const provider = new FakeProvider([
      player("1", "Jahmyr Gibbs", "RB"),
      player("2", "Bijan Robinson", "RB"),
      player("3", "Unranked Guy", "WR"),
    ]);
    await syncPlayers(client, provider, "nfl", 2026);

    provider.setAdp([
      { externalRef: "2", fullName: "Bijan Robinson", overallMilli: 1500, positionRank: "RB1" },
      { externalRef: "1", fullName: "Jahmyr Gibbs", overallMilli: 3200, positionRank: "RB2" },
    ]);
    await syncRankings(client, provider, "nfl", 2026);

    const board = await loadDraftBoard(client, "nfl", 2026);

    expect(board.map((entry) => entry.fullName)).toEqual([
      "Bijan Robinson",
      "Jahmyr Gibbs",
      "Unranked Guy",
    ]);
  });

  it("produces dense ranks the draft engine can use directly", async () => {
    const client = await fresh();
    const provider = new FakeProvider([
      player("1", "A", "RB"),
      player("2", "B", "RB"),
      player("3", "C", "WR"),
    ]);
    await syncPlayers(client, provider, "nfl", 2026);

    const board = await loadDraftBoard(client, "nfl", 2026);
    expect(board.map((entry) => entry.rank)).toEqual([1, 2, 3]);
  });

  it("keeps unranked players draftable", async () => {
    // A late flier on someone unranked is a legitimate pick, not an error.
    const client = await fresh();
    const provider = new FakeProvider([player("1", "Nobody Ranked", "WR")]);
    await syncPlayers(client, provider, "nfl", 2026);

    expect(await loadDraftBoard(client, "nfl", 2026)).toHaveLength(1);
  });

  it("carries positions, so the engine can check slot eligibility", async () => {
    const client = await fresh();
    const provider = new FakeProvider([player("1", "Jalen Hurts", "QB")]);
    await syncPlayers(client, provider, "nfl", 2026);

    const [entry] = await loadDraftBoard(client, "nfl", 2026);
    expect(entry?.positions).toContain("QB");
  });
});

/**
 * Projections, season and weekly.
 *
 * These exist because the projection sync had **no coverage at all** until
 * migration 0015 changed the primary key — and an `ON CONFLICT` target that no
 * longer matches a constraint is not a subtle failure, Postgres refuses the
 * statement outright. It would have shipped, because nothing ran it.
 */
class FakeProjectionProvider implements ProjectionCapableProvider {
  readonly name = "fake";

  constructor(
    private season: ProviderProjectionish[] = [],
    private weekly: Record<number, ProviderProjectionish[]> = {},
  ) {}

  listSeasonProjections(): Promise<readonly ProviderProjectionish[]> {
    return Promise.resolve(this.season);
  }

  listWeekProjections(
    _season: number,
    week: number,
  ): Promise<readonly ProviderProjectionish[]> {
    return Promise.resolve(this.weekly[week] ?? []);
  }
}

type ProviderProjectionish = {
  externalRef: string;
  fullName: string;
  position: string;
  stats: { statKey: string; value: number }[];
};

const projection = (
  ref: string,
  name: string,
  stats: { statKey: string; value: number }[],
): ProviderProjectionish => ({ externalRef: ref, fullName: name, position: "RB", stats });

describe("syncProjections", () => {
  it("stores season totals under week 0", async () => {
    const client = await fresh();
    const players = new FakeProvider([player("1", "Jahmyr Gibbs", "RB")]);
    await syncPlayers(client, players, "nfl", 2026);

    const provider = new FakeProjectionProvider([
      projection("1", "Jahmyr Gibbs", [
        { statKey: "rush_yd", value: 1231 },
        { statKey: "rush_td", value: 11 },
      ]),
    ]);

    expect(await syncProjections(client, provider, "nfl", 2026)).toMatchObject({ inserted: 2 });

    // The fake provider stamps 'fake', so the read has to name it — the default
    // is the real provider, deliberately, so a caller who forgets gets nothing
    // rather than everything.
    const loaded = await loadProjections(client, "nfl", 2026, "fake");
    expect(loaded.size).toBe(1);
  });

  it("stores a week separately from the season, for the same player", async () => {
    const client = await fresh();
    const players = new FakeProvider([player("1", "Jahmyr Gibbs", "RB")]);
    await syncPlayers(client, players, "nfl", 2026);

    const provider = new FakeProjectionProvider(
      [projection("1", "Jahmyr Gibbs", [{ statKey: "rush_yd", value: 1231 }])],
      { 3: [projection("1", "Jahmyr Gibbs", [{ statKey: "rush_yd", value: 78 }])] },
    );

    await syncProjections(client, provider, "nfl", 2026);
    await syncProjections(client, provider, "nfl", 2026, 3);

    // The season projection is what the draft board reads; the week is what the
    // autofill ranks on. One must not overwrite the other.
    const season = await loadProjections(client, "nfl", 2026, "fake");
    const week3 = await loadProjections(client, "nfl", 2026, "fake", 3);

    expect(season.get([...season.keys()][0]!)?.[0]?.value).toBe(1231);
    expect(week3.get([...week3.keys()][0]!)?.[0]?.value).toBe(78);
  });

  it("re-runs as an update rather than a duplicate", async () => {
    // The ON CONFLICT target has to match the primary key exactly. When 0015
    // added `week` to the key and this was not updated, Postgres rejected the
    // whole statement — so a re-run is the thing worth asserting.
    const client = await fresh();
    const players = new FakeProvider([player("1", "Jahmyr Gibbs", "RB")]);
    await syncPlayers(client, players, "nfl", 2026);

    const provider = new FakeProjectionProvider([], {
      3: [projection("1", "Jahmyr Gibbs", [{ statKey: "rush_yd", value: 78 }])],
    });

    expect(await syncProjections(client, provider, "nfl", 2026, 3)).toMatchObject({
      inserted: 1,
    });
    expect(await syncProjections(client, provider, "nfl", 2026, 3)).toMatchObject({
      inserted: 0,
      updated: 1,
    });
  });

  it("skips a projected player we have never seen", async () => {
    const client = await fresh();
    const provider = new FakeProjectionProvider([], {
      3: [projection("ghost", "Nobody", [{ statKey: "rush_yd", value: 10 }])],
    });

    const result = await syncProjections(client, provider, "nfl", 2026, 3);
    expect(result.unmatched).toEqual(["Nobody"]);
  });
});
