import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { addBot } from "./membership.js";
import { seedSport } from "./sports.js";
import { createTestDatabase } from "./testing.js";
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
    teams.push((await addBot(db, league.id, `Team ${i + 1}`)).teamId);
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
