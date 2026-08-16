import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { LeagueRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { seasonsInPlay } from "./sync.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

/**
 * Which seasons the scheduled jobs cover.
 *
 * This decides whether `/api/cron/stats` reads a box score at all, so getting it
 * wrong is not a degraded service — it is every player scoring zero, which is
 * the exact defect issue #75 was about. The case that matters most is the one
 * a calendar-derived season gets wrong: on 3 January 2027 the 2026 season's
 * championship is being played, and `new Date().getFullYear()` answers 2027.
 */

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const DRAFT = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
} as const;

let leagueCount = 0;

async function league(season: number, state?: string): Promise<string> {
  leagueCount += 1;
  const commissioner = await createUser(
    db!,
    `commish-${leagueCount}@example.test`,
    `Commish ${leagueCount}`,
  );
  const rules = buildNflPprRules({ seasonYear: season, draft: DRAFT }) as LeagueRules;
  const made = await createLeague(db!, NFL, {
    name: `League ${leagueCount}`,
    commissionerId: commissioner.id,
    rules,
  });

  // Written directly rather than through a transition, because `startDraft` and
  // the final pick are the only things that move state and both want a whole
  // drafted league behind them. The column is what the query reads.
  if (state) {
    await db!.query("UPDATE leagues SET state = $1 WHERE id = $2", [state, made.id]);
  }

  return made.id;
}

describe("seasonsInPlay", () => {
  it("is empty when no league exists, so no provider call is made", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);

    // The point is the spend, not the tidiness. A metered API polled every ten
    // minutes for a season nobody is playing is a bill with no reader, and this
    // is the state a fresh deployment sits in.
    expect(await seasonsInPlay(db, NFL.key)).toEqual([]);
  });

  it("includes a league that has not drafted yet", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026);

    // FORMING counts because `weekHasSchedule` is false without `games` rows and
    // `setLineup` then refuses every lineup with SCHEDULE_MISSING. The schedule
    // has to be ingested before anyone needs it, not once the season starts.
    expect(await seasonsInPlay(db, NFL.key)).toEqual([2026]);
  });

  it("covers every state up to settlement", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);

    await league(2026, "FORMING");
    await league(2027, "DRAFTING");
    await league(2028, "IN_SEASON");
    await league(2029, "PLAYOFFS");

    expect(await seasonsInPlay(db, NFL.key)).toEqual([2026, 2027, 2028, 2029]);
  });

  it("drops a season once every league in it has settled or dissolved", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);

    await league(2025, "SETTLED");
    await league(2024, "DISSOLVED");

    // A finalised week is never rescored, so polling a settled league's games
    // is spend with no effect.
    expect(await seasonsInPlay(db, NFL.key)).toEqual([]);
  });

  it("keeps a season alive while any one league in it is still playing", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);

    await league(2026, "SETTLED");
    await league(2026, "IN_SEASON");

    // Per season, not per league. One league settling early — a small league
    // whose championship week is done — must not stop the stats its neighbours
    // are still being scored on.
    expect(await seasonsInPlay(db, NFL.key)).toEqual([2026]);
  });

  it("returns each season once, in order, however many leagues play it", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);

    await league(2027, "IN_SEASON");
    await league(2026, "IN_SEASON");
    await league(2027, "FORMING");
    await league(2026, "PLAYOFFS");

    // Ordered and distinct: the caller loops these making provider calls, so a
    // duplicate is a doubled bill and an unstable order makes one run's work
    // list differ from the next's for no reason.
    expect(await seasonsInPlay(db, NFL.key)).toEqual([2026, 2027]);
  });

  it("answers for the season being played, not the calendar year", async () => {
    db = await createTestDatabase();
    await seedSport(db, NFL);
    await league(2026, "PLAYOFFS");

    // 3 January 2027: the 2026 championship is being played and its 168-hour
    // correction window has a week to run. `new Date().getFullYear()` would say
    // 2027 — a season with no games — so the stats job would ingest nothing and
    // the week that pays out would finalise on whatever was last written.
    expect(await seasonsInPlay(db, NFL.key)).toEqual([2026]);
  });
});
