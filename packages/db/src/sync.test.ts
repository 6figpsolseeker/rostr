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
import { Tank01Provider } from "@rostr/stats";
import { PRIMARY_RANKING_BOARD } from "./sync.js";
import { PRIMARY_PROJECTION_SOURCE, PRIMARY_STAT_SOURCE } from "./lineups.js";
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
  /**
   * **The production constant, not `"fake"` — and this is load-bearing.**
   *
   * `syncRankings` writes `source = provider.name`, and `loadDraftBoard` now
   * filters on `PRIMARY_RANKING_BOARD.source`. A fixture writing `"fake"` would
   * have sent every `loadDraftBoard` test red, and the smallest repair — passing
   * `{ source: "fake" }` at each call site — would have left the default that
   * all ten real call sites take with **zero** coverage. The fix would have been
   * tested only on the path nobody uses.
   *
   * This is fixture realism, *not* the guard against the constant drifting from
   * `Tank01Provider.name`: asserting it here would compare the constant to
   * itself. That guard imports the real adapter — see the test named for it.
   */
  readonly name = PRIMARY_RANKING_BOARD.source;

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
    /**
     * What the provider spells back, when it disagrees with what we asked.
     * Null means it echoes the request, which is Tank01's measured behaviour.
     */
    private adpEcho: string | null = null,
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
  listAdp(rankingType: string = PRIMARY_RANKING_BOARD.rankingType): Promise<{
    asOf: string;
    rankingTypeEcho: string;
    entries: readonly {
      externalRef: string;
      fullName: string;
      overallMilli: number;
      positionRank: string | null;
    }[];
  }> {
    // Echoes the request by default, which is what Tank01 does. The override
    // exists so a test can make the vendor disagree — the case that used to be
    // written straight into `ranking_type`.
    return Promise.resolve({
      asOf: this.adpDate,
      rankingTypeEcho: this.adpEcho ?? rankingType,
      entries: this.adp,
    });
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

/**
 * The profile block, all absent.
 *
 * Spread into the fixture rather than written out, so a field added to
 * `ProviderPlayerProfile` does not need touching in every test that happens to
 * build a player.
 */
const NO_PROFILE = {
  imageUrl: null,
  jerseyNumber: null,
  heightInches: null,
  weightPounds: null,
  birthDate: null,
  college: null,
  draft: null,
  injury: null,
} as const;

const player = (
  ref: string,
  name: string,
  position: string,
  team = "PHI",
  profile: ProviderPlayer["profile"] = null,
  secondSourceRef: string | null = null,
): ProviderPlayer => ({
  externalRef: ref,
  fullName: name,
  positions: [position],
  teamRef: team,
  active: true,
  profile,
  secondSourceRef,
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

describe("syncPlayers — the profile block", () => {
  const hurts = {
    ...NO_PROFILE,
    imageUrl: "https://example.test/hurts.png",
    jerseyNumber: "1",
    heightInches: 73,
    weightPounds: 223,
    birthDate: "1998-08-07",
    college: "Oklahoma",
    draft: { year: 2020, round: 2, pick: 53 },
  } as const;

  it("stores what the provider published", async () => {
    const client = await fresh();
    await syncPlayers(
      client,
      new FakeProvider([player("1", "Jalen Hurts", "QB", "PHI", hurts)]),
      "nfl",
      2026,
    );

    const [row] = await client.query<{
      image_url: string | null;
      jersey_number: string | null;
      height_inches: number | null;
      weight_pounds: number | null;
      college: string | null;
      draft_round: number | null;
    }>(
      `SELECT image_url, jersey_number, height_inches, weight_pounds, college, draft_round
         FROM players WHERE external_ref = '1'`,
    );

    expect(row).toMatchObject({
      image_url: "https://example.test/hurts.png",
      jersey_number: "1",
      height_inches: 73,
      weight_pounds: 223,
      college: "Oklahoma",
      draft_round: 2,
    });
  });

  it("clears an injury that has cleared", async () => {
    // The failure this exists to prevent is a designation that sticks: a player
    // marked Questionable in October who is still labelled that way in January
    // because the update only ever wrote non-null values. Within a published
    // profile a null is an assertion, and it has to reach the column.
    const client = await fresh();
    const hurt = {
      ...hurts,
      injury: { designation: "Questionable", description: "Ankle", returnDate: null },
    } as const;

    await syncPlayers(
      client,
      new FakeProvider([player("1", "J. Hurts", "QB", "PHI", hurt)]),
      "nfl",
      2026,
    );
    await syncPlayers(
      client,
      new FakeProvider([player("1", "J. Hurts", "QB", "PHI", hurts)]),
      "nfl",
      2026,
    );

    const [row] = await client.query<{ designation: string | null }>(
      "SELECT injury_designation AS designation FROM players WHERE external_ref = '1'",
    );
    expect(row?.designation).toBeNull();
  });

  it("leaves the stored profile alone when a provider publishes none", async () => {
    // A provider with no profile data is stating *no opinion*, not "this player
    // has no face". Without the guard, a players sync run from a second source
    // would blank every headshot in the database and nothing would report it.
    const client = await fresh();

    await syncPlayers(
      client,
      new FakeProvider([player("1", "Jalen Hurts", "QB", "PHI", hurts)]),
      "nfl",
      2026,
    );
    await syncPlayers(
      client,
      new FakeProvider([player("1", "Jalen Hurts", "QB", "PHI", null)]),
      "nfl",
      2026,
    );

    const [row] = await client.query<{ image_url: string | null; college: string | null }>(
      "SELECT image_url, college FROM players WHERE external_ref = '1'",
    );
    expect(row).toMatchObject({
      image_url: "https://example.test/hurts.png",
      college: "Oklahoma",
    });
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
  it("defaults to the source the real adapter actually writes — #307", () => {
    /*
      **The whole guard, and it has to be a test because no compiler can be
      one.** `@rostr/stats` depends only on `@rostr/core`, so `adapter.ts`
      cannot import `PRIMARY_RANKING_BOARD` from `@rostr/db` — the dependency
      arrow forbids it. Two string literals in two packages, and nothing
      structural holding them together.

      What happens if they drift: `syncRankings` writes `source = provider.name`
      and `loadDraftBoard` filters on the constant, so a rename in the adapter
      makes the LEFT JOIN match nothing. Every `overall_milli` comes back null,
      the board falls through to its `p.full_name` tiebreak, and 1,589 players
      render alphabetically with an em dash where the ADP was. Nothing in
      production notices — not a type, not the row count, not a cron, not
      `cronHealth` — and the room's own tooltip explains each blank away as a
      player nobody ranks. On a draft day that is unrecoverable in-room.

      Asserted against the **real** provider, deliberately. `FakeProvider.name`
      is set from this same constant for fixture realism, so asserting there
      would compare the constant to itself and prove nothing.

      The sibling constants carry the identical latent drift and are covered
      here rather than left for the next person to discover separately.
    */
    const tank01 = new Tank01Provider({ apiKey: "not-used-no-call-is-made" });

    expect(tank01.name).toBe(PRIMARY_RANKING_BOARD.source);
    expect(tank01.name).toBe(PRIMARY_PROJECTION_SOURCE);
    expect(tank01.name).toBe(PRIMARY_STAT_SOURCE);
  });

  it("orders by ranking, unranked players last", async () => {
    /*
      **The ADPs are deliberately the opposite way round from the names.**

      This test used to give the best ADP to Bijan Robinson, so the expected
      order read `["Bijan Robinson", "Jahmyr Gibbs", "Unranked Guy"]` — which is
      also alphabetical order. The `ORDER BY` is
      `r.overall_milli NULLS LAST, p.full_name`, so a query that matched *no*
      rankings at all would fall through to the name tiebreak and produce the
      same array. The repo's headline ordering test passed whether the ranking
      join worked or not.

      That is not hypothetical. The join filters on `source` and
      `ranking_type`, and a default that stops matching what `syncRankings`
      writes returns a full board of null ADPs — alphabetical, every ADP blank,
      and nothing in production notices. This test is the cheapest place to
      catch it, so the fixture now makes alphabetical order and ranked order
      disagree.
    */
    const client = await fresh();
    const provider = new FakeProvider([
      player("1", "Jahmyr Gibbs", "RB"),
      player("2", "Bijan Robinson", "RB"),
      player("3", "Unranked Guy", "WR"),
    ]);
    await syncPlayers(client, provider, "nfl", 2026);

    provider.setAdp([
      { externalRef: "1", fullName: "Jahmyr Gibbs", overallMilli: 1500, positionRank: "RB1" },
      { externalRef: "2", fullName: "Bijan Robinson", overallMilli: 3200, positionRank: "RB2" },
    ]);
    await syncRankings(client, provider, "nfl", 2026);

    const board = await loadDraftBoard(client, "nfl", 2026);

    // Gibbs first on ADP, Robinson second — the reverse of both alphabetical
    // order and the order they were declared in.
    expect(board.map((entry) => entry.fullName)).toEqual([
      "Jahmyr Gibbs",
      "Bijan Robinson",
      "Unranked Guy",
    ]);
  });

  it("returns one entry per player when a second ranking source exists — #307", async () => {
    /*
      **The filed bug.** The join read `r.source = COALESCE($3, r.source)`,
      which degrades to `r.source = r.source` when the argument is omitted — and
      all ten call sites in this repo omit it. `player_rankings_current` is
      `DISTINCT ON (player_id, season, source, ranking_type)`, so a second
      source survives the view, and `r.overall_milli` is a `GROUP BY` key, so
      the grouping does not collapse it either.

      The player came back twice, at two different ADPs, and `rank` stopped
      meaning "the Nth best player". Downstream both pool Maps are keyed on
      `playerId`, so they silently kept whichever row landed last — which,
      ordered ascending by ADP, is the **worse** one.

      The second vendor goes in by raw INSERT on purpose: `syncRankings` writes
      `source = provider.name`, so there is no way through the provider seam to
      write a second source with one fixture instance.

      Note the symptom was value-dependent, which is what would have made it
      expensive to diagnose in a live room: two vendors publishing an *identical*
      ADP collapse through the `GROUP BY`, so a second source duplicates most
      players and silently not the ones the vendors agree on.
    */
    const client = await fresh();
    const provider = new FakeProvider([player("1", "Two Source Man", "RB")]);
    await syncPlayers(client, provider, "nfl", 2026);

    provider.setAdp([
      { externalRef: "1", fullName: "Two Source Man", overallMilli: 1000, positionRank: "RB1" },
    ]);
    await syncRankings(client, provider, "nfl", 2026);

    await client.query(
      `INSERT INTO player_rankings
         (player_id, season, source, ranking_type, overall_milli, position_rank, as_of)
       SELECT id, 2026, 'other-vendor', 'PPR', 2000, 'RB2', '2026-08-06'::date
         FROM players WHERE external_ref = '1'`,
    );

    const board = await loadDraftBoard(client, "nfl", 2026);

    expect(board).toHaveLength(1);
    // Ours, not the other vendor's — the filter keeps the number attributable.
    expect(board[0]?.adpMilli).toBe(1000);
  });

  it("ignores a second ranking_type rather than duplicating or displacing", async () => {
    /*
      The other half of the same `COALESCE`. `syncRankings`' fifth parameter is
      public — `syncRankings(client, provider, "nfl", 2026, "HALF")` — so a HALF
      board can be written alongside the PPR one by anyone, with no error.

      Invisible to the board rather than blended into it, deliberately. A
      fallback that surfaced these rows for players PPR does not rank would mix
      two scoring formats into one ADP column with nothing on screen saying so,
      which is the reason a preference-with-fallback join was considered for
      #307 and rejected.
    */
    const client = await fresh();
    const provider = new FakeProvider([player("1", "Both Formats", "RB")]);
    await syncPlayers(client, provider, "nfl", 2026);

    provider.setAdp([
      { externalRef: "1", fullName: "Both Formats", overallMilli: 1000, positionRank: "RB1" },
    ]);
    await syncRankings(client, provider, "nfl", 2026);

    provider.setAdp([
      { externalRef: "1", fullName: "Both Formats", overallMilli: 9000, positionRank: "RB9" },
    ]);
    await syncRankings(client, provider, "nfl", 2026, "HALF");

    const [stored] = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM player_rankings WHERE ranking_type = 'HALF'",
    );
    expect(Number(stored?.count)).toBe(1);

    const board = await loadDraftBoard(client, "nfl", 2026);
    expect(board).toHaveLength(1);
    expect(board[0]?.adpMilli).toBe(1000);
  });

  it("stores the ranking type we asked for, not the provider's echo — #307", async () => {
    /*
      **The root cause, and the reason the default above is safe to hard-code.**

      `syncRankings` used to store `board.rankingType`, which the adapter
      computes as `raw.adpType ?? rankingType` — the vendor's own spelling,
      written verbatim into a key column the loader matches exactly. Tank01
      answering `"ppr"` one morning would have split every player across two
      ranking types: under the old `COALESCE` that returned each of them twice,
      and under any hard default it would blank the board outright.

      A reader with a fixed default can only be right if the writer cannot write
      something else. Now it cannot.
    */
    const client = await fresh();
    const provider = new FakeProvider(
      [player("1", "Echo Test", "RB")],
      [],
      [{ externalRef: "1", fullName: "Echo Test", overallMilli: 1000, positionRank: "RB1" }],
      "2026-08-05",
      "ppr-lowercase-surprise",
    );
    await syncPlayers(client, provider, "nfl", 2026);

    const result = await syncRankings(client, provider, "nfl", 2026);

    const [stored] = await client.query<{ ranking_type: string }>(
      "SELECT ranking_type FROM player_rankings LIMIT 1",
    );
    expect(stored?.ranking_type).toBe("PPR");

    // Reported rather than swallowed — normalising discards information, and a
    // vendor that has changed its vocabulary is something to go and look at.
    expect(result.rankingTypeEcho).toBe("ppr-lowercase-surprise");

    // And the board still ranks him, which is the point of storing ours.
    const board = await loadDraftBoard(client, "nfl", 2026);
    expect(board[0]?.adpMilli).toBe(1000);
  });

  it("says nothing when the provider echoes what we asked", async () => {
    // The control. A non-null echo reaches `cron_runs.last_outcome`, and
    // `cronJobState` reads any non-null outcome as FAILING — so a value here on
    // the ordinary path would pin season-sync red for ever and switch off its
    // own staleness detection. That is #325, exactly.
    const client = await fresh();
    const provider = new FakeProvider([player("1", "Normal", "RB")]);
    await syncPlayers(client, provider, "nfl", 2026);
    provider.setAdp([
      { externalRef: "1", fullName: "Normal", overallMilli: 1000, positionRank: "RB1" },
    ]);

    const result = await syncRankings(client, provider, "nfl", 2026);
    expect(result.rankingTypeEcho).toBeNull();
  });

  it("returns a full board of nulls when the source matches nothing, and never throws", async () => {
    /*
      The catastrophic shape, pinned as a decision rather than left to be
      discovered. A wrong default does not error — it is a LEFT JOIN, so all the
      players still come back, `rank` falls through to the `p.full_name`
      tiebreak, and every ADP is null.

      **Deliberately not a throw.** `season-sync` runs players, then games, then
      rankings, so a board with players and no rankings is reachable in the
      ordinary course of every run — and a throw here would be a draft-day
      outage manufactured by the repair for #307.
    */
    const client = await fresh();
    const provider = new FakeProvider([
      player("1", "Zebra Last", "RB"),
      player("2", "Alpha First", "RB"),
    ]);
    await syncPlayers(client, provider, "nfl", 2026);
    provider.setAdp([
      { externalRef: "1", fullName: "Zebra Last", overallMilli: 1000, positionRank: "RB1" },
    ]);
    await syncRankings(client, provider, "nfl", 2026);

    const board = await loadDraftBoard(client, "nfl", 2026, {
      source: "a-vendor-we-never-synced",
      rankingType: "PPR",
    });

    expect(board).toHaveLength(2);
    expect(board.map((entry) => entry.adpMilli)).toEqual([null, null]);
    // Alphabetical, which is the tell. The ranked player is no longer first.
    expect(board.map((entry) => entry.fullName)).toEqual(["Alpha First", "Zebra Last"]);
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

  it("keeps a player his club has cut on the board", async () => {
    /*
      He used to be filtered out, and that quietly decided a rules question the
      owner had not been asked: a drafted player cut overnight vanished from the
      room rendering his name (#275) while `addFreeAgent` went on accepting him,
      because `availabilityOf` has never read this column. Ruled 2026-09-16:
      he stays acquirable.
    */
    const client = await fresh();
    const provider = new FakeProvider([player("1", "Cut Loose", "RB")]);
    await syncPlayers(client, provider, "nfl", 2026);
    await client.query("UPDATE players SET active = false");

    const board = await loadDraftBoard(client, "nfl", 2026);

    expect(board.map((entry) => entry.fullName)).toEqual(["Cut Loose"]);
    expect(board[0]?.active).toBe(false);
  });

  it("runs a cut player at his own ADP, not at the bottom — owner, 2026-09-22", async () => {
    /*
      **This test used to assert the opposite, and the fixture is unchanged
      because it is the right fixture either way.**

      From 2026-09-16 the loader's first sort key was `p.active DESC`, on the
      reasoning that `player_rankings_current` is `DISTINCT ON … as_of DESC`
      over a table whose rows are never deleted, so a player ranked in July
      keeps that row for ever and un-filtering alone would put him *first*.

      Measured against production on 2026-09-22, the premise is false. The
      provider does not stop ranking a released player — it keeps ranking him,
      worse every week. Best club-less ADP in the whole 2026 pool: 249.0. Tyreek
      Hill: 297.4, `as_of` the previous day, current rather than frozen. A
      12-team 15-round draft ends at pick 180. Nothing was up there to defend
      against. See `docs/DATA-MODEL.md` for the queries.

      The cut player keeps the strongest ranking of the three deliberately. It
      was chosen so the old assertion could not pass by accident through
      `NULLS LAST`, and it does the same work inverted: if `p.active DESC` were
      ever restored, this fixture is the one that notices.

      **What did not change is `autoPick`.** It demotes club-less players
      itself now, because its endgame scans one position at a time where the
      180-pick margin does not hold. See `draft.test.ts`.
    */
    const client = await fresh();
    const provider = new FakeProvider([
      player("1", "Cut Star", "RB"),
      player("2", "Active Ranked", "RB"),
      player("3", "Active Unranked", "WR"),
    ]);
    await syncPlayers(client, provider, "nfl", 2026);

    provider.setAdp([
      { externalRef: "1", fullName: "Cut Star", overallMilli: 1000, positionRank: "RB1" },
      { externalRef: "2", fullName: "Active Ranked", overallMilli: 3200, positionRank: "RB2" },
    ]);
    await syncRankings(client, provider, "nfl", 2026);
    await client.query("UPDATE players SET active = false WHERE external_ref = $1", ["1"]);

    const board = await loadDraftBoard(client, "nfl", 2026);

    expect(board.map((entry) => entry.fullName)).toEqual([
      // Best ADP in the fixture, and no longer demoted for having no club.
      "Cut Star",
      "Active Ranked",
      // No ADP at all, so `NULLS LAST` puts him behind both — the one part of
      // this ordering the ruling did not touch.
      "Active Unranked",
    ]);

    // And the real number now survives the trip, which is what the room's ADP
    // column prints. `rank` is this board's index; they are different facts.
    expect(board.map((entry) => entry.adpMilli)).toEqual([1000, 3200, null]);
  });

  it("gives a cut player a rank, so nothing downstream has to invent one", async () => {
    // The density contract `OFF_BOARD_RANK` leans on has to survive the
    // widening: every board rank stays finite and 1..n.
    const client = await fresh();
    const provider = new FakeProvider([player("1", "Active", "RB"), player("2", "Cut", "WR")]);
    await syncPlayers(client, provider, "nfl", 2026);
    await client.query("UPDATE players SET active = false WHERE external_ref = $1", ["2"]);

    const board = await loadDraftBoard(client, "nfl", 2026);

    expect(board.map((entry) => entry.rank)).toEqual([1, 2]);

    // Deliberately no assertion about *which* of the two is last. Neither has a
    // ranking, so `p.full_name` decides and "Active" < "Cut" — that ordering is
    // alphabetical accident, not the club rule, and asserting it here would
    // pin a fact this test is not about.
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

/**
 * The key that makes a second stats source joinable.
 *
 * `RULES.md` §7 requires two independent providers to agree before a week's
 * scores finalise. `stat_lines` has carried a `source` column since `0003` and
 * the current-value view keys on it, so the storage was always ready — what was
 * missing was any record of who a player *is* at the other provider.
 *
 * Tank01 publishes Sleeper's id on its own player list, so the correspondence is
 * asserted by a provider rather than guessed by us. These pin the two properties
 * that matter: it is stored, and an absent one stays absent rather than becoming
 * a value that would join to the wrong person.
 */
describe("syncPlayers — the second-source join key", () => {
  it("stores the id the provider published", async () => {
    const client = await fresh();
    await syncPlayers(
      client,
      new FakeProvider([player("t1", "A.J. Brown", "WR", "PHI", null, "4035")]),
      "nfl",
      2026,
    );

    const [row] = await client.query<{ second_source_ref: string | null }>(
      "SELECT second_source_ref FROM players WHERE external_ref = $1",
      ["t1"],
    );
    expect(row?.second_source_ref).toBe("4035");
  });

  it("leaves a player the provider does not map uncompared, rather than mismapped", async () => {
    // Null is the safe answer and the informative one: the comparison can report
    // how many players it could not join, instead of silently covering fewer of
    // them each week. Roughly 4,222 of Tank01's ~4,300 carry the field.
    const client = await fresh();
    await syncPlayers(
      client,
      new FakeProvider([player("t2", "Nobody Special", "WR")]),
      "nfl",
      2026,
    );

    const [row] = await client.query<{ second_source_ref: string | null }>(
      "SELECT second_source_ref FROM players WHERE external_ref = $1",
      ["t2"],
    );
    expect(row?.second_source_ref).toBeNull();
  });

  it("clears the key when the provider stops publishing it", async () => {
    // Deliberately not behind the `hasProfile` gate that protects the display
    // fields. Those are guarded because a response with no profile block would
    // erase a face we already had. This is one field on the same response, and a
    // provider that stops asserting the correspondence should stop the
    // comparison — not leave it joining on a key nobody stands behind.
    const client = await fresh();
    await syncPlayers(
      client,
      new FakeProvider([player("t3", "Traded Away", "RB", "PHI", null, "1234")]),
      "nfl",
      2026,
    );
    await syncPlayers(
      client,
      new FakeProvider([player("t3", "Traded Away", "RB", "PHI", null, null)]),
      "nfl",
      2026,
    );

    const [row] = await client.query<{ second_source_ref: string | null }>(
      "SELECT second_source_ref FROM players WHERE external_ref = $1",
      ["t3"],
    );
    expect(row?.second_source_ref).toBeNull();
  });
});
