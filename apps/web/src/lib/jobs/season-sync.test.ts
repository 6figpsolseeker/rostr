import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { LeagueRules } from "@rostr/core";
import { createLeague, createUser, listCronRuns, seedSport } from "@rostr/db";
import { createTestDatabase } from "@rostr/db/testing";
import type { PGliteClient } from "@rostr/db/testing";
import { runSeasonSyncJob } from "./season-sync.js";

/**
 * What the season sync writes to its heartbeat, and — more to the point — what
 * it must not.
 *
 * `cron_runs.last_outcome` is a **state**, not a message. `cronJobState` returns
 * `FAILING` for any non-null value, ahead of the staleness check, so anything
 * written there is an alarm whatever the words say.
 *
 * This job used to put its undated-fixture count in that field under a comment
 * asserting those fixtures "are not a failure and must not read as one" — right
 * about the rule, wrong about the code. The NFL withholds the kickoff times of
 * four week-16 and four week-17 games for flex scheduling every year, and #182
 * exists to *keep* those fixtures rather than discard them. So the job reported
 * `FAILING` daily, permanently, for a condition that is correct.
 *
 * A row that cries wolf every day is a row nobody reads, and this is the same
 * table that has to be believed when scoring breaks in October.
 */

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const NOW = new Date("2026-08-19T09:20:00Z");
const SEASON = 2026;

/** Any legal draft; nothing here reads it. Matches the sibling stats job test. */
const DRAFT = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
} as const;

/** One fixture per week, with the given weeks left without a kickoff time. */
function fakeProvider(undatedWeeks: readonly number[]) {
  const calls = { games: 0 };
  return {
    calls,
    provider: {
      listPlayers: async () => [],
      // A Map, not an array — the interface says so, and an array here fails
      // silently as "no byes" rather than loudly.
      listByeWeeks: async () => new Map<string, number>(),
      listAdp: async () => ({ asOf: "2026-08-19", rankingType: "PPR", entries: [] }),
      listSeasonProjections: async () => [],
      listWeekProjections: async () => [],
      listGames: async (season: number, week: number) => {
        calls.games++;
        const tbd = undatedWeeks.includes(week);
        return [
          {
            externalRef: `${season}w${week}_KC@BUF`,
            season,
            week,
            homeTeamRef: "BUF",
            awayTeamRef: "KC",
            // Null on an undated fixture, so `syncGames` finds no same-date
            // sibling to borrow a kickoff from and counts it skipped — which is
            // the state this file is about.
            gameDate: tbd ? null : "2026-09-13",
            // `syncGames` counts a fixture as skipped when no kickoff can be
            // derived at all. Zero with no dated sibling in the week is exactly
            // the flex-scheduling case.
            kickoffAt: tbd ? 0 : Math.floor(Date.UTC(2026, 8, 13, 17, 0, 0) / 1000),
            kickoffTbd: tbd,
            status: "SCHEDULED" as const,
            finalAt: null,
          },
        ];
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

async function seedLeague(): Promise<PGliteClient> {
  db = await createTestDatabase();
  await seedSport(db, NFL);
  const commissioner = await createUser(db, "commish@example.com", "Commish");
  await createLeague(db, NFL, {
    name: "Sync League",
    commissionerId: commissioner.id,
    rules: buildNflPprRules({ seasonYear: SEASON, draft: DRAFT }) as LeagueRules,
  });
  return db;
}

describe("the season sync heartbeat", () => {
  it("records a clean run when every fixture is dated", async () => {
    const client = await seedLeague();
    const { provider } = fakeProvider([]);

    await runSeasonSyncJob(client, provider, NOW);

    const [run] = await listCronRuns(client);
    expect(run?.name).toBe("season-sync");
    expect(run?.lastOutcome).toBeNull();
  });

  it("stays clean when the NFL has not scheduled the late weeks yet", async () => {
    // **The regression this file exists for.** Weeks 16 and 17 undated is the
    // ordinary state of the schedule from August until December, and it must
    // not put the job into FAILING — a permanent correct condition raising a
    // daily alarm is how an operator learns to ignore the whole table.
    const client = await seedLeague();
    const { provider } = fakeProvider([16, 17]);

    await runSeasonSyncJob(client, provider, NOW);

    const [run] = await listCronRuns(client);
    expect(run?.lastOutcome).toBeNull();
  });

  it("still reports the undated count, where it informs rather than alarms", async () => {
    // Dropping the number entirely would be the other failure: those fixtures
    // land on the championship weeks, and a count that grows — or one in an
    // early week — is a broken ingest somebody needs to see.
    const client = await seedLeague();
    const { provider } = fakeProvider([16, 17]);

    const response = await runSeasonSyncJob(client, provider, NOW);
    const body = (await response.json()) as { undatedGames: number };

    expect(body.undatedGames).toBe(2);
  });

  it("reports a season that genuinely failed", async () => {
    // The field is not merely emptied — a real failure must still reach it, or
    // the fix would trade a false alarm for a silent one.
    const client = await seedLeague();
    const { provider } = fakeProvider([]);
    provider.listGames = async () => {
      throw new Error("provider exploded");
    };

    await runSeasonSyncJob(client, provider, NOW);

    const [run] = await listCronRuns(client);
    expect(run?.lastOutcome).toMatch(/1 of 1 seasons failed/);
  });

  it("reads every week of the season, not only the weeks ahead", async () => {
    // A flexed Sunday-night game moves inside an already-ingested week, so a
    // sync that only looked forward would never see it move.
    const client = await seedLeague();
    const { provider, calls } = fakeProvider([]);

    await runSeasonSyncJob(client, provider, NOW);

    expect(calls.games).toBe(NFL.seasonWeeks);
  });
});
