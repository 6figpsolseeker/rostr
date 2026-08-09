import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, indexScoringRules, NFL, NFL_PPR_SCORING } from "@rostr/core";
import { resolveWeek } from "@rostr/core";
import type { DraftRules, LeagueRules, LineupAssignment } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import {
  autoFillLineup,
  ensureLineups,
  loadLineup,
  loadRosterForWeek,
  loadWeekLineups,
  loadWeekStats,
  setLineup,
} from "./lineups.js";

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

/** Week 1 2026 kickoffs. */
const THURSDAY = new Date("2026-09-10T00:15:00Z");
const SUNDAY = new Date("2026-09-13T17:00:00Z");
const SUNDAY_SECONDS = Math.floor(SUNDAY.getTime() / 1000);
const THURSDAY_SECONDS = Math.floor(THURSDAY.getTime() / 1000);

const BEFORE_ANYTHING = THURSDAY_SECONDS - 3600;
const AFTER_THURSDAY = THURSDAY_SECONDS + 60;

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  rules: LeagueRules;
  teamId: string;
  otherTeamId: string;
  /** Player IDs by the handle used below. */
  players: Map<string, string>;
}

/**
 * A league with two teams, one rostered squad, and a real schedule.
 *
 * `thu-qb` plays Thursday, `bye-te` has no game at all, everyone else Sunday —
 * which is what makes the lock behaviour observable rather than theoretical.
 */
