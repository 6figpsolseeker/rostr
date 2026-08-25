import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, indexScoringRules, NFL, NFL_PPR_SCORING } from "@rostr/core";
import { resolveWeek } from "@rostr/core";
import type { DraftRules, LeagueRules, LineupAssignment } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import {
  autoFillLineup,
  ensureLineups,
  loadAverages,
  LineupError,
  loadKickoffs,
  loadLineup,
  loadProjectedPoints,
  loadRosterForWeek,
  loadWeekLineups,
  loadWeekStats,
  PRIMARY_PROJECTION_SOURCE,
  PRIMARY_STAT_SOURCE,
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
  //
  // SEA plays in week 2 and not week 1, which is what a bye actually looks like:
  // the team is in the season's schedule, just not this week. That distinction is
  // load-bearing — `loadRosterForWeek` treats a team appearing *nowhere* in the
  // schedule as unknown rather than as on bye, and locks it conservatively, so a
  // fixture where SEA never played would be testing the wrong thing.
  await db.query(
    `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at)
     VALUES ($1, 'thu', $2, $3, 'PIT', 'CLE', $4),
            ($1, 'sun', $2, $3, 'CIN', 'BAL', $5),
            ($1, 'sea-w2', $2, $3 + 1, 'SEA', 'ARI', $5)`,
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

/**
 * A client that runs `onFirstBegin` immediately before the first `BEGIN` it is
 * asked to issue, then behaves normally.
 *
 * PGlite is a single connection, so the race here cannot be run *as* a race —
 * there is no second session, and a second in-flight statement queues rather
 * than interleaves. The **interleaving** is what matters and that can be forced
 * exactly: `autoFillLineup` takes its expensive reads before `withTransaction`
 * issues `BEGIN`, so firing here lands the manager's write in the window the bug
 * lived in — after the reads, before the transaction that acts on them.
 *
 * That window is where the stored lineup used to be read from. It no longer is,
 * which is the fix, and which is why these tests fail on `main`.
 *
 * One-shot, and not for tidiness: the callback's own `setLineup` opens a
 * transaction too, so a re-entrant hook would recurse until the stack ran out.
 *
 * No `connect`, deliberately — `withTransaction` runs directly on whatever it is
 * given when that is absent, so every statement of the autofill's transaction
 * goes through this wrapper.
 */
function interleaveAtFirstBegin(
  inner: PGliteClient,
  onFirstBegin: () => Promise<void>,
): SqlClient {
  let fired = false;
  return {
    async exec(sql: string): Promise<void> {
      if (!fired && sql.trim().toUpperCase().startsWith("BEGIN")) {
        fired = true;
        await onFirstBegin();
      }
      await inner.exec(sql);
    },
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      return inner.query<T>(sql, params);
    },
  };
}

describe("the autofill never reverts a manager's edit", () => {
  it("leaves a slot the manager changed while it was still thinking", async () => {
    // Issue #90. The autofill used to decide from a lineup read outside any
    // transaction and then write every starting slot back unconditionally, so an
    // edit saved in that window was written, silently restored to the snapshot,
    // and then scored. `lineups` keeps no history, so nothing recorded that it
    // happened and the manager had only their memory to argue from.
    const fx = await setup();

    // The autolineup always takes `te-a` over `bye-te` — a player on a bye
    // scores nothing at all — so a manager starting `bye-te` is making exactly
    // the choice the autofill would reverse. Pinned by the test above.
    const byeTe = fx.players.get("bye-te")!;

    const client = interleaveAtFirstBegin(fx.client, async () => {
      await setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "TE", slotIndex: 0, playerId: byeTe }],
        now: BEFORE_ANYTHING,
      });
    });

    const filled = await autoFillLineup(client, fx.leagueId, fx.teamId, WEEK, BEFORE_ANYTHING);

    // What it returns is what was stored, not what it intended.
    expect(filled.find((slot) => slot.slotType === "TE")?.playerId).toBe(byeTe);

    const stored = await loadLineup(fx.client, fx.teamId, WEEK, fx.rules);
    expect(stored.find((slot) => slot.slotType === "TE")?.playerId).toBe(byeTe);

    // And the rest of the autofill still landed. A guard that protected the
    // manager by writing nothing at all would satisfy both assertions above and
    // leave the team fielding one player.
    expect(stored.filter((slot) => slot.playerId !== null)).toHaveLength(9);
  });

  it("still fills a slot that exists and is empty", async () => {
    // The case `IS NOT DISTINCT FROM` exists for, and the one `=` would break
    // silently: the row is present holding `NULL`, so `lineups.player_id = $6`
    // is `NULL = NULL` — not true — and the slot could never be filled again.
    // Reachable on any team whose roster grew after a pass that could not fill
    // everything, which is every waiver claim.
    const fx = await setup();

    // The other team has one player, so its first pass materialises all nine
    // rows and leaves eight of them empty.
    await autoFillLineup(fx.client, fx.leagueId, fx.otherTeamId, WEEK, BEFORE_ANYTHING);
    const before = await loadLineup(fx.client, fx.otherTeamId, WEEK, fx.rules);
    expect(before.filter((slot) => slot.playerId !== null)).toHaveLength(1);

    // They pick somebody up off the wire.
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    const [rbPosition] = await fx.client.query<{ id: string }>(
      "SELECT id FROM positions WHERE sport_id = $1 AND key = 'RB'",
      [sport!.id],
    );
    const [wireRb] = await fx.client.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, 'wire-rb', 'Wire RB', $2, 'CIN') RETURNING id`,
      [sport!.id, rbPosition!.id],
    );
    await fx.client.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via) VALUES ($1, $2, 'WAIVER')`,
      [fx.otherTeamId, wireRb!.id],
    );

    const filled = await autoFillLineup(
      fx.client,
      fx.leagueId,
      fx.otherTeamId,
      WEEK,
      BEFORE_ANYTHING,
    );

    expect(filled.some((slot) => slot.playerId === wireRb!.id)).toBe(true);
  });

  it("fills the slots the manager did not touch from the state they left behind", async () => {
    // The half a per-row guard on its own cannot do. The manager takes a player
    // the autofill's plan had earmarked for another slot; a compare-and-swap
    // conditioned on a stale snapshot writes him twice and trips migration
    // 0016's constraint at COMMIT, losing the whole pass. Reading inside the
    // transaction computes one self-consistent lineup instead, so the
    // interleaving simply cannot produce that state.
    const fx = await setup();
    const flexPick = fx.players.get("rb-c")!;

    const client = interleaveAtFirstBegin(fx.client, async () => {
      await setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "FLEX", slotIndex: 0, playerId: flexPick }],
        now: BEFORE_ANYTHING,
      });
    });

    const filled = await autoFillLineup(client, fx.leagueId, fx.teamId, WEEK, BEFORE_ANYTHING);

    expect(filled.find((slot) => slot.slotType === "FLEX")?.playerId).toBe(flexPick);
    expect(filled.filter((slot) => slot.playerId !== null)).toHaveLength(9);

    // Nobody starts twice — the whole lineup was decided from one reading of it.
    const started = filled.map((slot) => slot.playerId).filter((id) => id !== null);
    expect(new Set(started).size).toBe(started.length);
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

  it("fills a slot whose row already exists holding null", async () => {
    /*
      **The case `IS NOT DISTINCT FROM` exists for in `setLineup`, and the one
      `=` would break silently.**

      `setLineupUnchecked` has carried this test since it was written. #224
      copied the compare-and-swap into `setLineup` and did not copy the test, so
      the same one-character mutation — `IS NOT DISTINCT FROM $6` to `= $6` —
      was green across the whole suite.

      What it costs: `NULL = NULL` is `NULL`, so the CAS matches nothing, zero
      rows come back, and the manager is told `LINEUP_MOVED`. Forever. The
      editor's one retry re-reads the same null and is refused again. Every
      autofill-off manager would be locked out of setting a lineup at all, and
      every team gets rows like this the moment `ensureLineups` runs.

      The ordering here is the whole point: `ensureLineups` **first**, so the row
      is present holding null, then the manager fills it. The sibling test below
      does it the other way round and cannot see this.
    */
    const fx = await setup();
    await fx.client.query("UPDATE teams SET autofill_enabled = false WHERE id = $1", [
      fx.teamId,
    ]);

    // Materialised, empty — exactly what an opted-out team carries.
    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);
    const [row] = await fx.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lineups
        WHERE team_id = $1 AND week = $2 AND player_id IS NULL`,
      [fx.teamId, WEEK],
    );
    expect(row?.n).toBe(9);

    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("sun-qb") }],
      now: BEFORE_ANYTHING,
    });

    const after = await loadLineup(fx.client, fx.teamId, WEEK, fx.rules);
    expect(after.find((slot) => slot.slotType === "QB")?.playerId).toBe(
      fx.players.get("sun-qb"),
    );
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
         VALUES ($1, $2, $3, $4, $5, 'tank01')`,
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

describe("the schedule is a precondition for locking", () => {
  /**
   * Every lock in the system derives from `games.kickoff_at`. A week with no
   * game rows therefore has no locks at all — not "locks that have not fired
   * yet", none — and a manager could set their whole lineup on Monday night
   * having watched every result.
   *
   * These are the two shapes of that hole. Both were reachable, and both scored.
   */

  it("refuses a lineup for a week whose schedule was never ingested", async () => {
    const fx = await setup();
    await fx.client.query("DELETE FROM games WHERE season = $1 AND week = $2", [SEASON, WEEK]);

    // Long after every game would have finished, if any had been scheduled.
    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: lineupOf(fx, FULL),
        now: SUNDAY_SECONDS + 86_400,
      }),
    ).rejects.toThrow(/no schedule loaded/);
  });

  it("locks a player whose team is nowhere in the schedule", async () => {
    // Stale after a trade, blank, or renamed by the provider. He never locked,
    // while `loadWeekStats` keys on player_id alone and scores him anyway — so
    // he could be started on Monday night having already played.
    const fx = await setup();
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    const [position] = await fx.client.query<{ id: string }>(
      "SELECT id FROM positions WHERE sport_id = $1 AND key = 'QB'",
      [sport!.id],
    );
    const [orphan] = await fx.client.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, 'orphan-qb', 'Orphan QB', $2, 'XXX') RETURNING id`,
      [sport!.id, position!.id],
    );
    await fx.client.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via) VALUES ($1, $2, 'DRAFT')`,
      [fx.teamId, orphan!.id],
    );

    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);

    // Given the week's first kickoff rather than null, so every existing lock
    // rule applies: movable before the week begins, frozen once it has.
    expect(roster.get(orphan!.id)?.kickoffAt).toBe(THURSDAY_SECONDS);

    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: orphan!.id }],
        now: SUNDAY_SECONDS + 86_400,
      }),
    ).rejects.toThrow(/kicked off/);
  });

  it("still lets a genuine bye player be started at any time", async () => {
    // The documented behaviour, and the reason the two cases had to be told
    // apart rather than both locked. SEA is in the schedule, just not this week.
    const fx = await setup();
    const bye = fx.players.get("bye-te")!;

    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);
    expect(roster.get(bye)?.kickoffAt).toBeNull();

    const saved = await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: [{ slotType: "TE", slotIndex: 0, playerId: bye }],
      now: SUNDAY_SECONDS + 86_400,
    });

    expect(saved.find((slot) => slot.slotType === "TE")?.playerId).toBe(bye);
  });
});

