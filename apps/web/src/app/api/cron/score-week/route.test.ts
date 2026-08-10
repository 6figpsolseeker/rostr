import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import { createPostgresClient } from "@rostr/db/postgres";
import type { PostgresClient } from "@rostr/db/postgres";
import { createLeague } from "@rostr/db";
import { createUser } from "@rostr/db";
import { seedSport } from "@rostr/db";
import { GET } from "./route.js";

/**
 * One league's failure must never stop the others scoring.
 *
 * This is the property the cron's per-league catch exists for, and until now
 * nothing exercised it — `apps/web` had no test project, so the guard was
 * argued about rather than run. It shipped once already in a shape that did not
 * hold.
 *
 * The failure used here is a `StandingsError`, deliberately. `BracketError` was
 * the reported symptom, but the defect was the *shape* of the guard: an
 * `instanceof` allowlist rethrows every class it does not name, and these error
 * types share no base class. So a test that only proved `BracketError` is
 * handled would pass against a fix that leaves the next class exactly as
 * exposed — which is precisely what "add BracketError to the allowlist" is.
 *
 * Needs `DATABASE_URL`: the route builds a real pool, and the point is to run
 * the route rather than a copy of its logic.
 */

const url = process.env["DATABASE_URL"];

let db: PostgresClient;
const created: string[] = [];

const DRAFT = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
} as const;

const stamp = `${Date.now()}`;

/** A league in season, with a finalised one-week regular season. */
async function league(
  name: string,
  teamCount: number,
): Promise<{ id: string; teams: string[] }> {
  const commissioner = await createUser(db, `cron-${name}-${stamp}@example.test`, "Commish");
  const rules = buildNflPprRules({ seasonYear: 2026, draft: DRAFT });

  const made = await createLeague(db, NFL, {
    name: `cron-${name}-${stamp}`,
    commissionerId: commissioner.id,
    rules,
  });
  created.push(made.id);

  const teams: string[] = [];
  for (let i = 0; i < teamCount; i++) {
    const [user] = await db.query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`,
      [`cron-${name}-${stamp}-${i}@example.test`, `T${i}`],
    );
    const [team] = await db.query<{ id: string }>(
      `INSERT INTO teams (league_id, owner_id, is_bot, name, slot)
       VALUES ($1, $2, false, $3, $4) RETURNING id`,
      [made.id, user!.id, `Team ${i + 1}`, i + 1],
    );
    teams.push(team!.id);
  }

  // A one-week regular season, finalised, so the playoff path is reached.
  for (let i = 0; i + 1 < teamCount; i += 2) {
    await db.query(
      `INSERT INTO matchups
         (league_id, week, phase, home_team_id, away_team_id,
          home_milli_points, away_milli_points, finalized_at)
       VALUES ($1, 1, 'REGULAR', $2, $3, $4, $5, now())`,
      [made.id, teams[i], teams[i + 1], 200_000 - i * 1000, 100_000 - i * 1000],
    );
  }

  await db.query("UPDATE leagues SET state = 'IN_SEASON' WHERE id = $1", [made.id]);
  return { id: made.id, teams };
}

beforeAll(async () => {
  if (!url) return;
  db = createPostgresClient(url);
  await seedSport(db, NFL);
});

afterAll(async () => {
  if (!url) return;
  // Every matchup first, then every team. The whole point of this fixture is a
  // row in one league that names a team in another, so deleting league by
  // league trips the foreign key.
  for (const id of created) {
    await db.query("DELETE FROM matchups WHERE league_id = $1", [id]);
  }
  for (const id of created) {
    await db.query(
      "DELETE FROM lineups WHERE team_id IN (SELECT id FROM teams WHERE league_id = $1)",
      [id],
    );
    await db.query("DELETE FROM teams WHERE league_id = $1", [id]);
    await db.query("UPDATE leagues SET state = 'DISSOLVED' WHERE id = $1", [id]);
  }
  await db.end();
});

describe.skipIf(!url)("score-week isolates one league's failure", () => {
  it("scores a healthy league even when another league's standings throw", async () => {
    const healthy = await league("healthy", 8);
    const broken = await league("broken", 8);

    // A matchup naming a team that is not in this league. `computeStandings`
    // refuses it — rightly, it cannot rank a team it has never heard of — and
    // that throw lands inside the cron's playoff block, which is the block that
    // used to rethrow anything it did not recognise.
    await db.query(
      `INSERT INTO matchups
         (league_id, week, phase, home_team_id, away_team_id,
          home_milli_points, away_milli_points, finalized_at)
       VALUES ($1, 1, 'REGULAR', $2, $3, 1000, 2000, now())`,
      [broken.id, broken.teams[0], healthy.teams[0]],
    );

    try {
      // `?week=1` rather than the schedule pointer, so the test does not depend
      // on which NFL games happen to be ingested.
      const response = await GET(new Request("http://localhost/api/cron/score-week?week=1"));
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        leagues: { leagueId: string; bracketProblem?: string; skipped?: string }[];
      };

      // Both leagues were reached. On the unfixed guard the StandingsError
      // escapes the loop and rejects the whole request, so nothing below here
      // runs at all — getting a response is itself the assertion.
      const healthyRow = body.leagues.find((row) => row.leagueId === healthy.id);
      const brokenRow = body.leagues.find((row) => row.leagueId === broken.id);

      expect(healthyRow).toBeDefined();
      expect(brokenRow).toBeDefined();

      // The broken league's failure is recorded, not swallowed. A league whose
      // bracket can never be built must not read as healthy forever.
      expect(brokenRow?.bracketProblem).toBeTruthy();
      expect(brokenRow?.bracketProblem).toMatch(/not in the league/i);

      // And the healthy league is unharmed by its neighbour.
      expect(healthyRow?.bracketProblem).toBeUndefined();
    } finally {
      // In a `finally` because the interesting run is the one where the request
      // above throws. Leaving the poison behind would make every later test in
      // this file fail for *this* test's reason — which is the blast radius
      // being demonstrated, and exactly why it must not leak between tests.
      await db.query(`DELETE FROM matchups WHERE league_id = $1 AND away_team_id = $2`, [
        broken.id,
        healthy.teams[0],
      ]);
    }
  });

  it("lays a bracket for a league smaller than its own playoff field", async () => {
    // The reported symptom, end to end. Five friends in a twelve-seat league is
    // a five-team playoff field, and the frozen bye count of 2 left three teams
    // to pair — which threw, escaped this same block, and took every other
    // league's scoring down with it.
    //
    // Byes sized to the real field mean there is nothing to catch here at all,
    // which is the better fix: the guard stops a failure spreading, and the
    // sizing stops the failure.
    const small = await league("small", 5);
    const neighbour = await league("neighbour", 8);

    const response = await GET(new Request("http://localhost/api/cron/score-week?week=1"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      leagues: { leagueId: string; bracketGames?: number; bracketProblem?: string }[];
    };

    const smallRow = body.leagues.find((row) => row.leagueId === small.id);
    const neighbourRow = body.leagues.find((row) => row.leagueId === neighbour.id);

    expect(smallRow?.bracketProblem).toBeUndefined();
    // A five-team field is three byes and one game, so a round really was laid.
    expect(smallRow?.bracketGames).toBeGreaterThan(0);
    expect(neighbourRow?.bracketProblem).toBeUndefined();
  });
});
