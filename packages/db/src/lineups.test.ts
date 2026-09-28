import { afterEach, describe, expect, it } from "vitest";
import {
  buildNflPprRules,
  buildRosterShape,
  indexScoringRules,
  NFL,
  NFL_PPR_ROSTER,
  NFL_PPR_SCORING,
} from "@rostr/core";
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
  autolineupCandidate,
  ensureLineups,
  teamsWithLineupWork,
  loadAverages,
  LineupError,
  loadKickoffs,
  loadLineup,
  loadProjectedPoints,
  loadOffNflRoster,
  loadRosterForWeek,
  loadWeekLineups,
  loadWeekStats,
  PRIMARY_PROJECTION_SOURCE,
  SEASON_AGGREGATE_WEEK,
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
  /**
   * Player IDs by the handle used below. Prefer `player()` for anything the
   * product reads; see there for why.
   */
  players: Map<string, string>;
  /**
   * A seeded player's id, by handle. Total on purpose.
   *
   * `players.get(handle)!` typechecks and then hands `undefined` to `setLineup`,
   * whose `playerId` is `string | null` where null means *clear this slot*. A
   * mistyped handle therefore stops testing the write the test is named for and
   * starts testing the erase — silently, and green. This throws at the typo
   * instead. Assertions may keep using `players` directly: an `undefined`
   * reaching `expect` already fails loudly.
   */
  player(handle: string): string;
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
    // FLEX-eligible and in the Thursday game. Without him no empty slot can be
    // offered a player who is already playing, which is the whole of #240.
    ["thu-wr", "WR", "PIT"],
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
    player: (handle) => {
      const id = players.get(handle);
      if (id === undefined) {
        throw new Error(
          `no seeded player "${handle}" (have: ${[...players.keys()].join(", ")})`,
        );
      }
      return id;
    },
  };
}

/**
 * A lineup from slot-to-handle pairs.
 *
 * A null handle empties the slot, which is a legal thing for a manager to do
 * and is what the autofill's candidate tests need to set up. An unrecognised
 * handle passes straight through as the id, so a test can name a player the
 * fixture never seeded and watch the product refuse it.
 */
const lineupOf = (fx: Fixture, handles: Record<string, string | null>): LineupAssignment[] =>
  Object.entries(handles).map(([slot, handle]) => {
    const [slotType, index] = slot.split(":");
    return {
      slotType: slotType!,
      slotIndex: Number(index ?? 0),
      playerId: handle === null ? null : (fx.players.get(handle) ?? handle),
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

    expect(roster.size).toBe(13);
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

  it("writes no rows for an opted-out team on an early pass", async () => {
    /*
      Issue #288's fix fills the *coming* week before its games start, and that
      pass scores nothing — so an opted-out team's empty rows would do nothing
      but make their "empty slots, and autofill is off" notice fire days before
      the deadline. `unsetLineups` counts every null row a member holds, in any
      week, so those rows are indistinguishable from being late for this one.
    */
    const fx = await setup();
    await fx.client.query("UPDATE teams SET autofill_enabled = false WHERE id = $1", [
      fx.teamId,
    ]);

    const result = await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING, {
      optedOutRows: "skip",
    });

    // Still counted, so the cron's report does not pretend they were filled.
    expect(result).toMatchObject({ teamsFilled: 1, teamsOptedOut: 1 });

    const [row] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM lineups WHERE team_id = $1 AND week = $2",
      [fx.teamId, WEEK],
    );
    expect(row?.n).toBe(0);

    // The teams that are filled are filled exactly as before.
    const other = await loadLineup(fx.client, fx.otherTeamId, WEEK, fx.rules);
    expect(other.filter((slot) => slot.playerId !== null).length).toBeGreaterThan(0);
  });

  it("fills a week that has no fixtures yet, which is what playoff week 15 is", async () => {
    /*
      The heart of #288: the first autofill pass for a playoff week used to run
      only once that week had `matchups` rows, and those arrive after the
      previous week finalises — for week 15, after its own games have kicked off.
      `ensureLineups` itself never reads `matchups`, and this pins that, so a
      caller can fill a week the fixtures have not reached yet.
    */
    const fx = await setup();
    const [fixtures] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM matchups WHERE league_id = $1 AND week = $2",
      [fx.leagueId, WEEK],
    );
    expect(fixtures?.n).toBe(0);

    const result = await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);
    expect(result.teamsFilled).toBe(2);
    expect(await loadLineup(fx.client, fx.teamId, WEEK, fx.rules)).toHaveLength(9);
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
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("sun-qb") }],
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

    // Thirteen rostered, nine starting.
    expect(mine?.bench).toHaveLength(4);
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
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("thu-qb") }],
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
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("sun-qb") }],
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
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("thu-qb") }],
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
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("thu-qb") }],
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
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("thu-qb") }],
        now: BEFORE_ANYTHING,
      });
    });

    await expect(
      setLineup(client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("sun-qb") }],
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
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("thu-qb") }],
        now: BEFORE_ANYTHING,
      });
    });

    await expect(
      setLineup(client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("sun-qb") }],
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
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("thu-qb") }],
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
          { slotType: "RB", slotIndex: 0, playerId: fx.player("rb-a") },
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
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("sun-qb") }],
      now: BEFORE_ANYTHING,
    });

    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.player("sun-qb") }],
        now: BEFORE_ANYTHING,
      }),
    ).resolves.toBeDefined();
  });
});