describe("one source decides the score", () => {
  /**
   * `stat_lines_current` is `DISTINCT ON (…, source)`, so two providers reporting
   * the same stat are two rows, and `scorePlayer` folds over whatever it is
   * handed. Reading unfiltered counted every shared stat twice — and only for the
   * players both providers covered, so the distortion was uneven and reordered
   * rankings rather than merely inflating them.
   *
   * Latent rather than live: nothing writes `stat_lines` in production yet. The
   * second provider is a planned, deliberate addition (`docs/RULES.md` §7), which
   * is exactly why this is fixed before it arrives rather than after — the day it
   * fires is a paying week.
   */
  const statId = async (fx: Fixture, key: string): Promise<string> => {
    const [row] = await fx.client.query<{ id: string }>(
      `SELECT k.id FROM stat_keys k JOIN sports s ON s.id = k.sport_id
        WHERE s.key = $1 AND k.key = $2`,
      [NFL.key, key],
    );
    return row!.id;
  };

  const writeStat = async (
    fx: Fixture,
    playerId: string,
    key: string,
    value: number,
    source: string,
    revision = 0,
  ): Promise<void> => {
    await fx.client.query(
      `INSERT INTO stat_lines (player_id, season, week, stat_key_id, value, source, revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [playerId, SEASON, WEEK, await statId(fx, key), value, source, revision],
    );
  };

  it("counts a stat once when two providers both report it", async () => {
    const fx = await setup();
    const qb = fx.players.get("sun-qb")!;

    await writeStat(fx, qb, "pass_yd", 300, PRIMARY_STAT_SOURCE);
    await writeStat(fx, qb, "pass_yd", 300, "sportsdataio");

    const stats = await loadWeekStats(fx.client, NFL.key, SEASON, WEEK);

    // One entry, not two. Unfiltered this was [300, 300] and scored double.
    expect(stats.get(qb)).toHaveLength(1);
    expect(stats.get(qb)?.[0]?.value).toBe(300);
  });

  it("keeps both providers visible for the agreement gate to compare", async () => {
    // The guard against a later "simplification" that collapses sources in the
    // view. `docs/RULES.md` §7 requires two providers to *agree* before a paying
    // week finalises, and the view is the only place their values sit side by
    // side. Filtering at read time preserves that; collapsing at storage
    // destroys it, and would have to be undone to ship G4/G5.
    const fx = await setup();
    const qb = fx.players.get("sun-qb")!;

    await writeStat(fx, qb, "pass_yd", 300, PRIMARY_STAT_SOURCE);
    await writeStat(fx, qb, "pass_yd", 305, "sportsdataio");

    const rows = await fx.client.query<{ source: string; value: number }>(
      `SELECT source, value FROM stat_lines_current
        WHERE player_id = $1 AND season = $2 AND week = $3`,
      [qb, SEASON, WEEK],
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.value)).sort()).toEqual([300, 305]);
  });

  it("still takes the latest revision within the chosen source", async () => {
    // The fix must not be implemented by keying on revision globally: revisions
    // resolve *within* a source, so a correction replaces rather than adds.
    const fx = await setup();
    const qb = fx.players.get("sun-qb")!;

    await writeStat(fx, qb, "pass_yd", 300, PRIMARY_STAT_SOURCE, 0);
    await writeStat(fx, qb, "pass_yd", 250, PRIMARY_STAT_SOURCE, 1);
    await writeStat(fx, qb, "pass_yd", 999, "sportsdataio", 0);

    const stats = await loadWeekStats(fx.client, NFL.key, SEASON, WEEK);

    expect(stats.get(qb)).toHaveLength(1);
    expect(stats.get(qb)?.[0]?.value).toBe(250);
  });

  it("averages a season from one source, so the autolineup ranks honestly", async () => {
    // `loadAverages` feeds `autoFillLineup`, which is the fallback ranking for
    // any player without a projection. A doubled average changes *which* players
    // are started, not only what they score.
    const fx = await setup();
    const qb = fx.players.get("sun-qb")!;

    await fx.client.query(
      `INSERT INTO stat_lines (player_id, season, week, stat_key_id, value, source, revision)
       VALUES ($1, $2, 1, $3, 300, $4, 0), ($1, $2, 1, $3, 300, 'sportsdataio', 0)`,
      [qb, SEASON, await statId(fx, "pass_yd"), PRIMARY_STAT_SOURCE],
    );

    const averages = await loadAverages(fx.client, [qb], SEASON, 2, fx.rules);

    // 300 passing yards at 0.04/yd is 12 points, once.
    expect(averages.get(qb)).toBe(12_000);
  });
});

describe("one source ranks the autofill", () => {
  /**
   * The projection sibling of the stat double-count.
   *
   * `player_projections` is keyed on `(player, season, week, source, stat_key)`
   * precisely so a second opinion does not overwrite the first, and `scorePlayer`
   * folds over every row — so an unfiltered read projects a dual-covered player
   * at roughly double while single-covered players stay as they are. That is a
   * *reordering*, and the ranking is what decides who starts.
   *
   * Wider than it looks: `autofill_enabled` defaults to true and the autofill
   * also fills gaps in a hand-set lineup, so this reaches every manager in a
   * league, not only abandoned teams.
   */
  const projStatId = async (fx: Fixture, key: string): Promise<string> => {
    const [row] = await fx.client.query<{ id: string }>(
      `SELECT k.id FROM stat_keys k JOIN sports s ON s.id = k.sport_id
        WHERE s.key = $1 AND k.key = $2`,
      [NFL.key, key],
    );
    return row!.id;
  };

  const project = async (
    fx: Fixture,
    playerId: string,
    key: string,
    value: number,
    source: string,
    week = WEEK,
  ): Promise<void> => {
    await fx.client.query(
      `INSERT INTO player_projections (player_id, season, week, source, stat_key_id, value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [playerId, SEASON, week, source, await projStatId(fx, key), value],
    );
  };

  it("projects a player once when two providers both cover him", async () => {
    const fx = await setup();
    const qb = fx.players.get("sun-qb")!;

    await project(fx, qb, "pass_yd", 300, PRIMARY_PROJECTION_SOURCE);
    await project(fx, qb, "pass_yd", 300, "sportsdataio");

    const projected = await loadProjectedPoints(fx.client, SEASON, WEEK, fx.rules);

    // 300 yards at 0.04/yd is 12 points. Unfiltered this was 24.
    expect(projected.get(qb)).toBe(12_000);
  });

  it("selects the named source rather than adding to it", async () => {
    // Proves the parameter picks one opinion. A fix that summed and then halved,
    // or averaged, would pass the test above and fail this one.
    const fx = await setup();
    const qb = fx.players.get("sun-qb")!;

    await project(fx, qb, "pass_yd", 300, PRIMARY_PROJECTION_SOURCE);
    await project(fx, qb, "pass_yd", 100, "sportsdataio");

    const other = await loadProjectedPoints(fx.client, SEASON, WEEK, fx.rules, "sportsdataio");

    expect(other.get(qb)).toBe(4_000);
  });

  it("keeps the second opinion on the table", async () => {
    // Migration 0013 exists so a second opinion never overwrites the first.
    // Filtering at read time preserves that; narrowing the key would not, and
    // this fails if anyone later "simplifies" it that way.
    const fx = await setup();
    const qb = fx.players.get("sun-qb")!;

    await project(fx, qb, "pass_yd", 300, PRIMARY_PROJECTION_SOURCE);
    await project(fx, qb, "pass_yd", 250, "sportsdataio");

    const rows = await fx.client.query<{ source: string }>(
      "SELECT source FROM player_projections WHERE player_id = $1 AND week = $2",
      [qb, WEEK],
    );

    expect(rows).toHaveLength(2);
  });

  it("does not mix the season aggregate into a weekly projection", async () => {
    // Week 0 is the season total the draft board uses. The weekly read is exact
    // equality on week, so the two can never be summed — a regression pin rather
    // than a fix, since this already held.
    const fx = await setup();
    const qb = fx.players.get("sun-qb")!;

    await project(fx, qb, "pass_yd", 4000, PRIMARY_PROJECTION_SOURCE, 0);
    await project(fx, qb, "pass_yd", 300, PRIMARY_PROJECTION_SOURCE, WEEK);

    const projected = await loadProjectedPoints(fx.client, SEASON, WEEK, fx.rules);

    expect(projected.get(qb)).toBe(12_000);
  });
});

describe("the lock survives a drop", () => {
  /**
   * The exploit, as a regression test.
   *
   * Start a Thursday player, watch him play, cut him, and swap a Sunday player
   * into his slot. This resolved before the lock stopped consulting the roster:
   * `loadRosterForWeek` excludes released players, so the slot's occupant
   * vanished from the map and an absent player read as "never locked".
   */
  it("refuses the swap after the locked player is dropped", async () => {
    const fx = await setup();

    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("thu-qb")! }],
      now: BEFORE_ANYTHING,
    });

    // Released directly rather than through `dropPlayer`, which now refuses this
    // outright — see the waiver suite. The point here is that the lineup lock
    // holds however the player left, including the paths that cannot refuse:
    // `resolveTrade` and `processWaivers` both release rows mid-week.
    await fx.client.query(
      "UPDATE roster_entries SET released_at = now() WHERE team_id = $1 AND player_id = $2",
      [fx.teamId, fx.players.get("thu-qb")],
    );

    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("sun-qb")! }],
        now: AFTER_THURSDAY,
      }),
    ).rejects.toMatchObject({ code: "INVALID_LINEUP" });
  });

  it("knows a released player's kickoff even though the roster does not", async () => {
    // The two functions answering differently is the design, not an accident.
    const fx = await setup();
    await fx.client.query(
      "UPDATE roster_entries SET released_at = now() WHERE team_id = $1 AND player_id = $2",
      [fx.teamId, fx.players.get("thu-qb")],
    );

    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);
    const kickoffs = await loadKickoffs(fx.client, [fx.players.get("thu-qb")!], SEASON, WEEK);

    expect(roster.has(fx.players.get("thu-qb")!)).toBe(false);
    expect(kickoffs.get(fx.players.get("thu-qb")!)).toBe(THURSDAY_SECONDS);
  });

  it("lets the autofill replace a player dropped before his kickoff", async () => {
    // The companion half. A player cut on Tuesday is a hole, not a choice — and
    // leaving him would let his slot lock at kickoff around a man nobody owns,
    // who would then score for the team that cut him.
    const fx = await setup();

    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("thu-qb")! }],
      now: BEFORE_ANYTHING,
    });

    await fx.client.query(
      "UPDATE roster_entries SET released_at = now() WHERE team_id = $1 AND player_id = $2",
      [fx.teamId, fx.players.get("thu-qb")],
    );

    const filled = await autoFillLineup(
      fx.client,
      fx.leagueId,
      fx.teamId,
      WEEK,
      BEFORE_ANYTHING,
    );

    const qb = filled.find((slot) => slot.slotType === "QB" && slot.slotIndex === 0);
    expect(qb?.playerId).not.toBe(fx.players.get("thu-qb"));
    expect(qb?.playerId).toBe(fx.players.get("sun-qb"));
  });

  it("keeps a player dropped after his kickoff, because that slot is locked", async () => {
    const fx = await setup();

    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("thu-qb")! }],
      now: BEFORE_ANYTHING,
    });

    await fx.client.query(
      "UPDATE roster_entries SET released_at = now() WHERE team_id = $1 AND player_id = $2",
      [fx.teamId, fx.players.get("thu-qb")],
    );

    const filled = await autoFillLineup(
      fx.client,
      fx.leagueId,
      fx.teamId,
      WEEK,
      AFTER_THURSDAY,
    );

    const qb = filled.find((slot) => slot.slotType === "QB" && slot.slotIndex === 0);
    expect(qb?.playerId).toBe(fx.players.get("thu-qb"));
  });
});

