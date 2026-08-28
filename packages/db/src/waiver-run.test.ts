import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { dropPlayer, processWaivers, seedWaiverPriority, submitClaim } from "./waivers.js";
import { lastWaiverRun } from "./waiver-run.js";

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
};

const DAY = 24 * 60 * 60 * 1000;
/** Monday afternoon ET, comfortably inside the waiver window. */
const MONDAY = new Date("2026-09-14T18:00:00Z");
/** Wednesday 07:00 UTC is 03:00 ET — the processing moment. */
const WEDNESDAY = new Date("2026-09-16T08:00:00Z");

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  teams: string[];
  players: Map<string, string>;
}

/** Two teams, one holding a player who is about to be dropped onto waivers. */
async function setup(): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const league = await createLeague(db, NFL, {
    name: "Waiver Run League",
    commissionerId: commissioner.id,
    rules: buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules,
  });

  /*
    In season, because that is where these tests live.

    `createLeague` leaves a league `FORMING`, and since #279 a roster move is
    refused outside `IN_SEASON`/`PLAYOFFS` — the draft is how a roster is filled
    before then. Every fixture here describes a league that has drafted and is
    playing; without this line they describe one that cannot transact at all,
    which is a different subject from the one being tested.

    Set directly rather than driven through `startDraft` and a full pick
    sequence, which would make every waiver test a draft test.
  */
  await db.query("UPDATE leagues SET state = 'IN_SEASON' WHERE id = $1", [league.id]);

  const teams: string[] = [];
  for (let i = 0; i < 2; i++) {
    teams.push((await addTestTeam(db, league.id, `Team ${i + 1}`)).teamId);
  }
  for (const [index, teamId] of teams.entries()) {
    await db.query("UPDATE teams SET draft_position = $1 WHERE id = $2", [index + 1, teamId]);
  }

  const [sport] = await db.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    NFL.key,
  ]);
  const [rb] = await db.query<{ id: string }>(
    "SELECT id FROM positions WHERE sport_id = $1 AND key = 'RB'",
    [sport!.id],
  );

  const players = new Map<string, string>();
  for (const handle of ["prize", "held"]) {
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $3, $4, 'CIN') RETURNING id`,
      [sport!.id, handle, handle, rb!.id],
    );
    players.set(handle, row!.id);
  }

  // Team 1 has held him a week, so dropping him sends him to waivers rather
  // than straight to free agency.
  await db.query(
    `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
     VALUES ($1, $2, 'DRAFT', $3)`,
    [teams[0], players.get("prize"), new Date(MONDAY.getTime() - 7 * DAY)],
  );

  await seedWaiverPriority(db, league.id);

  return { client: db, leagueId: league.id, teams, players };
}

/** Both teams claim the same player; the run settles it. */
async function contestedRun(fx: Fixture): Promise<void> {
  await dropPlayer(fx.client, fx.leagueId, fx.teams[0]!, fx.players.get("prize")!, MONDAY);

  for (const teamId of fx.teams) {
    await submitClaim(fx.client, {
      leagueId: fx.leagueId,
      teamId,
      addPlayerId: fx.players.get("prize")!,
      now: MONDAY,
    });
  }

  await processWaivers(fx.client, fx.leagueId, WEDNESDAY);
}

describe("lastWaiverRun", () => {
  it("answers null before any run has settled", async () => {
    const fx = await setup();
    // The ordinary state before the first Wednesday of a season, not an error.
    expect(await lastWaiverRun(fx.client, fx.leagueId)).toBeNull();
  });

  it("returns every team's claims, not only one team's", async () => {
    const fx = await setup();
    await contestedRun(fx);

    // "Somebody with better priority took him" is unverifiable if you can only
    // see your own row. `RULES.md` makes the resolution public by design.
    const run = await lastWaiverRun(fx.client, fx.leagueId);
    expect(run?.claims).toHaveLength(2);
    expect(new Set(run?.claims.map((claim) => claim.teamId))).toEqual(new Set(fx.teams));
  });

  it("says which claim won", async () => {
    const fx = await setup();
    await contestedRun(fx);

    const run = await lastWaiverRun(fx.client, fx.leagueId);
    const winners = run?.claims.filter((claim) => claim.awarded) ?? [];
    expect(winners).toHaveLength(1);

    // Priority 1 wins, and priority is seeded **reversed** from the draft order
    // — the team that drafted last picks first off waivers. Asserted through
    // the recorded priority rather than a team index, because an index bakes
    // that reversal into the test as an assumption, which is how this test was
    // wrong the first time.
    expect(winners[0]?.priorityAtClaim).toBe(1);
  });

  it("says why the loser lost", async () => {
    const fx = await setup();
    await contestedRun(fx);

    // The whole point of `0039`. Before it a loser was told FAILED and nothing
    // else, and "somebody outranked you" and "your roster was full" are not the
    // same news.
    const run = await lastWaiverRun(fx.client, fx.leagueId);
    const loser = run?.claims.find((claim) => !claim.awarded);
    expect(loser?.failureReason).toBe("PLAYER_TAKEN");
  });

  it("carries the priority each team held when the run began", async () => {
    const fx = await setup();
    await contestedRun(fx);

    const run = await lastWaiverRun(fx.client, fx.leagueId);
    // Recorded by the run, never recomputed — the winner has since moved to the
    // back, so deriving it now would report the wrong contest.
    expect(run?.claims.map((claim) => claim.priorityAtClaim)).toEqual([1, 2]);
  });

  it("names the players rather than making the screen look them up", async () => {
    const fx = await setup();
    await contestedRun(fx);

    const run = await lastWaiverRun(fx.client, fx.leagueId);
    expect(run?.claims[0]?.addPlayerName).toBe("prize");
    // Rows come back in priority order, and priority reverses the draft — so
    // the first row is the team that drafted last.
    expect(run?.claims.map((claim) => claim.teamName).sort()).toEqual(["Team 1", "Team 2"]);
  });

  it("returns one run, not everything that happened that day", async () => {
    const fx = await setup();
    await contestedRun(fx);

    // A second run settles nothing new, and must not be merged with the first —
    // merging two runs would show the same player awarded twice.
    await processWaivers(fx.client, fx.leagueId, new Date(WEDNESDAY.getTime() + 60_000));

    const run = await lastWaiverRun(fx.client, fx.leagueId);
    const stamps = new Set(run?.claims.map((claim) => claim.awarded));
    expect(run?.claims).toHaveLength(2);
    expect(stamps.size).toBeGreaterThan(0);
  });
});

describe("the reason constraint", () => {
  it("will not record a reason against a winning claim", async () => {
    const fx = await setup();
    await contestedRun(fx);

    // `0039`'s check. A reason on a winner is a row nothing could render.
    await expect(
      fx.client.query(
        "UPDATE waiver_claims SET failure_reason = 'PLAYER_TAKEN' WHERE state = 'AWARDED'",
      ),
    ).rejects.toBeTruthy();
  });
});
