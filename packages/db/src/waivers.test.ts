import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import {
  addFreeAgent,
  availabilityOf,
  availablePlayers,
  cancelClaim,
  dropPlayer,
  loadWaiverPriority,
  pendingClaims,
  processWaivers,
  seedWaiverPriority,
  submitClaim,
} from "./waivers.js";

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

const MONDAY = new Date("2026-09-14T18:00:00Z");
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  rules: LeagueRules;
  teams: string[];
  players: Map<string, string>;
}

/** Four teams; one holds a small roster, the rest are empty. */
async function setup(): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules;
  const league = await createLeague(db, NFL, {
    name: "Waiver League",
    commissionerId: commissioner.id,
    rules,
  });

  const teams: string[] = [];
  for (let i = 0; i < 4; i++) {
    teams.push((await addTestTeam(db, league.id, `Team ${i + 1}`)).teamId);
  }

  // Draft positions, so waiver priority can be seeded from them.
  for (const [index, teamId] of teams.entries()) {
    await db.query("UPDATE teams SET draft_position = $1 WHERE id = $2", [index + 1, teamId]);
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

  const players = new Map<string, string>();
  const roster: [string, string][] = [
    ["held", "RB"],
    ["fresh", "WR"],
    ["target", "WR"],
    ["other", "RB"],
    ["spare", "TE"],
  ];

  for (const [handle, position] of roster) {
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $3, $4, 'CIN') RETURNING id`,
      [sport!.id, handle, handle, positions.get(position)!],
    );
    players.set(handle, row!.id);
  }

  // Team 1 holds two players: one for a week, one added minutes ago.
  await db.query(
    `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
     VALUES ($1, $2, 'DRAFT', $3), ($1, $4, 'FREE_AGENT', $5)`,
    [
      teams[0],
      players.get("held"),
      new Date(MONDAY.getTime() - 7 * DAY),
      players.get("fresh"),
      new Date(MONDAY.getTime() - 30 * 60 * 1000),
    ],
  );

  await seedWaiverPriority(db, league.id);

  return { client: db, leagueId: league.id, rules, teams, players };
}

describe("waiver priority", () => {
  it("starts as the reverse of the draft order", async () => {
    // The team that picked last claims first.
    const fx = await setup();
    const priority = await loadWaiverPriority(fx.client, fx.leagueId);

    expect(priority).toEqual([...fx.teams].reverse());
  });
});

describe("dropping", () => {
  it("sends a long-held player to waivers", async () => {
    const fx = await setup();

    const result = await dropPlayer(
      fx.client,
      fx.leagueId,
      fx.teams[0]!,
      fx.players.get("held")!,
      MONDAY,
    );

    expect(result.destination).toBe("WAIVERS");
    expect(await availabilityOf(fx.client, fx.leagueId, fx.players.get("held")!, MONDAY)).toBe(
      "ON_WAIVERS",
    );
  });

  it("sends a briefly-held player straight to free agency", async () => {
    // ESPN's rule. It stops a manager adding someone, cutting him hours later,
    // and re-adding him to dodge the claim queue.
    const fx = await setup();

    const result = await dropPlayer(
      fx.client,
      fx.leagueId,
      fx.teams[0]!,
      fx.players.get("fresh")!,
      MONDAY,
    );

    expect(result.destination).toBe("FREE_AGENT");
    expect(await availabilityOf(fx.client, fx.leagueId, fx.players.get("fresh")!, MONDAY)).toBe(
      "FREE_AGENT",
    );
  });

  it("refuses to drop someone else's player", async () => {
    const fx = await setup();

    await expect(
      dropPlayer(fx.client, fx.leagueId, fx.teams[1]!, fx.players.get("held")!, MONDAY),
    ).rejects.toMatchObject({ code: "NOT_ON_ROSTER" });
  });

  it("frees the roster spot immediately", async () => {
    const fx = await setup();
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, MONDAY);

    const [count] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM roster_entries WHERE team_id = $1 AND released_at IS NULL",
      [fx.teams[0]],
    );
    expect(Number(count?.n)).toBe(1);
  });
});

describe("free agency", () => {
  it("adds a free agent immediately", async () => {
    const fx = await setup();

    await addFreeAgent(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teams[1]!,
      addPlayerId: fx.players.get("target")!,
      now: MONDAY,
    });

    expect(
      await availabilityOf(fx.client, fx.leagueId, fx.players.get("target")!, MONDAY),
    ).toBe("ROSTERED");
  });

  it("refuses a player who is on waivers", async () => {
    // First come first served is exactly what waivers exist to prevent, so the
    // error has to say "claim him" rather than "try again".
    const fx = await setup();
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, MONDAY);

    await expect(
      addFreeAgent(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teams[1]!,
        addPlayerId: fx.players.get("held")!,
        now: MONDAY,
      }),
    ).rejects.toMatchObject({ code: "NOT_A_FREE_AGENT" });
  });

  it("refuses a player somebody already has", async () => {
    const fx = await setup();

    await expect(
      addFreeAgent(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teams[1]!,
        addPlayerId: fx.players.get("held")!,
        now: MONDAY,
      }),
    ).rejects.toMatchObject({ code: "PLAYER_TAKEN" });
  });

  it("allows him once he clears", async () => {
    const fx = await setup();
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, MONDAY);

    // A week later the wire time has passed.
    const later = new Date(MONDAY.getTime() + 8 * DAY);
    expect(await availabilityOf(fx.client, fx.leagueId, fx.players.get("held")!, later)).toBe(
      "FREE_AGENT",
    );

    await expect(
      addFreeAgent(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teams[1]!,
        addPlayerId: fx.players.get("held")!,
        now: later,
      }),
    ).resolves.toBeUndefined();
  });

  it("swaps a player out in the same transaction", async () => {
    const fx = await setup();

    await addFreeAgent(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teams[0]!,
      addPlayerId: fx.players.get("target")!,
      dropPlayerId: fx.players.get("held")!,
      now: MONDAY,
    });

    const [count] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM roster_entries WHERE team_id = $1 AND released_at IS NULL",
      [fx.teams[0]],
    );
    expect(Number(count?.n)).toBe(2);
    expect(await availabilityOf(fx.client, fx.leagueId, fx.players.get("held")!, MONDAY)).toBe(
      "ON_WAIVERS",
    );
  });
});

describe("claims", () => {
  async function onWaivers(fx: Fixture): Promise<string> {
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, MONDAY);
    return fx.players.get("held")!;
  }

  it("accepts a claim for a player on waivers", async () => {
    const fx = await setup();
    const playerId = await onWaivers(fx);

    const { claimId } = await submitClaim(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teams[1]!,
      addPlayerId: playerId,
      now: MONDAY,
    });

    expect(claimId).toBeTruthy();
    expect(await pendingClaims(fx.client, fx.leagueId, fx.teams[1]!)).toHaveLength(1);
  });

  it("refuses a claim for a free agent", async () => {
    const fx = await setup();

    await expect(
      submitClaim(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teams[1]!,
        addPlayerId: fx.players.get("target")!,
        now: MONDAY,
      }),
    ).rejects.toMatchObject({ code: "NOT_ON_WAIVERS" });
  });

  it("refuses the same claim twice", async () => {
    const fx = await setup();
    const playerId = await onWaivers(fx);
    const claim = {
      leagueId: fx.leagueId,
      teamId: fx.teams[1]!,
      addPlayerId: playerId,
      now: MONDAY,
    };

    await submitClaim(fx.client, claim);
    await expect(submitClaim(fx.client, claim)).rejects.toMatchObject({
      code: "DUPLICATE_CLAIM",
    });
  });

  it("can be withdrawn", async () => {
    const fx = await setup();
    const playerId = await onWaivers(fx);

    const { claimId } = await submitClaim(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teams[1]!,
      addPlayerId: playerId,
      now: MONDAY,
    });
    await cancelClaim(fx.client, fx.leagueId, fx.teams[1]!, claimId);

    expect(await pendingClaims(fx.client, fx.leagueId, fx.teams[1]!)).toEqual([]);
  });
});

describe("processing", () => {
  /** Put `held` on waivers and have several teams claim him. */
  async function contested(fx: Fixture, claimants: number[]): Promise<string> {
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, MONDAY);

    for (const index of claimants) {
      await submitClaim(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teams[index]!,
        addPlayerId: fx.players.get("held")!,
        now: MONDAY,
      });
    }

    return fx.players.get("held")!;
  }

  const WEDNESDAY = new Date(MONDAY.getTime() + 2 * DAY);

  it("awards a contested player to the best priority", async () => {
    // Priority is the reverse of the draft order, so team 4 outranks team 2.
    const fx = await setup();
    const playerId = await contested(fx, [1, 3]);

    const outcome = await processWaivers(fx.client, fx.leagueId, WEDNESDAY);

    expect(outcome.awarded).toBe(1);
    expect(outcome.failed).toBe(1);

    const [winner] = await fx.client.query<{ team_id: string }>(
      `SELECT team_id FROM roster_entries
        WHERE player_id = $1 AND released_at IS NULL AND acquired_via = 'WAIVER'`,
      [playerId],
    );
    expect(winner?.team_id).toBe(fx.teams[3]);
  });

  it("sends the winner to the back of the order", async () => {
    const fx = await setup();
    await contested(fx, [3]);

    const before = await loadWaiverPriority(fx.client, fx.leagueId);
    const outcome = await processWaivers(fx.client, fx.leagueId, WEDNESDAY);

    expect(before[0]).toBe(fx.teams[3]);
    expect(outcome.priorityAfter[outcome.priorityAfter.length - 1]).toBe(fx.teams[3]);
    expect(await loadWaiverPriority(fx.client, fx.leagueId)).toEqual(outcome.priorityAfter);
  });

  it("leaves a losing team's priority untouched", async () => {
    // A failed claim costs nothing, so there is no reason to hoard claims.
    const fx = await setup();
    await contested(fx, [1, 3]);

    await processWaivers(fx.client, fx.leagueId, WEDNESDAY);
    const after = await loadWaiverPriority(fx.client, fx.leagueId);

    // Team 2 lost, so it keeps its place ahead of everyone who did not win.
    expect(after.indexOf(fx.teams[1]!)).toBeLessThan(after.indexOf(fx.teams[3]!));
  });

  it("takes the player off the wire when awarded", async () => {
    const fx = await setup();
    const playerId = await contested(fx, [3]);

    await processWaivers(fx.client, fx.leagueId, WEDNESDAY);

    const [wire] = await fx.client.query<{ player_id: string }>(
      "SELECT player_id FROM waiver_wire WHERE league_id = $1 AND player_id = $2",
      [fx.leagueId, playerId],
    );
    expect(wire).toBeUndefined();
  });

  it("records why a losing claim failed", async () => {
    const fx = await setup();
    await contested(fx, [1, 3]);

    await processWaivers(fx.client, fx.leagueId, WEDNESDAY);

    const rows = await fx.client.query<{ state: string }>(
      "SELECT state FROM waiver_claims WHERE league_id = $1 ORDER BY state",
      [fx.leagueId],
    );
    expect(rows.map((row) => row.state)).toEqual(["AWARDED", "FAILED"]);
  });

  it("clears unclaimed players into free agency", async () => {
    const fx = await setup();
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, MONDAY);

    // Nobody claimed him, and his wire time has passed by the following week.
    const nextWeek = new Date(MONDAY.getTime() + 9 * DAY);
    const outcome = await processWaivers(fx.client, fx.leagueId, nextWeek);

    expect(outcome.cleared).toBe(1);
    expect(
      await availabilityOf(fx.client, fx.leagueId, fx.players.get("held")!, nextWeek),
    ).toBe("FREE_AGENT");
  });

  it("does not clear a player who is still on waivers", async () => {
    // Dropped Monday afternoon, so he clears at the Wednesday 03:00 ET run —
    // 07:00 UTC. A run on Tuesday comes before that and must leave him alone.
    const fx = await setup();
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, MONDAY);

    const tuesday = new Date(MONDAY.getTime() + DAY);
    const outcome = await processWaivers(fx.client, fx.leagueId, tuesday);

    expect(outcome.cleared).toBe(0);
    expect(await availabilityOf(fx.client, fx.leagueId, fx.players.get("held")!, tuesday)).toBe(
      "ON_WAIVERS",
    );
  });

  it("clears him at the run he was waiting for", async () => {
    // The other side of the same clock: WEDNESDAY here is 18:00 UTC, well past
    // the 03:00 ET run, so an unclaimed player is free by then.
    const fx = await setup();
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, MONDAY);

    const outcome = await processWaivers(fx.client, fx.leagueId, WEDNESDAY);

    expect(outcome.cleared).toBe(1);
    expect(
      await availabilityOf(fx.client, fx.leagueId, fx.players.get("held")!, WEDNESDAY),
    ).toBe("FREE_AGENT");
  });

  it("does nothing when there are no claims", async () => {
    const fx = await setup();

    const outcome = await processWaivers(fx.client, fx.leagueId, WEDNESDAY);

    expect(outcome).toMatchObject({ awarded: 0, failed: 0 });
  });

  it("puts a dropped player onto waivers, not into the same run's clear", async () => {
    // He landed after the sweep and his own wire time has not passed, so being
    // caught by it would make him instantly claimable by whoever was fastest.
    const fx = await setup();
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, MONDAY);

    await submitClaim(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teams[0]!,
      addPlayerId: fx.players.get("held")!,
      dropPlayerId: fx.players.get("fresh")!,
      now: MONDAY,
    });

    // `fresh` was added half an hour before Monday, so by Wednesday he has been
    // held long enough to go to waivers rather than straight to free agency.
    await processWaivers(fx.client, fx.leagueId, WEDNESDAY);

    expect(
      await availabilityOf(fx.client, fx.leagueId, fx.players.get("fresh")!, WEDNESDAY),
    ).toBe("ON_WAIVERS");
  });

  it("is replayable — same inputs, same result", async () => {
    // The property that lets a disputed run be re-run rather than argued about.
    const fx = await setup();
    await contested(fx, [1, 2, 3]);

    const first = await processWaivers(fx.client, fx.leagueId, WEDNESDAY);
    const second = await processWaivers(fx.client, fx.leagueId, WEDNESDAY);

    // The second run has nothing left to do, which is itself the guarantee: a
    // processed claim is never processed twice.
    expect(first.awarded).toBe(1);
    expect(second.awarded).toBe(0);
  });
});

describe("availablePlayers", () => {
  it("lists everyone unrostered", async () => {
    const fx = await setup();
    const available = await availablePlayers(fx.client, fx.leagueId, MONDAY);

    // Five players exist; team 1 holds two.
    expect(available).toHaveLength(3);
  });

  it("distinguishes waivers from free agency", async () => {
    const fx = await setup();
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, MONDAY);

    const available = await availablePlayers(fx.client, fx.leagueId, MONDAY);
    const held = available.find((p) => p.playerId === fx.players.get("held"));

    expect(held?.availability).toBe("ON_WAIVERS");
    expect(held?.clearsAt).toBeInstanceOf(Date);
    expect(available.filter((p) => p.availability === "FREE_AGENT")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// One owner per league
// ---------------------------------------------------------------------------

/**
 * Migration `0022`, correcting the comment `0005` shipped.
 *
 * **These tests do not attempt to reproduce the race.** PGlite is a single
 * connection, so the interleaving that produced the bug cannot happen here and a
 * test claiming to show it would be theatre. What is testable — and what the
 * application code now leans on — is that the constraint exists and refuses, so
 * that is asserted directly, at the table, with no application code in the way.
 */
describe("one owner per league", () => {
  /** Insert a roster row with no application code in between. */
  function put(fx: Fixture, teamId: string, playerId: string): Promise<unknown[]> {
    return fx.client.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
       VALUES ($1, $2, 'FREE_AGENT', $3)`,
      [teamId, playerId, MONDAY.toISOString()],
    );
  }

  it("refuses the same player active on two teams in one league", async () => {
    // The finding. `0005` claimed this and enforced only the per-team case, so
    // two managers could hold one player and both start him in the same week.
    const fx = await setup();

    await expect(put(fx, fx.teams[1]!, fx.players.get("held")!)).rejects.toMatchObject({
      code: "23505",
    });

    const owners = await fx.client.query<{ team_id: string }>(
      `SELECT team_id FROM roster_entries
        WHERE league_id = $1 AND player_id = $2 AND released_at IS NULL`,
      [fx.leagueId, fx.players.get("held")!],
    );
    expect(owners).toHaveLength(1);
  });

  it("still refuses the same player twice on one team", async () => {
    // The guarantee the dropped `roster_entries_one_owner` index did provide.
    // (league, player) subsumes (team, player) because a team is in one league,
    // but subsumption is worth a test rather than an argument.
    const fx = await setup();

    await expect(put(fx, fx.teams[0]!, fx.players.get("held")!)).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("does not reach across leagues", async () => {
    // League-scoped, not global. Two leagues drafting the same real footballer
    // is the normal case, and a constraint that stopped it would be a worse bug
    // than the one it fixed.
    const fx = await setup();

    const other = await createLeague(fx.client, NFL, {
      name: "Other League",
      commissionerId: (await createUser(fx.client, "other@example.com", "Other")).id,
      rules: fx.rules,
    });
    const otherTeam = await addTestTeam(fx.client, other.id, "Elsewhere");

    await expect(put(fx, otherTeam.teamId, fx.players.get("held")!)).resolves.toBeDefined();
  });

  it("lets a released player be picked up again", async () => {
    // The index is partial on `released_at IS NULL`, so history does not block a
    // re-add — which matters because this table is append-only and a player can
    // legitimately be dropped and re-signed several times in a season.
    const fx = await setup();
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("fresh")!, MONDAY);

    await expect(put(fx, fx.teams[2]!, fx.players.get("fresh")!)).resolves.toBeDefined();

    // Joined through `teams` rather than reading `roster_entries.league_id`, so
    // this one assertion holds on the schema either side of migration `0022` —
    // it is a control, not a demonstration.
    const rows = await fx.client.query<{ released_at: string | null }>(
      `SELECT r.released_at FROM roster_entries r
         JOIN teams t ON t.id = r.team_id
        WHERE t.league_id = $1 AND r.player_id = $2`,
      [fx.leagueId, fx.players.get("fresh")!],
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.released_at === null)).toHaveLength(1);
  });

  it("derives league_id from the team rather than trusting the writer", async () => {
    // The denormalisation only works if it cannot disagree with `teams`. A
    // writer's value is overwritten, not checked, so there is no second opinion
    // to reconcile — and no writer has to remember the column.
    const fx = await setup();
    const other = await createLeague(fx.client, NFL, {
      name: "Wrong League",
      commissionerId: (await createUser(fx.client, "wrong@example.com", "Wrong")).id,
      rules: fx.rules,
    });

    await fx.client.query(
      `INSERT INTO roster_entries (team_id, player_id, league_id, acquired_via, acquired_at)
       VALUES ($1, $2, $3, 'FREE_AGENT', $4)`,
      [fx.teams[1]!, fx.players.get("target")!, other.id, MONDAY.toISOString()],
    );

    const [row] = await fx.client.query<{ league_id: string }>(
      "SELECT league_id FROM roster_entries WHERE player_id = $1",
      [fx.players.get("target")!],
    );
    expect(row?.league_id).toBe(fx.leagueId);
  });

  it("fails a claim for a player somebody already holds, rather than wedging", async () => {
    // This state arises routinely, and that is the whole point of the test.
    // `clears_at` is a processing instant and the cron is hourly, so a player who
    // has cleared can be plainly added while a claim for him is still outstanding
    // — no race required, just an ordinary Wednesday.
    //
    // `resolveWaiverClaims` does not consult other teams' rosters, so it would
    // award that claim; the insert then violates the one-owner index; and with no
    // catch the run rolls back with the claim still PENDING and the roster
    // unchanged — so **every later run fails identically, forever**, taking every
    // unrelated claim in the league with it. Turning a silent corruption into a
    // permanent league-wide outage is not a fix.
    const fx = await setup();
    const playerId = fx.players.get("held")!;
    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, playerId, MONDAY);
    await submitClaim(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teams[3]!,
      addPlayerId: playerId,
      now: MONDAY,
    });

    // Somebody else ends up holding him before the run.
    await put(fx, fx.teams[2]!, playerId);

    const wednesday = new Date(MONDAY.getTime() + 2 * DAY);
    const run = await processWaivers(fx.client, fx.leagueId, wednesday);

    expect(run.awarded).toBe(0);
    expect(run.failed).toBe(1);

    const owners = await fx.client.query<{ team_id: string }>(
      `SELECT team_id FROM roster_entries
        WHERE league_id = $1 AND player_id = $2 AND released_at IS NULL`,
      [fx.leagueId, playerId],
    );
    expect(owners.map((row) => row.team_id)).toEqual([fx.teams[2]]);

    // Resolved, not left for the next run to trip over again.
    const [claim] = await fx.client.query<{ state: string }>(
      "SELECT state FROM waiver_claims WHERE league_id = $1 AND add_player_id = $2",
      [fx.leagueId, playerId],
    );
    expect(claim?.state).toBe("FAILED");
  });

  it("does not take unrelated claims down with a stale one", async () => {
    // The cost of the old behaviour was never one claim. A rollback discarded
    // the whole resolution, so a manager whose claim had nothing to do with the
    // contested player also got nothing, every hour, indefinitely.
    const fx = await setup();
    const contested = fx.players.get("held")!;
    const unrelated = fx.players.get("target")!;

    // Both have to reach waivers to be claimable at all — a free agent is added,
    // not claimed. Held since well before the drop, so neither takes the
    // short-tenure route straight back to free agency.
    await fx.client.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
       VALUES ($1, $2, 'DRAFT', $3)`,
      [fx.teams[1], unrelated, new Date(MONDAY.getTime() - 7 * DAY).toISOString()],
    );

    await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, contested, MONDAY);
    await dropPlayer(fx.client, fx.leagueId, fx.teams[1]!, unrelated, MONDAY);

    await submitClaim(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teams[3]!,
      addPlayerId: contested,
      now: MONDAY,
    });
    await submitClaim(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teams[1]!,
      addPlayerId: unrelated,
      now: MONDAY,
    });

    await put(fx, fx.teams[2]!, contested);

    const run = await processWaivers(
      fx.client,
      fx.leagueId,
      new Date(MONDAY.getTime() + 2 * DAY),
    );

    expect(run.awarded).toBe(1);

    const [owner] = await fx.client.query<{ team_id: string }>(
      `SELECT team_id FROM roster_entries
        WHERE league_id = $1 AND player_id = $2 AND released_at IS NULL`,
      [fx.leagueId, unrelated],
    );
    expect(owner?.team_id).toBe(fx.teams[1]);
  });
});

describe("RULES.md §6 — a player whose game has kicked off cannot be moved", () => {
  /**
   * The constitution has said this since it was frozen, and nothing implemented
   * it:
   *
   * > A player cannot be added or dropped once **his own game has kicked off**.
   * > Otherwise a manager could cut an injured player mid-game, or add one after
   * > his touchdown.
   *
   * Both halves were live. Cutting a started player reopened the lineup slot he
   * was in — and because a released player is still scored from the stored
   * lineup, cutting one who had already done well kept his points *and* freed
   * the roster spot, so twelve roster slots fielded thirteen contributors.
   */
  const KICKOFF = new Date("2026-09-13T17:00:00Z");
  const DURING = new Date(KICKOFF.getTime() + 60_000);
  const BEFORE = new Date(KICKOFF.getTime() - 60_000);

  /** Give the league a real week-1 schedule; the base fixture has none. */
  async function withSchedule(fx: Fixture): Promise<void> {
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    await fx.client.query(
      `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at)
       VALUES ($1, 'wk1', 2026, 1, 'CIN', 'BAL', $2)`,
      [sport!.id, KICKOFF],
    );
  }

  it("refuses a drop once the player's game has started", async () => {
    const fx = await setup();
    await withSchedule(fx);

    await expect(
      dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, DURING),
    ).rejects.toMatchObject({ code: "GAME_STARTED" });
  });

  it("still allows the drop before kickoff", async () => {
    const fx = await setup();
    await withSchedule(fx);

    await expect(
      dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, BEFORE),
    ).resolves.toMatchObject({ destination: expect.any(String) });
  });

  it("refuses adding a player whose game has started", async () => {
    // The other half of the same sentence. Harmless today only because
    // `PLAYER_LOCKED` refuses to start him — which is a second line of defence,
    // not the rule itself.
    const fx = await setup();
    await withSchedule(fx);

    await expect(
      addFreeAgent(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teams[1]!,
        addPlayerId: fx.players.get("target")!,
        now: DURING,
      }),
    ).rejects.toMatchObject({ code: "GAME_STARTED" });
  });

  it("refuses an add whose drop side has started, not just the add side", async () => {
    // `addFreeAgent` releases a roster row too. Without this the guard in
    // `dropPlayer` is decorative — the same release, reached by another button.
    const fx = await setup();
    await withSchedule(fx);

    await expect(
      addFreeAgent(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teams[0]!,
        addPlayerId: fx.players.get("target")!,
        dropPlayerId: fx.players.get("held")!,
        now: DURING,
      }),
    ).rejects.toMatchObject({ code: "GAME_STARTED" });
  });

  it("stays silent when the week has no schedule at all", async () => {
    // No games, no kickoff times, nothing to compare against. `setLineup`
    // already refuses that case loudly for the decision that actually matters,
    // and a waiver move is not the place to discover the sync has not run.
    const fx = await setup();

    await expect(
      dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("held")!, DURING),
    ).resolves.toMatchObject({ destination: expect.any(String) });
  });

  /**
   * The release — which the first version of this guard got wrong.
   *
   * It asked `currentWeek`, "the week of the most recent kickoff", which keeps
   * answering week N until week N+1 kicks off on the Thursday. So it refused
   * every add and drop for days after a week's games had ended, swallowing the
   * Tuesday turnover and the Wednesday 03:00 ET free-agency opening that §6's
   * own cycle table guarantees.
   *
   * The fixture is the shape that would have caught it: **two** weeks on the
   * calendar, so "the week under test" and "the week the code picks" can differ,
   * and instants sampled across the whole cycle rather than sixty seconds either
   * side of one kickoff. A lock with no release test is a lock with untested
   * scope.
   */
  async function withTwoWeeks(fx: Fixture): Promise<void> {
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    await fx.client.query(
      `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at)
       VALUES ($1, 'w1-sun', 2026, 1, 'CIN', 'BAL', $2),
              ($1, 'w2-thu', 2026, 2, 'BUF', 'NYJ', $3),
              ($1, 'w2-sun', 2026, 2, 'CIN', 'BAL', $4)`,
      [sport!.id, KICKOFF, new Date("2026-09-18T00:15:00Z"), new Date("2026-09-20T17:00:00Z")],
    );
  }

  it("releases the lock at the weekly turnover, not at the next kickoff", async () => {
    // Tuesday 00:30 ET. Every week-1 game has been played, the cycle has rolled
    // over, and §6 says every unrostered player has returned to waivers.
    const fx = await setup();
    await withTwoWeeks(fx);

    await expect(
      dropPlayer(
        fx.client,
        fx.leagueId,
        fx.teams[0]!,
        fx.players.get("held")!,
        new Date("2026-09-15T04:30:00Z"),
      ),
    ).resolves.toMatchObject({ destination: expect.any(String) });
  });

  it("leaves free agency open at Wednesday 03:00 ET", async () => {
    // The one assertion that fails on the first version of this guard. The
    // constitution opens free agency at this instant; the guard was closing it.
    const fx = await setup();
    await withTwoWeeks(fx);

    await expect(
      addFreeAgent(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teams[1]!,
        addPlayerId: fx.players.get("target")!,
        now: new Date("2026-09-16T07:05:00Z"),
      }),
    ).resolves.toBeUndefined();
  });

  it("still refuses while the week is live, after his own game has ended", async () => {
    // Sunday 23:00 ET. His game is long over but the week is not, and releasing
    // here is the tempting misreading of §6: his points are already banked in
    // the stored lineup, so a freed roster spot buys a Monday-night starter and
    // twelve roster slots field thirteen contributors.
    const fx = await setup();
    await withTwoWeeks(fx);

    await expect(
      dropPlayer(
        fx.client,
        fx.leagueId,
        fx.teams[0]!,
        fx.players.get("held")!,
        new Date("2026-09-14T03:00:00Z"),
      ),
    ).rejects.toMatchObject({ code: "GAME_STARTED" });
  });

  it("locks again the following week, so it is a rule and not a week-1 case", async () => {
    const fx = await setup();
    await withTwoWeeks(fx);

    await expect(
      dropPlayer(
        fx.client,
        fx.leagueId,
        fx.teams[0]!,
        fx.players.get("held")!,
        new Date("2026-09-20T17:30:00Z"),
      ),
    ).rejects.toMatchObject({ code: "GAME_STARTED" });
  });
});