describe("a lineup that moves under the manager — #100", () => {
  /*
    `setLineup` validated against a lineup it read **before** its transaction
    opened, and `current` is the sole input to both lock guards: `SLOT_LOCKED`
    compares against it, and `PLAYER_LOCKED` uses it to decide whether a slot is
    even changing. An empty slot never locks.

    So: the manager's PUT reads RB1 as empty; the score-week cron's autofill
    commits a mid-game player into RB1; the manager's write lands and neither
    guard fires, because both were evaluated against a slot that was empty when
    it was read. A locked slot holding a player whose game had started was
    replaced — which `season/lineup.ts` names as the exact thing the lock
    exists to prevent.

    **No second human is needed.** The manager races the cron, which runs every
    ten minutes.

    Migration `0016` predicted this in writing and closed only the duplicate
    half with a unique index; the lock half stayed open until now.

    ## Why the interference is injected

    PGlite is a single connection, so the two writers cannot genuinely overlap.
    What can be staged exactly is the ordering that matters: the snapshot is
    taken, *then* somebody else's write commits, *then* our write runs. The proxy
    below performs the interfering write at the instant `setLineup` opens its
    transaction — which is the same interleaving, deterministically.
  */

  /**
   * A client that lets one write land the moment `setLineup` takes its row lock.
   *
   * Keyed on the `FOR UPDATE` statement rather than on `BEGIN`, because that is
   * the first thing inside the transaction and leaves the snapshot already taken.
   */
  /*
    Runs `interfere` immediately before the transaction's `FOR UPDATE` executes.

    **What this proves and what it does not.** PGlite is a single connection, so
    the "other writer" runs on the *same* session as the transaction it is
    interfering with. Two consequences, both stated because neither is obvious
    and one of them makes an assertion here weaker than it reads:

    - The interference lands after the snapshot at `loadLineup` and before the
      lock is taken, which is the window the **compare-and-swap** closes. So
      these tests pin the CAS. They say nothing about the row lock — no test in
      this repo can, and deleting `FOR UPDATE` fails them only because the hook
      keys on that SQL text.
    - The interferer's own `withTransaction` issues a real `COMMIT` on the shared
      connection, which commits the outer transaction too. So a test here cannot
      demonstrate that `setLineup` is atomic; a `ROLLBACK` afterwards would not
      undo what the loop had already written.

    Both are limits of the harness rather than of the code, and both were found
    by the #100 re-audit rather than being known when this was written.
  */
  function interferingAt(client: PGliteClient, interfere: () => Promise<void>): PGliteClient {
    let fired = false;
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return async (sql: string, params?: unknown[]) => {
          const run = (
            target as unknown as {
              query: (s: string, p?: unknown[]) => Promise<unknown>;
            }
          ).query.bind(target);
          if (!fired && sql.includes("FOR UPDATE") && sql.includes("lineups")) {
            fired = true;
            await interfere();
          }
          return run(sql, params);
        };
      },
    }) as PGliteClient;
  }

  it("refuses a write whose slot changed after validation", async () => {
    const fx = await setup();

    // The manager's snapshot: QB is empty.

    const client = interferingAt(fx.client, async () => {
      // Somebody else — the autofill — puts a player in that slot after the
      // snapshot was taken and before the write lands.
      await setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("thu-qb") }],
        now: BEFORE_ANYTHING,
      });
    });

    await expect(
      setLineup(client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("sun-qb") }],
        now: BEFORE_ANYTHING,
      }),
    ).rejects.toSatisfy((e) => e instanceof LineupError && e.code === "LINEUP_MOVED");
  });

  it("leaves the other writer's value in place when it refuses", async () => {
    // The refusal must not be a partial write. What is in the slot afterwards is
    // what the winner put there, not a half-applied version of the loser's
    // request.
    const fx = await setup();

    const client = interferingAt(fx.client, async () => {
      await setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("thu-qb") }],
        now: BEFORE_ANYTHING,
      });
    });

    await expect(
      setLineup(client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("sun-qb") }],
        now: BEFORE_ANYTHING,
      }),
    ).rejects.toThrow();

    const after = await loadLineup(fx.client, fx.teamId, WEEK, fx.rules);
    const held = after.find((slot) => slot.slotType === "QB");
    expect(held?.playerId).toBe(fx.players.get("thu-qb"));
  });

  it("does not revert another writer's change to a slot it did not touch", async () => {
    /*
      **The hole the unchanged-slot exemption left, and it defeated the fix in
      its own headline scenario.**

      The test below asserts that submitting a slot at the value you read is not
      refused — correct, and it is uncontended, so it could not see what the
      write actually did. Unchanged slots were written with no `WHERE`, which
      reverts a concurrent write rather than ignoring it.

      Here the manager changes RB while the autofill fills the QB slot their
      snapshot showed as empty. The QB assignment is unchanged from that
      snapshot, so it must neither refuse nor overwrite.
    */
    const fx = await setup();

    const client = interferingAt(fx.client, async () => {
      await setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("thu-qb") }],
        now: BEFORE_ANYTHING,
      });
    });

    // The whole-snapshot save the editor sends: QB as it was read (empty), RB
    // changed. Only the RB assertion is the manager's.
    await expect(
      setLineup(client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [
          { slotType: "QB", slotIndex: 0, playerId: null },
          { slotType: "RB", slotIndex: 0, playerId: fx.players.get("rb-a") },
        ],
        now: BEFORE_ANYTHING,
      }),
    ).resolves.toBeDefined();

    const after = await loadLineup(fx.client, fx.teamId, WEEK, fx.rules);
    expect(after.find((slot) => slot.slotType === "QB")?.playerId).toBe(
      fx.players.get("thu-qb"),
    );
    expect(after.find((slot) => slot.slotType === "RB")?.playerId).toBe(fx.players.get("rb-a"));
  });

  it("still accepts a save that changes nothing about the moved slot", async () => {
    /*
      The scoping that keeps the editor working. `LineupEditor` posts the whole
      slot list on every dropdown change, from a snapshot up to 30 s old, so a
      whole-lineup compare would refuse every save issued within thirty seconds
      of an autofill pass — reintroducing from the other side the exact failure
      #99 removed.

      Here the manager submits the QB slot holding the value it already holds.
      That asserts nothing, so it must not refuse.
    */
    const fx = await setup();

    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("sun-qb") }],
      now: BEFORE_ANYTHING,
    });

    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("sun-qb") }],
        now: BEFORE_ANYTHING,
      }),
    ).resolves.toBeDefined();
  });
});