async function setup(): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = buildNflPprRules({ seasonYear: SEASON, draft: DRAFT }) as LeagueRules;
  const league = await createLeague(db, NFL, {
    name: "Lineup League",
    commissionerId: commissioner.id,
    rules,
  });

  const mine = await addTestTeam(db, league.id, "My Team");
  const theirs = await addTestTeam(db, league.id, "Their Team");

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

  // Two NFL teams playing each other on Sunday, one on Thursday.
  await db.query(
    `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at)
     VALUES ($1, 'thu', $2, $3, 'PIT', 'CLE', $4),
            ($1, 'sun', $2, $3, 'CIN', 'BAL', $5)`,
    [sport!.id, SEASON, WEEK, THURSDAY, SUNDAY],
  );

  const roster: [string, string, string | null][] = [
    ["thu-qb", "QB", "PIT"],
    ["sun-qb", "QB", "CIN"],
    ["rb-a", "RB", "CIN"],
    ["rb-b", "RB", "BAL"],
    ["rb-c", "RB", "CIN"],
    ["wr-a", "WR", "BAL"],
    ["wr-b", "WR", "CIN"],
    ["wr-c", "WR", "BAL"],
    ["te-a", "TE", "CIN"],
    ["bye-te", "TE", "SEA"], // no game this week
    ["k-a", "K", "BAL"],
    ["def-a", "DEF", "CIN"],
  ];

  const players = new Map<string, string>();
  for (const [handle, position, teamRef] of roster) {
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [sport!.id, handle, handle, positions.get(position)!, teamRef],
    );
    players.set(handle, row!.id);

    await db.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via) VALUES ($1, $2, 'DRAFT')`,
      [mine.teamId, row!.id],
    );
  }

  // The other team needs a roster too, so the week can be scored.
  const [theirQb] = await db.query<{ id: string }>(
    `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
     VALUES ($1, 'their-qb', 'Their QB', $2, 'CIN') RETURNING id`,
    [sport!.id, positions.get("QB")!],
  );
  await db.query(
    `INSERT INTO roster_entries (team_id, player_id, acquired_via) VALUES ($1, $2, 'DRAFT')`,
    [theirs.teamId, theirQb!.id],
  );
  players.set("their-qb", theirQb!.id);

  return {
    client: db,
    leagueId: league.id,
    rules,
    teamId: mine.teamId,
    otherTeamId: theirs.teamId,
    players,
  };
}

const lineupOf = (fx: Fixture, handles: Record<string, string>): LineupAssignment[] =>
  Object.entries(handles).map(([slot, handle]) => {
    const [slotType, index] = slot.split(":");
    return {
      slotType: slotType!,
      slotIndex: Number(index ?? 0),
      playerId: fx.players.get(handle) ?? handle,
    };
  });

const FULL = {
  "QB:0": "sun-qb",
  "RB:0": "rb-a",
  "RB:1": "rb-b",
  "WR:0": "wr-a",
  "WR:1": "wr-b",
  "TE:0": "te-a",
  "FLEX:0": "wr-c",
  "K:0": "k-a",
  "DEF:0": "def-a",
};

describe("loadRosterForWeek", () => {
  it("returns the whole active roster", async () => {
    const fx = await setup();
    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);

    expect(roster.size).toBe(12);
  });

  it("carries each player's own kickoff", async () => {
    // The lock hangs entirely off this.
    const fx = await setup();
    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);

    expect(roster.get(fx.players.get("thu-qb")!)?.kickoffAt).toBe(THURSDAY_SECONDS);
    expect(roster.get(fx.players.get("sun-qb")!)?.kickoffAt).toBe(SUNDAY_SECONDS);
  });

  it("gives a player on a bye no kickoff", async () => {
    // Which is what stops that slot ever locking — there is no game to start.
    const fx = await setup();
    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);

    expect(roster.get(fx.players.get("bye-te")!)?.kickoffAt).toBeNull();
  });

  it("leaves out released players", async () => {
    const fx = await setup();
    await fx.client.query(
      "UPDATE roster_entries SET released_at = now() WHERE team_id = $1 AND player_id = $2",
      [fx.teamId, fx.players.get("rb-c")],
    );

    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);
    expect(roster.has(fx.players.get("rb-c")!)).toBe(false);
  });
});

describe("setLineup", () => {
  it("stores a legal lineup", async () => {
    const fx = await setup();

    const saved = await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, FULL),
      now: BEFORE_ANYTHING,
    });

    expect(saved.find((s) => s.slotType === "QB")?.playerId).toBe(fx.players.get("sun-qb"));
    expect(saved.filter((s) => s.playerId !== null)).toHaveLength(9);
  });

  it("rejects a partial update that duplicates a player already starting elsewhere", async () => {
    // The write touches only the sent slots, so validation must catch a player
    // who already starts in a slot this update does not overwrite — otherwise he
    // ends up in two, and the duplicate crashes scoring for the whole league
    // when the week resolves.
    const fx = await setup();
    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, FULL),
      now: BEFORE_ANYTHING,
    });

    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        // rb-a already starts at RB:0, which this update leaves untouched.
        assignments: lineupOf(fx, { "FLEX:0": "rb-a" }),
        now: BEFORE_ANYTHING,
      }),
    ).rejects.toMatchObject({ code: "INVALID_LINEUP" });
  });

  it("allows moving a player when the same update vacates his old slot", async () => {
    // The counter-case the duplicate check must not break: rb-a moves to FLEX
    // while RB:0 is reassigned in the same request, so he is not in two slots.
    const fx = await setup();
    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, FULL),
      now: BEFORE_ANYTHING,
    });

    const saved = await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, { "FLEX:0": "rb-a", "RB:0": "rb-c" }),
      now: BEFORE_ANYTHING,
    });

    expect(saved.find((s) => s.slotType === "FLEX")?.playerId).toBe(fx.players.get("rb-a"));
    expect(saved.find((s) => s.slotType === "RB" && s.slotIndex === 0)?.playerId).toBe(
      fx.players.get("rb-c"),
    );
  });

  it("reads back every slot, empty ones included", async () => {
    // A caller should see the shape of the lineup, not only the filled parts.
    const fx = await setup();
    const loaded = await loadLineup(fx.client, fx.teamId, WEEK, fx.rules);

    expect(loaded).toHaveLength(9);
    expect(loaded.every((slot) => slot.playerId === null)).toBe(true);
  });

  it("rejects a player who cannot play the slot", async () => {
    const fx = await setup();

    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: lineupOf(fx, { "QB:0": "rb-a" }),
        now: BEFORE_ANYTHING,
      }),
    ).rejects.toMatchObject({ code: "INVALID_LINEUP" });
  });

  it("rejects somebody else's player", async () => {
    const fx = await setup();

    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: lineupOf(fx, { "QB:0": "their-qb" }),
        now: BEFORE_ANYTHING,
      }),
    ).rejects.toMatchObject({ code: "INVALID_LINEUP" });
  });

  it("rejects a team from another league", async () => {
    const fx = await setup();

    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: "00000000-0000-0000-0000-000000000000",
        week: WEEK,
        assignments: [],
        now: BEFORE_ANYTHING,
      }),
    ).rejects.toMatchObject({ code: "TEAM_NOT_IN_LEAGUE" });
  });

  it("leaves the stored lineup intact when it rejects one", async () => {
    // One transaction. A rejected lineup must not half-apply.
    const fx = await setup();
    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, FULL),
      now: BEFORE_ANYTHING,
    });

    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: lineupOf(fx, { "QB:0": "rb-a", "RB:0": "rb-c" }),
        now: BEFORE_ANYTHING,
      }),
    ).rejects.toThrow();

    const after = await loadLineup(fx.client, fx.teamId, WEEK, fx.rules);
    expect(after.find((s) => s.slotType === "QB")?.playerId).toBe(fx.players.get("sun-qb"));
  });

  describe("locks", () => {
    it("refuses to move a player whose game has started", async () => {
      // The check that matters. A UI greying out the slot is a courtesy; this is
      // what a crafted request has to get past.
      const fx = await setup();
      await setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: lineupOf(fx, { ...FULL, "QB:0": "thu-qb" }),
        now: BEFORE_ANYTHING,
      });

      await expect(
        setLineup(fx.client, {
          leagueId: fx.leagueId,
          teamId: fx.teamId,
          week: WEEK,
          assignments: lineupOf(fx, { ...FULL, "QB:0": "sun-qb" }),
          now: AFTER_THURSDAY,
        }),
      ).rejects.toMatchObject({ code: "INVALID_LINEUP" });
    });

    it("still allows the rest of the lineup to move", async () => {
      // The whole point of per-player locks: a Thursday player being locked must
      // not stop a manager reacting to a Sunday-morning injury.
      const fx = await setup();
      await setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: lineupOf(fx, { ...FULL, "QB:0": "thu-qb" }),
        now: BEFORE_ANYTHING,
      });

      const saved = await setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: lineupOf(fx, { ...FULL, "QB:0": "thu-qb", "FLEX:0": "rb-c" }),
        now: AFTER_THURSDAY,
      });

      expect(saved.find((s) => s.slotType === "FLEX")?.playerId).toBe(fx.players.get("rb-c"));
    });
  });
});

describe("autoFillLineup", () => {
  it("fills an empty lineup", async () => {
    const fx = await setup();

    const filled = await autoFillLineup(
      fx.client,
      fx.leagueId,
      fx.teamId,
      WEEK,
      BEFORE_ANYTHING,
    );

    expect(filled.filter((slot) => slot.playerId !== null)).toHaveLength(9);
  });

  it("prefers a player who has a game to one on a bye", async () => {
    // The tight end on a bye scores nothing at all, so he loses to anyone
    // playing — even with no scoring history to separate them.
    const fx = await setup();
    const filled = await autoFillLineup(
      fx.client,
      fx.leagueId,
      fx.teamId,
      WEEK,
      BEFORE_ANYTHING,
    );

    expect(filled.find((slot) => slot.slotType === "TE")?.playerId).toBe(
      fx.players.get("te-a"),
    );
  });

  it("leaves a manager's own choices alone", async () => {
    // This fills gaps; it does not second-guess.
    const fx = await setup();
    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, { "QB:0": "thu-qb" }),
      now: BEFORE_ANYTHING,
    });

    const filled = await autoFillLineup(
      fx.client,
      fx.leagueId,
      fx.teamId,
      WEEK,
      BEFORE_ANYTHING,
    );

    expect(filled.find((slot) => slot.slotType === "QB")?.playerId).toBe(
      fx.players.get("thu-qb"),
    );
    expect(filled.filter((slot) => slot.playerId !== null)).toHaveLength(9);
  });

  it("is idempotent", async () => {
    const fx = await setup();
    const first = await autoFillLineup(
      fx.client,
      fx.leagueId,
      fx.teamId,
      WEEK,
      BEFORE_ANYTHING,
    );
    const second = await autoFillLineup(
      fx.client,
      fx.leagueId,
      fx.teamId,
      WEEK,
      BEFORE_ANYTHING,
    );

    expect(second).toEqual(first);
  });

  it("does not disturb a locked slot", async () => {
    const fx = await setup();
    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, { "QB:0": "thu-qb" }),
      now: BEFORE_ANYTHING,
    });

    const filled = await autoFillLineup(
      fx.client,
      fx.leagueId,
      fx.teamId,
      WEEK,
      AFTER_THURSDAY,
    );

    expect(filled.find((slot) => slot.slotType === "QB")?.playerId).toBe(
      fx.players.get("thu-qb"),
    );
  });
});

describe("ensureLineups", () => {
  it("gives every team in the league a lineup", async () => {
    // What makes resolveWeek's precondition true.
    const fx = await setup();
    const result = await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);

    expect(result.teamsFilled).toBe(2);

    for (const teamId of [fx.teamId, fx.otherTeamId]) {
      const lineup = await loadLineup(fx.client, teamId, WEEK, fx.rules);
      expect(lineup).toHaveLength(9);
    }
  });

  it("copes with a team that has almost no roster", async () => {
    // The other team has one quarterback. Eight slots stay empty, and that is a
    // legal lineup — it simply scores very little.
    const fx = await setup();
    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);

    const lineup = await loadLineup(fx.client, fx.otherTeamId, WEEK, fx.rules);
    expect(lineup.filter((slot) => slot.playerId !== null)).toHaveLength(1);
  });

  it("is on by default, because the point is that forgetting costs nothing", async () => {
    const fx = await setup();
    const [row] = await fx.client.query<{ autofill_enabled: boolean }>(
      "SELECT autofill_enabled FROM teams WHERE id = $1",
      [fx.teamId],
    );
    expect(row?.autofill_enabled).toBe(true);
  });

  it("leaves a team that opted out empty", async () => {
    const fx = await setup();
    await fx.client.query("UPDATE teams SET autofill_enabled = false WHERE id = $1", [
      fx.teamId,
    ]);

    const result = await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);
    expect(result).toMatchObject({ teamsFilled: 1, teamsOptedOut: 1 });

    // Still gets a lineup row for every slot — resolveWeek throws on a team with
    // none, and scoring a missing team as zero would hand its opponent a free
    // win off our own bug. The slots are simply empty, and score nothing.
    const lineup = await loadLineup(fx.client, fx.teamId, WEEK, fx.rules);
    expect(lineup).toHaveLength(9);
    expect(lineup.every((slot) => slot.playerId === null)).toBe(true);
  });

  it("does not touch a slot the opted-out manager set themselves", async () => {
    // The switch means "do not choose for me", not "do not let me choose".
    const fx = await setup();
    await fx.client.query("UPDATE teams SET autofill_enabled = false WHERE id = $1", [
      fx.teamId,
    ]);

    const qb = fx.players.get("sun-qb")!;
    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      now: BEFORE_ANYTHING,
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: qb }],
    });

    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);

    const lineup = await loadLineup(fx.client, fx.teamId, WEEK, fx.rules);
    expect(lineup.find((slot) => slot.slotType === "QB")?.playerId).toBe(qb);
    expect(lineup.filter((slot) => slot.playerId !== null)).toHaveLength(1);
  });

  it("fills a bot regardless of the flag", async () => {
    // There is no manager to forget, so the switch is not a bot's to hold.
    const fx = await setup();
    await fx.client.query(
      "UPDATE teams SET autofill_enabled = false, is_bot = true, owner_id = NULL WHERE id = $1",
      [fx.teamId],
    );

    const result = await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);
    expect(result).toMatchObject({ teamsFilled: 2, teamsOptedOut: 0 });

    const lineup = await loadLineup(fx.client, fx.teamId, WEEK, fx.rules);
    expect(lineup.some((slot) => slot.playerId !== null)).toBe(true);
  });
});

describe("scoring a week end to end", () => {
  it("resolves a matchup from stored lineups and stat lines", async () => {
    // The join this whole module exists to make real: lineups out of the
    // database, stats out of the database, a result the standings can consume.
    const fx = await setup();

    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    const statKeys = new Map(
      (
        await fx.client.query<{ id: string; key: string }>(
          "SELECT id, key FROM stat_keys WHERE sport_id = $1",
          [sport!.id],
        )
      ).map((row) => [row.key, row.id]),
    );

    // My quarterback throws for 300 and three scores; theirs does nothing.
    for (const [statKey, value] of [
      ["pass_yd", 300],
      ["pass_td", 3],
    ] as const) {
      await fx.client.query(
        `INSERT INTO stat_lines (player_id, season, week, stat_key_id, value, source)
         VALUES ($1, $2, $3, $4, $5, 'test')`,
        [fx.players.get("sun-qb"), SEASON, WEEK, statKeys.get(statKey), value],
      );
    }

    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, FULL),
      now: BEFORE_ANYTHING,
    });
    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);

    const lineups = await loadWeekLineups(fx.client, fx.leagueId, WEEK);
    const stats = await loadWeekStats(fx.client, NFL.key, SEASON, WEEK);

    const { results, scores } = resolveWeek(
      [{ week: WEEK, homeTeamId: fx.teamId, awayTeamId: fx.otherTeamId }],
      lineups,
      stats,
      indexScoringRules(NFL_PPR_SCORING),
      fx.rules.roster,
    );

    // 300 passing yards at 0.04 is 12; three passing touchdowns at 4 is 12.
    expect(scores.get(fx.teamId)?.milliPoints).toBe(24_000);
    expect(results[0]).toMatchObject({
      homeTeamId: fx.teamId,
      homeMilliPoints: 24_000,
      awayMilliPoints: 0,
    });
  });

  it("puts unstarted players on the bench, uncounted", async () => {
    const fx = await setup();
    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, FULL),
      now: BEFORE_ANYTHING,
    });

    const lineups = await loadWeekLineups(fx.client, fx.leagueId, WEEK);
    const mine = lineups.find((lineup) => lineup.teamId === fx.teamId);

    // Twelve rostered, nine starting.
    expect(mine?.bench).toHaveLength(3);
    expect(mine?.bench).toContain(fx.players.get("thu-qb"));
  });
});

describe("the database refuses a duplicate starter", () => {
  /**
   * Migration 0016. The application check in `setLineup` closes the sequential
   * case; this is the backstop for everything else — the TOCTOU window between
   * reading the current lineup and writing, and any future writer that forgets.
   *
   * Deliberately written against raw SQL rather than through `setLineup`, because
   * what is being tested is precisely what happens when the application check is
   * not the thing standing in the way.
   */
  async function slotTypeIds(fx: Fixture): Promise<Map<string, string>> {
    const rows = await fx.client.query<{ id: string; key: string }>(
      `SELECT st.id, st.key FROM slot_types st
         JOIN sports s ON s.id = st.sport_id WHERE s.key = $1`,
      [NFL.key],
    );
    return new Map(rows.map((row) => [row.key, row.id]));
  }

  it("rejects the same player in two starting slots", async () => {
    const fx = await setup();
    const ids = await slotTypeIds(fx);
    const rb = fx.players.get("rb-a")!;

    await fx.client.query(
      `INSERT INTO lineups (team_id, week, slot_type_id, slot_index, player_id)
       VALUES ($1, $2, $3, 0, $4)`,
      [fx.teamId, WEEK, ids.get("RB"), rb],
    );

    // Same player, different slot, written directly. Without 0016 this succeeds
    // and the league's week can never be scored again.
    await expect(
      fx.client.query(
        `INSERT INTO lineups (team_id, week, slot_type_id, slot_index, player_id)
         VALUES ($1, $2, $3, 0, $4)`,
        [fx.teamId, WEEK, ids.get("FLEX"), rb],
      ),
    ).rejects.toThrow();
  });

  it("still allows many empty slots", async () => {
    // The normal state of a lineup: a row per starting slot, most of them NULL.
    // A non-partial unique index would be fine in Postgres, but the intent is
    // that the rule is about players, not rows.
    const fx = await setup();
    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);

    const lineup = await loadLineup(fx.client, fx.otherTeamId, WEEK, fx.rules);
    expect(lineup.filter((slot) => slot.playerId === null).length).toBeGreaterThan(1);
  });

  it("still allows the same player for a different week", async () => {
    const fx = await setup();
    const ids = await slotTypeIds(fx);
    const rb = fx.players.get("rb-a")!;

    await fx.client.query(
      `INSERT INTO lineups (team_id, week, slot_type_id, slot_index, player_id)
       VALUES ($1, $2, $3, 0, $4)`,
      [fx.teamId, WEEK, ids.get("RB"), rb],
    );

    // Starting the same player every week is the entire point of a roster.
    await expect(
      fx.client.query(
        `INSERT INTO lineups (team_id, week, slot_type_id, slot_index, player_id)
         VALUES ($1, $2, $3, 0, $4)`,
        [fx.teamId, WEEK + 1, ids.get("RB"), rb],
      ),
    ).resolves.toBeDefined();
  });
});