describe("the autofill will not take a slot the manager still holds", () => {
  /*
    Issue #240, end to end on the path the cron actually walks.

    The sequence needs no race. A manager empties a slot while its intended
    replacement has not kicked off yet — legal, and performed below through the
    real `setLineup`. The autofill then runs on the next scoring pass and, before
    this was fixed, filled that slot from whoever ranked highest among everyone
    left, including a player already playing. From that instant the slot is
    locked around him and the manager's own edit is refused — and it is
    `SLOT_LOCKED`, not `PLAYER_LOCKED`, so he cannot even blank it back to empty.

    The projections below are the point of the fixture, not decoration. Ranking
    is `WEEKLY_PROJECTION` and an unprojected pool is all nulls, where ties break
    on player id — a UUID coin toss that would make these tests pass or fail for
    reasons having nothing to do with the clock. Projected, `thu-wr` is
    unambiguously the best remaining FLEX and the unfixed autofill takes him
    every time.
  */
  const projectionStatId = async (fx: Fixture): Promise<string> => {
    const [row] = await fx.client.query<{ id: string }>(
      `SELECT k.id FROM stat_keys k JOIN sports s ON s.id = k.sport_id
        WHERE s.key = $1 AND k.key = 'rec_yd'`,
      [NFL.key],
    );
    return row!.id;
  };

  /** `thu-wr` outprojects every other FLEX-eligible player on the roster. */
  const seedProjections = async (fx: Fixture): Promise<void> => {
    const statKeyId = await projectionStatId(fx);
    for (const [handle, value] of [
      ["thu-wr", 120],
      ["wr-c", 40],
      ["rb-c", 30],
    ] as const) {
      await fx.client.query(
        `INSERT INTO player_projections (player_id, season, week, source, stat_key_id, value)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [fx.players.get(handle), SEASON, WEEK, PRIMARY_PROJECTION_SOURCE, statKeyId, value],
      );
    }
  };

  /** A full lineup, then FLEX emptied after the Thursday game has kicked off. */
  const emptyTheFlexAfterThursday = async (fx: Fixture): Promise<void> => {
    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, FULL),
      now: BEFORE_ANYTHING,
    });

    // Legal: his replacement plays Sunday, so the slot is still his to decide.
    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, { ...FULL, "FLEX:0": null }),
      now: AFTER_THURSDAY,
    });
  };

  const flexAfter = async (fx: Fixture): Promise<string | null | undefined> => {
    const lineups = await loadWeekLineups(fx.client, fx.leagueId, WEEK);
    return lineups
      .find((lineup) => lineup.teamId === fx.teamId)
      ?.assignments.find((entry) => entry.slotType === "FLEX")?.playerId;
  };

  it("does not fill an empty slot with a player whose game has started", async () => {
    const fx = await setup();
    await seedProjections(fx);
    await emptyTheFlexAfterThursday(fx);

    await ensureLineups(fx.client, fx.leagueId, WEEK, AFTER_THURSDAY);

    // thu-wr projects highest by a distance and is already playing, so he is not
    // a candidate. The next best whose game has not started takes the slot.
    expect(await flexAfter(fx)).toBe(fx.players.get("wr-c"));
  });

  it("leaves the manager able to change it afterwards", async () => {
    const fx = await setup();
    await seedProjections(fx);
    await emptyTheFlexAfterThursday(fx);

    await ensureLineups(fx.client, fx.leagueId, WEEK, AFTER_THURSDAY);

    // The half that actually cost the manager something. Before the fix this
    // threw INVALID_LINEUP carrying SLOT_LOCKED, because the autofill had put a
    // player already on the field into a slot with hours left to run.
    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, { ...FULL, "FLEX:0": "rb-c" }),
      now: AFTER_THURSDAY + 60,
    });

    expect(await flexAfter(fx)).toBe(fx.players.get("rb-c"));
  });
});

describe("a roster over the limit is frozen, and nobody is picked for it", () => {
  /*
    A team can only get here one way, and it is not something the manager did:
    a player stashed on injured reserve recovers, the exemption is read live,
    and the counted size rises with no row written and nobody having acted.

    While over, the league stops acting for them — the lineup is frozen and the
    autofill picks nobody. It still *tidies*, and that half is not a courtesy:
    the autofill is the only thing that takes a released player out of a stored
    lineup, this manager is required to release somebody, and a released player
    left standing in a slot goes on scoring for the team that cut him while
    being addable by everyone else.

    ESPN behaves the same way in both halves — it never fills a slot for you,
    and it never leaves a player you dropped in your lineup.
  */

  const SHAPE = buildRosterShape(NFL_PPR_ROSTER, NFL);

  /** Top the team up to `rows` unreleased players, all fit and all playing Sunday. */
  const fillTo = async (fx: Fixture, rows: number): Promise<void> => {
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    const [rb] = await fx.client.query<{ id: string }>(
      "SELECT id FROM positions WHERE sport_id = $1 AND key = 'RB'",
      [sport!.id],
    );
    const [held] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM roster_entries WHERE team_id = $1 AND released_at IS NULL",
      [fx.teamId],
    );

    for (let i = held!.n; i < rows; i++) {
      const handle = `filler-${i}`;
      const [player] = await fx.client.query<{ id: string }>(
        `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
         VALUES ($1, $2, $3, $4, 'CIN') RETURNING id`,
        [sport!.id, handle, handle, rb!.id],
      );
      await fx.client.query(
        "INSERT INTO roster_entries (team_id, player_id, acquired_via) VALUES ($1, $2, 'DRAFT')",
        [fx.teamId, player!.id],
      );
    }
  };

  it("refuses a lineup change while over, and allows one at exactly the limit", async () => {
    /*
      The boundary, and the reason it is a test of its own. Every acquisition
      check in the repo asks `counted >= totalSlots` — correct for "may I add
      one more". This rule asks whether the state is illegal, which is only
      `>`. Writing `>=` here would freeze the lineup of every full roster in
      the league, which is most of them for most of the season.
    */
    const fx = await setup();
    await fillTo(fx, SHAPE.totalSlots);

    const legal = await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("sun-qb")! }],
      now: BEFORE_ANYTHING,
    });
    expect(legal).toBeDefined();

    // One more, and the same edit is refused.
    await fillTo(fx, SHAPE.totalSlots + 1);

    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("thu-qb")! }],
        now: BEFORE_ANYTHING,
      }),
    ).rejects.toMatchObject({ code: "ROSTER_OVER_LIMIT" });

    // And says both numbers, because "your roster is full" is the sentence
    // that sends a manager to do the thing that was just refused.
    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("thu-qb")! }],
        now: BEFORE_ANYTHING,
      }),
    ).rejects.toThrow(/15 players and the limit is 14/);
  });

  it("lets the manager edit again the moment somebody is released", async () => {
    // Nothing else has to be cleared, and nobody has to approve it.
    const fx = await setup();
    await fillTo(fx, SHAPE.totalSlots + 1);

    await fx.client.query(
      `UPDATE roster_entries SET released_at = now()
        WHERE team_id = $1 AND player_id = $2`,
      [fx.teamId, fx.players.get("bye-te")],
    );

    await expect(
      setLineup(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        week: WEEK,
        assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("sun-qb")! }],
        now: BEFORE_ANYTHING,
      }),
    ).resolves.toBeDefined();
  });

  it("writes nothing for an over-limit team that opted out, on an early pass", async () => {
    /*
      The tidy above materialises the remaining slots as empty, so on the early
      pass (#288) it reaches exactly the manager `optedOutRows: "skip"` exists to
      protect: autofill off, told days before kickoff that nine slots are empty,
      by a pass that cannot help them. Their scoring-time pass still tidies, and
      nothing has kicked off yet here, so nothing is lost by waiting.
    */
    const fx = await setup();
    await fx.client.query("UPDATE teams SET autofill_enabled = false WHERE id = $1", [
      fx.teamId,
    ]);
    await fillTo(fx, SHAPE.totalSlots + 1);

    const outcome = await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING, {
      optedOutRows: "skip",
    });

    // Still reported, so an operator can still name the team.
    expect(outcome.teamsOverLimit).toEqual([fx.teamId]);

    const [rows] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM lineups WHERE team_id = $1 AND week = $2",
      [fx.teamId, WEEK],
    );
    expect(rows!.n).toBe(0);
  });

  it("still tidies an over-limit team whose autofill is on, on an early pass", async () => {
    const fx = await setup();
    await fillTo(fx, SHAPE.totalSlots + 1);

    const outcome = await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING, {
      optedOutRows: "skip",
    });

    expect(outcome.teamsOverLimit).toEqual([fx.teamId]);
    const [rows] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM lineups WHERE team_id = $1 AND week = $2",
      [fx.teamId, WEEK],
    );
    expect(rows!.n).toBe(SHAPE.starters.length);
  });

  it("still writes a lineup, so the league's week can be scored", async () => {
    /*
      The regression this must never cause. `resolveWeek` throws on a team with
      no lineup at all — scoring one as zero would silently hand its opponent a
      free win — so a team that were simply skipped here would take its whole
      league's week down with it, and in a pot league block settlement. Eleven
      innocent managers would pay for one over-full roster.
    */
    const fx = await setup();
    await fillTo(fx, SHAPE.totalSlots + 1);

    const outcome = await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);

    expect(outcome.teamsOverLimit).toEqual([fx.teamId]);

    const [rows] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM lineups WHERE team_id = $1 AND week = $2",
      [fx.teamId, WEEK],
    );
    expect(rows!.n).toBe(SHAPE.starters.length);

    // Every slot empty: it was tidied, not filled.
    const [filled] = await fx.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lineups
        WHERE team_id = $1 AND week = $2 AND player_id IS NOT NULL`,
      [fx.teamId, WEEK],
    );
    expect(filled!.n).toBe(0);
  });

  it("still fills the other teams in the same league", async () => {
    // Per team, not per league. The other manager did nothing.
    const fx = await setup();
    await fillTo(fx, SHAPE.totalSlots + 1);

    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);

    const [filled] = await fx.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lineups
        WHERE team_id = $1 AND week = $2 AND player_id IS NOT NULL`,
      [fx.otherTeamId, WEEK],
    );
    expect(filled!.n).toBeGreaterThan(0);
  });

  it("takes a released player out of the lineup even though it picks nobody", async () => {
    /*
      The half that is not a courtesy, and the reason "the autofill does not run"
      is the wrong way to build this.

      A manager over the limit is required to release somebody, and a starter is
      the obvious choice. If the lineup were left untouched he would keep
      scoring for the team that cut him — and be addable by everybody else at
      the same time, so one player would score for two teams in one week.
    */
    const fx = await setup();

    // A lineup set while the roster was still legal.
    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: fx.players.get("sun-qb")! }],
      now: BEFORE_ANYTHING,
    });

    // Two over, so releasing one still leaves them over — otherwise the
    // ordinary autofill takes over and fills the slot, which is a different
    // test.
    await fillTo(fx, SHAPE.totalSlots + 2);

    // Still over, the manager releases the quarterback they had started.
    await fx.client.query(
      `UPDATE roster_entries SET released_at = now()
        WHERE team_id = $1 AND player_id = $2`,
      [fx.teamId, fx.players.get("sun-qb")],
    );

    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);

    const [qb] = await fx.client.query<{ player_id: string | null }>(
      `SELECT l.player_id FROM lineups l
         JOIN slot_types st ON st.id = l.slot_type_id
        WHERE l.team_id = $1 AND l.week = $2 AND st.key = 'QB' AND l.slot_index = 0`,
      [fx.teamId, WEEK],
    );

    // Gone, and not replaced.
    expect(qb?.player_id).toBeNull();
  });
});

describe("the autofill ranks an injured player behind a healthy one — #269", () => {
  /*
    `RULES.md` §8 has promised this to every member who signed: "a player with a
    game this week who is not ruled out comes first, because a player on a bye or
    officially out cannot score at all."

    It has never once happened. The check tested `players.status` against a set
    of short codes, and nothing in this repo has ever written that column — so
    the comparison was "ACTIVE" against out-codes and never matched. A signed
    rule that did nothing, which is the third time this repo has found that
    shape after `irSlots` and `botsAllowed`.

    Ranked down, never excluded: QB, K and DEF cap at one apiece, so refusing to
    field a designated kicker would empty that slot for the week with nothing on
    the roster able to fill it.

    **The two that assert the flag are the regression tests.** This fixture
    gives its players random ids and `compare` breaks ties on ascending id, so
    with nobody demoted two equally-ranked quarterbacks are a coin toss. A
    demotion settles that — it is the first term of the comparison, ahead of
    points entirely — so the end-to-end cases below are deterministic *with* the
    rule and decide by chance without it. The cases that read `unavailable`
    directly fail on a revert every time, which is what holds this rule down.
  */

  const designate = async (fx: Fixture, handle: string, designation: string | null) =>
    fx.client.query("UPDATE players SET injury_designation = $2 WHERE id = $1", [
      fx.player(handle),
      designation,
    ]);

  const startedAt = async (fx: Fixture, slot: string, index = 0) => {
    const [row] = await fx.client.query<{ player_id: string | null }>(
      `SELECT l.player_id FROM lineups l
         JOIN slot_types st ON st.id = l.slot_type_id
        WHERE l.team_id = $1 AND l.week = $2 AND st.key = $3 AND l.slot_index = $4`,
      [fx.teamId, WEEK, slot, index],
    );
    return row?.player_id ?? null;
  };

  it("passes over a player who is ruled out, whoever else is available", async () => {
    // Deterministic in the direction that matters: the demoted man loses to
    // anyone not demoted, regardless of how the tie between the others falls.
    const fx = await setup();
    await designate(fx, "sun-qb", "Out");

    await autoFillLineup(fx.client, fx.leagueId, fx.teamId, WEEK, BEFORE_ANYTHING);

    // The fixture holds exactly two quarterbacks, so a demotion decides it
    // outright rather than leaving a tie to a random id.
    expect(await startedAt(fx, "QB")).toBe(fx.player("thu-qb"));
  });

  it("passes over a player whose club is in no week of the schedule, end to end", async () => {
    /*
      **The wiring for the new term**, which the unit tests above cannot see:
      they build the candidate themselves, so a future `autoFillLineup` that
      switched loaders or constructed a literal would fail none of them.

      Built the way #327's case is, for the reason its comment gives: this
      fixture's players carry random ids and `compare` breaks ties on ascending
      id, so two equally-ranked quarterbacks are a coin toss and a test asserting
      `thu-qb` against an unranked pair would pass about half the time on unfixed
      code. `sun-qb` is projected well first, and the control run below proves the
      edge works — so only a demotion can explain him losing the slot afterwards.

      `active` is deliberately left true and `team_ref` deliberately left set.
      That is the row neither #308's term nor #327's can catch.
    */
    const fx = await setup();

    const [statKey] = await fx.client.query<{ id: string }>(
      `SELECT k.id FROM stat_keys k JOIN sports s ON s.id = k.sport_id
        WHERE s.key = $1 AND k.key = 'pass_yd'`,
      [NFL.key],
    );
    await fx.client.query(
      `INSERT INTO player_projections (player_id, season, week, source, stat_key_id, value)
       VALUES ($1, $2, $3, $4, $5, 400)`,
      [fx.player("sun-qb"), SEASON, WEEK, PRIMARY_PROJECTION_SOURCE, statKey!.id],
    );

    // The control: well projected, and his club is in the schedule, so he starts.
    await autoFillLineup(fx.client, fx.leagueId, fx.teamId, WEEK, BEFORE_ANYTHING);
    expect(await startedAt(fx, "QB")).toBe(fx.player("sun-qb"));

    // Now his club matches no fixture in any week. He keeps `active` and keeps a
    // ref, so only `!teamScheduled` can demote him.
    await fx.client.query("UPDATE players SET team_ref = 'ZZZ' WHERE id = $1", [
      fx.player("sun-qb"),
    ]);
    await fx.client.query("DELETE FROM lineups WHERE team_id = $1 AND week = $2", [
      fx.teamId,
      WEEK,
    ]);

    await autoFillLineup(fx.client, fx.leagueId, fx.teamId, WEEK, BEFORE_ANYTHING);

    expect(await startedAt(fx, "QB")).toBe(fx.player("thu-qb"));
  });

  it("passes over a released player, end to end — #327", async () => {
    /*
      **The wiring, which no unit test can see.**

      The `autolineupCandidate` tests above build the set themselves, so
      narrowing the id list `autoFillLineup` loads it over — or deleting that
      load and passing an empty set — fails none of them. The set means "off an
      NFL roster" by *membership*, so an under-populated one silently marks
      everybody available: it fails **open**, which is the one direction this
      whole change is about.

      `team_ref` is deliberately left set. That is the row `teamRef` cannot
      catch, so this asserts the new term is genuinely reaching the write path
      rather than the old one covering for it.
    */
    const fx = await setup();

    /*
      **`sun-qb` is made the better player first, and that is what makes this
      test mean anything.**

      This fixture gives its players random ids and `compare` breaks ties on
      ascending id, so two equally-ranked quarterbacks are a coin toss — the
      block comment above says so. A test asserting `thu-qb` against an
      unranked pair therefore passes about half the time on *unfixed* code,
      which is worse than no test. Projecting `sun-qb` well means only a
      demotion can explain him losing the slot.
    */
    const [statKey] = await fx.client.query<{ id: string }>(
      `SELECT k.id FROM stat_keys k JOIN sports s ON s.id = k.sport_id
        WHERE s.key = $1 AND k.key = 'pass_yd'`,
      [NFL.key],
    );
    await fx.client.query(
      `INSERT INTO player_projections (player_id, season, week, source, stat_key_id, value)
       VALUES ($1, $2, $3, $4, $5, 400)`,
      [fx.player("sun-qb"), SEASON, WEEK, PRIMARY_PROJECTION_SOURCE, statKey!.id],
    );

    // The control: well projected and still listed, he takes the slot.
    await autoFillLineup(fx.client, fx.leagueId, fx.teamId, WEEK, BEFORE_ANYTHING);
    expect(await startedAt(fx, "QB")).toBe(fx.player("sun-qb"));

    // Released. `team_ref` is left set on purpose — this is the row a
    // `teamRef` check cannot catch, so only the new term can demote him.
    await fx.client.query("UPDATE players SET active = false WHERE id = $1", [
      fx.player("sun-qb"),
    ]);
    await fx.client.query("DELETE FROM lineups WHERE team_id = $1 AND week = $2", [
      fx.teamId,
      WEEK,
    ]);

    await autoFillLineup(fx.client, fx.leagueId, fx.teamId, WEEK, BEFORE_ANYTHING);

    expect(await startedAt(fx, "QB")).toBe(fx.player("thu-qb"));
  });

  it("passes over one on injured reserve, which is issue #270's player", async () => {
    const fx = await setup();
    await designate(fx, "sun-qb", "Injured Reserve");

    await autoFillLineup(fx.client, fx.leagueId, fx.teamId, WEEK, BEFORE_ANYTHING);

    expect(await startedAt(fx, "QB")).toBe(fx.player("thu-qb"));
  });

  it("still starts him when there is nobody else, because an empty slot scores nothing", async () => {
    /*
      The half that stops this stranding a roster. `defaultPositionCaps` puts K
      and DEF at one apiece, so a designated kicker is the only kicker — and a
      rule that refused to field him would leave that slot empty every week with
      no possible remedy.

      ESPN and Yahoo both work this way: they substitute when a healthy
      alternative exists, and neither leaves a slot empty rather than field
      somebody injured.
    */
    const fx = await setup();
    await designate(fx, "k-a", "Injured Reserve");

    await autoFillLineup(fx.client, fx.leagueId, fx.teamId, WEEK, BEFORE_ANYTHING);

    expect(await startedAt(fx, "K")).toBe(fx.player("k-a"));
  });

  it("does not demote a questionable player, or one nobody has recorded", async () => {
    /*
      Asserted on the flag rather than on who wins, because two undemoted players
      tie and the tie breaks on a random id.

      Questionable is five of every eight designated players and the one value
      meaning he may still play. An unrecorded designation ranks normally too,
      which is the opposite of the IR rule's polarity and is what makes an
      incomplete vocabulary harmless here.
    */
    const fx = await setup();
    await designate(fx, "sun-qb", "Questionable");
    await designate(fx, "thu-qb", "Physically Unable To Perform");

    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);

    for (const handle of ["sun-qb", "thu-qb"]) {
      const player = roster.get(fx.player(handle))!;
      const candidate = autolineupCandidate(
        player,
        { averageMilliPoints: null, projectedMilliPoints: null },
        new Set(),
      );
      expect(candidate.unavailable).toBe(false);
    }
  });

  it("marks a player with no club ref unavailable, and a null kickoff does not", async () => {
    /*
      **The trap this test exists for: `kickoffAt` is not null for a cut player,
      and reading the code quickly says it is.**

      `loadKickoffs` is the lock oracle and fails closed. A player whose club has
      no games *in the season* hits its third branch and is handed the **week's
      first kickoff**, so his slot freezes rather than staying open all Sunday.
      Correct for a lock, and exactly wrong as a proxy for "will he play": it
      made him read as available and then ranked him on a projection nothing
      expires.

      An earlier version of this comment glossed that condition as "which is
      every player with `team_ref IS NULL`". That equation is the bug in
      miniature and is why this looked settled — the gate is whether the *club*
      appears in the season's schedule, and a released player who keeps his
      abbreviation sails through it. See the test below.

      So this asserts the state as well as the conclusion. Without the
      `kickoffAt` line it would pass against a `teamRef`-only check by accident,
      and a reader would go on believing the null-kickoff story.
    */
    const fx = await setup();
    await fx.client.query("UPDATE players SET team_ref = NULL WHERE id = $1", [
      fx.player("sun-qb"),
    ]);

    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);
    const player = roster.get(fx.player("sun-qb"))!;

    // The premise, stated so it cannot rot silently.
    expect(player.kickoffAt).not.toBeNull();
    expect(player.teamRef).toBeNull();

    const candidate = autolineupCandidate(
      player,
      // A stale projection from before he was released is exactly the input
      // that makes this dangerous: it would outrank a fit bench player.
      { averageMilliPoints: 18_000, projectedMilliPoints: 18_000 },
      // Empty on purpose: `active` is still true for him, so the club-ref term
      // is the only thing that can fire. This is the half a move to `active`
      // alone would have dropped.
      new Set(),
    );

    // A sort key, not an exclusion — a team with nobody else still fields him.
    expect(candidate.unavailable).toBe(true);
    expect(candidate.playerId).toBe(fx.player("sun-qb"));
  });

  it("marks a released player unavailable even when he keeps his club — #327", async () => {
    /*
      **The live bug, and the half `teamRef` could never catch.**

      `active` and `team_ref` come from different provider fields — `isFreeAgent`
      and `team` — so a released player can keep his abbreviation. He then joins
      his *old* club's real fixture, so his kickoff is genuine, his designation
      is usually cleared, and `teamRef` never fires. He read as fully
      **available** and was ranked on a season average nothing expires.

      That is the receiver cut in week 6 after two good games, started in week 7
      over a fit bench player for a guaranteed zero.
    */
    const fx = await setup();
    await fx.client.query("UPDATE players SET active = false WHERE id = $1", [
      fx.player("sun-qb"),
    ]);

    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);
    const player = roster.get(fx.player("sun-qb"))!;

    // Both premises, because the point of the case is that neither fires.
    expect(player.teamRef).not.toBeNull();
    expect(player.kickoffAt).not.toBeNull();

    const offNflRoster = await loadOffNflRoster(fx.client, [...roster.keys()]);
    const candidate = autolineupCandidate(
      player,
      { averageMilliPoints: 18_000, projectedMilliPoints: 18_000 },
      offNflRoster,
    );

    expect(candidate.unavailable).toBe(true);
  });

  it("marks a player whose club is in no week of the schedule unavailable", async () => {
    /*
      The third member of the class, and the one neither #308 nor #327 caught.

      He is listed by a club — `players.active` is true — but his `team_ref` is a
      string no fixture carries, so his game cannot be located in any week.
      `loadRosterForWeek` hands him the week's first kickoff so his slot still
      freezes, which is right for a lock and is exactly what hid him here: his
      kickoff is non-null, his ref is non-null, his designation is clear, and
      `active` is true. All four existing terms miss him, so he ranked as fully
      available on an average nothing expires.

      Dies if the `!teamScheduled` conjunct is deleted.
    */
    const fx = await setup();
    await fx.client.query("UPDATE players SET team_ref = 'ZZZ' WHERE id = $1", [
      fx.player("sun-qb"),
    ]);

    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);
    const player = roster.get(fx.player("sun-qb"))!;

    // The three premises, because the case exists to show that none of them fire.
    expect(player.teamRef).not.toBeNull();
    expect(player.kickoffAt).not.toBeNull();
    const offNflRoster = await loadOffNflRoster(fx.client, [...roster.keys()]);
    expect(offNflRoster.has(fx.player("sun-qb"))).toBe(false);

    const candidate = autolineupCandidate(
      player,
      { averageMilliPoints: 18_000, projectedMilliPoints: 18_000 },
      offNflRoster,
    );

    expect(candidate.unavailable).toBe(true);
    // Demoted, never excluded: a team with nobody else at the position still
    // fields him and scores the zero an empty slot would have scored.
    expect(candidate.playerId).toBe(fx.player("sun-qb"));
  });

  it("keeps a bye player's club scheduled, because the flag is season-wide", async () => {
    /*
      **The only assertion that can see a week-scoped spelling of the flag**, and
      the reason it needs its own case.

      A bye player is already unavailable through `kickoffAt === null`, so the
      test below passes whether the flag is season-wide or week-scoped. But narrow
      it to the week and `teamScheduled` goes false for every club on its bye —
      and the moment this flag reaches a label, as it did on the scoreboard in
      #341, that would tell every bye player his club is nowhere in the schedule.

      Asserting the flag directly is what stops that. It also kills a mapper that
      drops the field or hardcodes it true.
    */
    const fx = await setup();

    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);

    // SEA plays in WEEK + 1 and not in WEEK — in the schedule, absent this week.
    expect(roster.get(fx.player("bye-te"))!.teamScheduled).toBe(true);
    // And the control, so the assertion above cannot pass by the flag being
    // hardcoded: the unlocatable ref really does read false.
    await fx.client.query("UPDATE players SET team_ref = 'ZZZ' WHERE id = $1", [
      fx.player("sun-qb"),
    ]);
    const after = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);
    expect(after.get(fx.player("sun-qb"))!.teamScheduled).toBe(false);
  });

  it("still ranks a bye player unavailable", async () => {
    /*
      The clause a reader of #308 is most likely to delete.

      "`loadRosterForWeek` synthesises a kickoff, so `kickoffAt === null` is
      dead" is an attractive simplification and it is wrong: the synthesis only
      applies to a club with no games *in the season*. A club that is in the
      schedule and simply has no game this week — an ordinary bye — still gets
      `null`, and `RULES.md` §8 promises those players are demoted.
    */
    const fx = await setup();

    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);
    const player = roster.get(fx.player("bye-te"))!;

    expect(player.kickoffAt).toBeNull();
    expect(player.teamRef).not.toBeNull();

    const candidate = autolineupCandidate(
      player,
      { averageMilliPoints: 9_000, projectedMilliPoints: 9_000 },
      new Set(),
    );

    expect(candidate.unavailable).toBe(true);
  });

  it("loads who is off NFL rosters, keyed on active rather than a club ref — #308", async () => {
    /*
      The sibling loader, and the two cases a `team_ref` check gets wrong.

      `loadOffNflRoster` exists so the lineup screen can say why a released
      player will not score **without** widening `loadRosterForWeek`, which is
      `validateLineup`'s ownership oracle. That is the same argument
      `loadByeWeeks` and `loadTbdKickoffs` make — though neither of those has a
      direct test either, which is its own small gap.
    */
    const fx = await setup();

    // Released but the provider still prints a club — `active` and `team_ref`
    // come from different fields (`isFreeAgent` and `team`), so this row is
    // representable and a `teamRef` check says nothing is wrong with it.
    await fx.client.query("UPDATE players SET active = false WHERE id = $1", [
      fx.player("sun-qb"),
    ]);
    // Listed, but with no club stored — the mirror image. A `teamRef` check
    // would wrongly accuse him.
    await fx.client.query("UPDATE players SET team_ref = NULL WHERE id = $1", [
      fx.player("rb-a"),
    ]);

    const off = await loadOffNflRoster(fx.client, [fx.player("sun-qb"), fx.player("rb-a")]);

    expect(off.has(fx.player("sun-qb"))).toBe(true);
    expect(off.has(fx.player("rb-a"))).toBe(false);
  });

  it("asks the database nothing when there is nobody to ask about", async () => {
    // The guard both siblings carry: `= ANY('{}')` is legal but a round trip
    // for an answer we already know, and an empty roster is the ordinary state
    // of a league that has not drafted.
    const fx = await setup();

    expect((await loadOffNflRoster(fx.client, [])).size).toBe(0);
  });

  it("marks one who is ruled out unavailable, without excluding him", async () => {
    const fx = await setup();
    await designate(fx, "sun-qb", "Doubtful");

    const roster = await loadRosterForWeek(fx.client, fx.teamId, SEASON, WEEK);
    const candidate = autolineupCandidate(
      roster.get(fx.player("sun-qb"))!,
      { averageMilliPoints: null, projectedMilliPoints: null },
      new Set(),
    );

    // A sort key, not an exclusion: he is still a candidate.
    expect(candidate.unavailable).toBe(true);
    expect(candidate.playerId).toBe(fx.player("sun-qb"));
  });
});

describe("the autofill ranks on something real in week 1 — #287", () => {
  /*
    No production caller ever passed a week to `syncProjections`, so only the
    season aggregate was written and `loadProjectedPoints` — which asks for the
    real week — came back empty every week of every season. A league whose
    signed rules say `WEEKLY_PROJECTION` silently ranked on season averages.

    In week 1 that was worse than a downgrade. `loadAverages` returns all-null
    for `week <= 1` — correctly, there is no prior week to average — so with no
    projections either, every candidate ranked `null` and `compare` fell
    through to its last tie-break, which compares player ids. Those are
    `gen_random_uuid()`. Launch weekend was a lottery, and because the autofill
    never revisits a slot it filled, the lottery result stood for the week.
  */

  const project = async (
    fx: Fixture,
    week: number,
    values: readonly [string, number][],
  ): Promise<void> => {
    const [key] = await fx.client.query<{ id: string }>(
      `SELECT k.id FROM stat_keys k
         JOIN sports s ON s.id = k.sport_id
        WHERE s.key = $1 AND k.key = 'rec_yd'`,
      [NFL.key],
    );

    for (const [handle, value] of values) {
      await fx.client.query(
        `INSERT INTO player_projections (player_id, season, week, stat_key_id, source, value)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (player_id, season, week, stat_key_id, source)
         DO UPDATE SET value = EXCLUDED.value`,
        [fx.player(handle), SEASON, week, key!.id, PRIMARY_PROJECTION_SOURCE, value],
      );
    }
  };

  it("uses the week's projections when the week has them", async () => {
    const fx = await setup();
    // wr-c is the worse receiver by season average; the week says otherwise.
    await project(fx, WEEK, [
      ["wr-a", 10],
      ["wr-c", 900],
    ]);

    const projected = await loadProjectedPoints(fx.client, SEASON, WEEK, fx.rules);

    expect(projected.get(fx.player("wr-c"))).toBeGreaterThan(projected.get(fx.player("wr-a"))!);
  });

  it("falls back to the season projection when the week has none", async () => {
    /*
      The safety net, and the case that was permanently live before #287: the
      ingest only ever wrote week 0, so this is what every real week hit.
    */
    const fx = await setup();
    await project(fx, SEASON_AGGREGATE_WEEK, [
      ["wr-a", 10],
      ["wr-c", 900],
    ]);

    const projected = await loadProjectedPoints(fx.client, SEASON, WEEK, fx.rules);

    expect(projected.size).toBeGreaterThan(0);
    expect(projected.get(fx.player("wr-c"))).toBeGreaterThan(projected.get(fx.player("wr-a"))!);
  });

  it("never mixes the two, because a season total dwarfs a week's", async () => {
    /*
      All or nothing, deliberately. A map holding one player's weekly number
      beside another's season total would rank everybody with a weekly row
      below everybody without one — not a fallback, a corruption. So a week
      with any projections at all uses only those.
    */
    const fx = await setup();
    await project(fx, SEASON_AGGREGATE_WEEK, [["wr-a", 900]]);
    await project(fx, WEEK, [["wr-c", 10]]);

    const projected = await loadProjectedPoints(fx.client, SEASON, WEEK, fx.rules);

    // Only the player the week names. The season row is not consulted at all.
    expect(projected.has(fx.player("wr-c"))).toBe(true);
    expect(projected.has(fx.player("wr-a"))).toBe(false);
  });

  it("gives week 1 a real ranking instead of a uuid ordering", async () => {
    /*
      The launch-weekend case. `loadAverages` is all-null at week 1 by design,
      so before this the whole ranking was `playerId.localeCompare`.

      Asserted by running the fill twice against two different projections and
      requiring it to follow them. Under uuid ordering the answer cannot change,
      because the ids do not.
    */
    const first = await setup();
    await project(first, SEASON_AGGREGATE_WEEK, [
      ["wr-a", 900],
      ["wr-b", 10],
      ["wr-c", 10],
    ]);
    await autoFillLineup(first.client, first.leagueId, first.teamId, WEEK, BEFORE_ANYTHING);

    const second = await setup();
    await project(second, SEASON_AGGREGATE_WEEK, [
      ["wr-a", 10],
      ["wr-b", 900],
      ["wr-c", 10],
    ]);
    await autoFillLineup(second.client, second.leagueId, second.teamId, WEEK, BEFORE_ANYTHING);

    const startedWr = async (fx: Fixture) => {
      const rows = await fx.client.query<{ player_id: string }>(
        `SELECT l.player_id FROM lineups l
           JOIN slot_types st ON st.id = l.slot_type_id
          WHERE l.team_id = $1 AND l.week = $2 AND st.key = 'WR'
            AND l.player_id IS NOT NULL`,
        [fx.teamId, WEEK],
      );
      return rows.map((row) => row.player_id);
    };

    // Each run starts the receiver its own projections favour.
    expect(await startedWr(first)).toContain(first.player("wr-a"));
    expect(await startedWr(second)).toContain(second.player("wr-b"));
  });
});

describe("the autofill records what it decided on", () => {
  /*
    Four places promise this — RULES.md §8, autolineup.ts, DECISIONS.md, and the
    doc on the hashed `autofill` rule field itself — and until migration 0047
    nothing recorded anything. The promise cannot be withdrawn: `roster.autofill`
    is frozen per league, so for every league that already exists the mode cannot
    be changed and the sentence members signed stands. See issue #267.
  */

  const stored = async (fx: Fixture, teamId: string, week = WEEK) =>
    fx.client.query<{
      player_id: string | null;
      autofilled_at: string | null;
      ranked_milli_points: number | null;
      ranked_on: string | null;
      ranked_source: string | null;
    }>(
      `SELECT player_id, autofilled_at, ranked_milli_points, ranked_on, ranked_source
         FROM lineups WHERE team_id = $1 AND week = $2`,
      [teamId, week],
    );

  it("stores the number it ranked on, and where the number came from", async () => {
    const fx = await setup();
    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);

    const rows = await stored(fx, fx.teamId);
    const filled = rows.filter((row) => row.player_id !== null);
    expect(filled.length).toBeGreaterThan(0);

    for (const row of filled) {
      expect(row.autofilled_at).not.toBeNull();
      // Per player, not per league: a player with no projection is ranked on his
      // average even under WEEKLY_PROJECTION, so both answers are legal here —
      // what is not legal is a value with no basis, or a basis with no value.
      expect(["PROJECTION", "AVERAGE", null]).toContain(row.ranked_on);
      expect(row.ranked_milli_points === null).toBe(row.ranked_on === null);
      if (row.ranked_on !== "PROJECTION") expect(row.ranked_source).toBeNull();
    }
  });

  it("survives a projections resync, which is what made this unreconstructable", async () => {
    /*
      `player_projections` is upserted `DO UPDATE SET value = EXCLUDED.value` on a
      key with no revision and no `as_of`, so the number the autofill ranked on is
      destroyed by the next sync. That is why reading the decision back out of the
      inputs is not merely unimplemented but impossible, and why this column is
      the only place the answer can live.
    */
    const fx = await setup();

    // 300 passing yards at 0.04/yd is 12 points — a number to be ranked on, and
    // then to be destroyed by the resync below.
    const [statKey] = await fx.client.query<{ id: string }>(
      `SELECT k.id FROM stat_keys k JOIN sports s ON s.id = k.sport_id
        WHERE s.key = $1 AND k.key = 'pass_yd'`,
      [NFL.key],
    );
    await fx.client.query(
      `INSERT INTO player_projections (player_id, season, week, source, stat_key_id, value)
       VALUES ($1, $2, $3, $4, $5, 300)`,
      [fx.player("sun-qb"), SEASON, WEEK, PRIMARY_PROJECTION_SOURCE, statKey!.id],
    );

    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);

    const before = await stored(fx, fx.teamId);
    const qb = before.find((row) => row.player_id === fx.player("sun-qb"));
    expect(qb?.ranked_milli_points).toBe(12_000);
    expect(qb?.ranked_on).toBe("PROJECTION");
    expect(qb?.ranked_source).toBe(PRIMARY_PROJECTION_SOURCE);

    // The resync: same key, new number, in place. Nothing records the old one.
    await fx.client.query(
      "UPDATE player_projections SET value = value + 100, updated_at = now()",
    );
    const [projection] = await fx.client.query<{ value: number }>(
      "SELECT value FROM player_projections WHERE player_id = $1",
      [fx.player("sun-qb")],
    );
    expect(Number(projection!.value)).toBe(400);

    const after = await stored(fx, fx.teamId);
    expect(
      after.find((row) => row.player_id === fx.player("sun-qb"))?.ranked_milli_points,
    ).toBe(12_000);
  });

  it("leaves a slot a person set alone", async () => {
    // A manual save writes through a different insert, so these columns stay
    // null — which is itself the signal that the autofill did not decide it.
    const fx = await setup();

    await setLineup(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      week: WEEK,
      assignments: lineupOf(fx, FULL),
      now: BEFORE_ANYTHING,
    });

    const rows = await stored(fx, fx.teamId);
    const mine = rows.find((row) => row.player_id === fx.player("sun-qb"));
    expect(mine).toBeDefined();
    expect(mine?.autofilled_at).toBeNull();
    expect(mine?.ranked_milli_points).toBeNull();
  });

  it("does not overwrite the record of a slot it merely kept", async () => {
    /*
      A second pass copies an already-filled slot through without ranking
      anything, so its ranked value is null — and writing that over the first
      pass's record erases the decision these columns exist to keep.

      **The projection below is what makes this test able to fail.** Without it
      every slot is ranked on null anyway, nulls overwrite nulls, and the bug is
      invisible: which is exactly what happened when this test was first written.
      A mutation that always overwrote passed against it, and the defect it hid
      was real — `chosen` did not exist yet, and a kept slot was being stamped as
      freshly decided.
    */
    const fx = await setup();
    const [statKey] = await fx.client.query<{ id: string }>(
      `SELECT k.id FROM stat_keys k JOIN sports s ON s.id = k.sport_id
        WHERE s.key = $1 AND k.key = 'pass_yd'`,
      [NFL.key],
    );
    await fx.client.query(
      `INSERT INTO player_projections (player_id, season, week, source, stat_key_id, value)
       VALUES ($1, $2, $3, $4, $5, 300)`,
      [fx.player("sun-qb"), SEASON, WEEK, PRIMARY_PROJECTION_SOURCE, statKey!.id],
    );

    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);
    const first = await stored(fx, fx.teamId);
    const qbFirst = first.find((row) => row.player_id === fx.player("sun-qb"));
    expect(qbFirst?.ranked_milli_points).toBe(12_000);

    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);
    const qbSecond = (await stored(fx, fx.teamId)).find(
      (row) => row.player_id === fx.player("sun-qb"),
    );

    expect(qbSecond?.ranked_milli_points).toBe(12_000);
    expect(qbSecond?.ranked_on).toBe("PROJECTION");
    // Compared by value: the driver hands back Date objects, so identity fails
    // on two reads of the same row.
    expect(String(qbSecond?.autofilled_at)).toBe(String(qbFirst?.autofilled_at));
  });
});

describe("teamsWithLineupWork", () => {
  it("counts every team before a fill, and the under-rostered one after", async () => {
    // The guard that keeps the ~250 ticks between the Wednesday and kickoff from
    // re-running the whole autofill per team when there is nothing to write.
    // The fixture's other team holds one quarterback, so eight of its slots stay
    // empty however often this runs — and it goes on counting, deliberately: the
    // next waiver claim is exactly what would fill them.
    const fx = await setup();
    expect(await teamsWithLineupWork(fx.client, fx.leagueId, WEEK)).toBe(2);

    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);
    expect(await teamsWithLineupWork(fx.client, fx.leagueId, WEEK)).toBe(1);
  });

  it("is zero once a full roster is filled, which is what lets the pass skip", async () => {
    const fx = await setup();
    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);

    const [row] = await fx.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lineups
        WHERE team_id = $1 AND week = $2 AND player_id IS NULL`,
      [fx.teamId, WEEK],
    );
    expect(row?.n).toBe(0);

    // Only the under-rostered other team is left, so a league of full rosters
    // reaches zero and the tick does one query instead of two autofills.
    await fx.client.query("UPDATE teams SET autofill_enabled = false WHERE id = $1", [
      fx.otherTeamId,
    ]);
    expect(await teamsWithLineupWork(fx.client, fx.leagueId, WEEK)).toBe(0);
  });

  it("counts a team holding a player it has released", async () => {
    /*
      The reason this is not simply "has any row". `autoFillLineup` is the only
      thing that evicts a released player, and his slot otherwise locks at his
      kickoff around a player nobody rosters — who then scores for the team that
      cut him. For weeks 1-14 the scoring-time fill would catch it; week 15
      cannot be scored until week 14 finalises on the Monday, which is #288, so
      nothing else reaches it before that week is played.
    */
    const fx = await setup();
    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);
    await fx.client.query("UPDATE teams SET autofill_enabled = false WHERE id = $1", [
      fx.otherTeamId,
    ]);
    expect(await teamsWithLineupWork(fx.client, fx.leagueId, WEEK)).toBe(0);

    const [started] = await fx.client.query<{ player_id: string }>(
      `SELECT player_id FROM lineups
        WHERE team_id = $1 AND week = $2 AND player_id IS NOT NULL LIMIT 1`,
      [fx.teamId, WEEK],
    );
    await fx.client.query(
      "UPDATE roster_entries SET released_at = now() WHERE team_id = $1 AND player_id = $2",
      [fx.teamId, started!.player_id],
    );

    expect(await teamsWithLineupWork(fx.client, fx.leagueId, WEEK)).toBe(1);
  });

  it("does not count a team that opted out, which the early fill skips", async () => {
    // Counting it would leave the answer permanently non-zero, and the guard
    // would then never skip anything.
    const fx = await setup();
    await fx.client.query("UPDATE teams SET autofill_enabled = false WHERE id IN ($1, $2)", [
      fx.teamId,
      fx.otherTeamId,
    ]);
    expect(await teamsWithLineupWork(fx.client, fx.leagueId, WEEK)).toBe(0);
  });

  it("counts each week separately", async () => {
    const fx = await setup();
    await ensureLineups(fx.client, fx.leagueId, WEEK, BEFORE_ANYTHING);
    expect(await teamsWithLineupWork(fx.client, fx.leagueId, WEEK + 1)).toBe(2);
  });
});
