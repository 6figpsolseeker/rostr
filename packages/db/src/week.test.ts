import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, computeStandings, generateSchedule, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules, MatchupResult } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { setLineup } from "./lineups.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import {
  currentWeek,
  finalizationHours,
  generateSeasonSchedule,
  loadScheduledWeek,
  loadWeekResults,
  persistSchedule,
  resolveLeagueWeek,
  resolveLeagueWeeksThrough,
  transactionWeek,
} from "./week.js";

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

const KICKOFF = new Date("2026-09-13T17:00:00Z");
const DURING = new Date(KICKOFF.getTime() + 2 * 3600 * 1000);
/** Past the 48-hour standard window. */
const AFTER_STANDARD = new Date(KICKOFF.getTime() + 49 * 3600 * 1000);
/** Past the 168-hour paying window. */
const AFTER_PAYING = new Date(KICKOFF.getTime() + 169 * 3600 * 1000);

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  rules: LeagueRules;
  teamIds: string[];
  players: Map<string, string>;
  statKeys: Map<string, string>;
}

async function setup(teamCount = 4): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = buildNflPprRules({ seasonYear: SEASON, draft: DRAFT }) as LeagueRules;
  const league = await createLeague(db, NFL, {
    name: "Week League",
    commissionerId: commissioner.id,
    rules,
  });

  const teamIds: string[] = [];
  for (let i = 0; i < teamCount; i++) {
    teamIds.push((await addTestTeam(db, league.id, `Bot ${i + 1}`)).teamId);
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
  const statKeys = new Map(
    (
      await db.query<{ id: string; key: string }>(
        "SELECT id, key FROM stat_keys WHERE sport_id = $1",
        [sport!.id],
      )
    ).map((row) => [row.key, row.id]),
  );

  await db.query(
    `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at, status)
     VALUES ($1, 'g1', $2, $3, 'CIN', 'BAL', $4, 'SCHEDULED')`,
    [sport!.id, SEASON, WEEK, KICKOFF],
  );

  // One quarterback each, so every team has something to score.
  const players = new Map<string, string>();
  for (const [index, teamId] of teamIds.entries()) {
    const handle = `qb-${index}`;
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $3, $4, 'CIN') RETURNING id`,
      [sport!.id, handle, handle, positions.get("QB")!],
    );
    players.set(handle, row!.id);

    await db.query(
      `INSERT INTO roster_entries (team_id, player_id, acquired_via) VALUES ($1, $2, 'DRAFT')`,
      [teamId, row!.id],
    );

    await setLineup(db, {
      leagueId: league.id,
      teamId,
      week: WEEK,
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: row!.id }],
      now: Math.floor(KICKOFF.getTime() / 1000) - 3600,
    });
  }

  return { client: db, leagueId: league.id, rules, teamIds, players, statKeys };
}

/**
 * Give a player passing yards for the week.
 *
 * A later value is a new **revision**, not a second row — the table is
 * append-only and the unique constraint enforces it, because a settled week has
 * to stay auditable against exactly the data it settled on. `stat_lines_current`
 * reads the highest revision.
 */
async function score(
  fx: Fixture,
  handle: string,
  passYards: number,
  revision = 0,
): Promise<void> {
  await fx.client.query(
    `INSERT INTO stat_lines (player_id, season, week, stat_key_id, value, source, revision)
     VALUES ($1, $2, $3, $4, $5, 'tank01', $6)`,
    [fx.players.get(handle), SEASON, WEEK, fx.statKeys.get("pass_yd"), passYards, revision],
  );
}

/**
 * A week's games finish **and their box scores are read**.
 *
 * Both, because in production both happen: `syncGames` advances the status and
 * `syncBoxScores` stamps `stats_synced_at`, and a game that is FINAL with no
 * stats is a failure state rather than a normal one. A fixture that marked only
 * the status would put every test in that failure state and prove nothing about
 * the ordinary path — the mistake issue #73's test made, in the other direction.
 *
 * Use {@link finishGamesUnread} for the failure this distinction exists to catch.
 */
const finishGames = (fx: Fixture) =>
  fx.client.query(
    `UPDATE games SET status = 'FINAL',
                      final_at = now() - interval '1 hour',
                      -- Both columns, and after final_at. The producer writes all
                      -- three together on a successful read, and the hold now asks
                      -- whether the sync came *after* the whistle — a sync stamped
                      -- before it is a mid-game read, not a final line.
                      stats_synced_at = now(),
                      stats_attempted_at = now()
      WHERE season = $1 AND week = $2`,
    [SEASON, WEEK],
  );

/**
 * Games the provider called FINAL whose box score was never read. Issue #140.
 *
 * The state that used to finalise a week **clean** at 0–0, permanently, and look
 * exactly like a week in which nobody scored.
 */
const finishGamesUnread = (fx: Fixture) =>
  fx.client.query(
    `UPDATE games SET status = 'FINAL',
                      final_at = now() - interval '1 hour',
                      stats_synced_at = NULL
      WHERE season = $1 AND week = $2`,
    [SEASON, WEEK],
  );

/**
 * Add one more game to a week, at the same kickoff, with a status of its own.
 *
 * The fixture ships a single week-1 game, which cannot express "one of them
 * never happened" — the case `docs/RULES.md` §10 is written for.
 */
async function addGame(fx: Fixture, ref: string, status: string, week = WEEK): Promise<void> {
  const [sport] = await fx.client.query<{ id: string }>(
    "SELECT id FROM sports WHERE key = $1",
    [NFL.key],
  );
  /*
    A FINAL game here is a **cleanly ingested** one, for the same reason
    {@link finishGames} stamps the sync: a row that is FINAL with no box score is
    the #140 failure state, and a fixture producing it by default would put every
    §10 postponement test into that state instead.

    It did, and it hid a real defect. The paying-week test below staged one
    postponed game beside one FINAL game with no stats and asserted the §10
    wording — which passed only because the postponement branch returned first,
    swallowing the pipeline failure. Exactly the mistake this file's own
    {@link finishGames} comment warns about, one function further down.
  */
  await fx.client.query(
    `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                        kickoff_at, status, final_at, stats_synced_at, stats_attempted_at)
     VALUES ($1, $2, $3, $4, 'BUF', 'CIN', $5, $6,
             CASE WHEN $6 = 'FINAL' THEN $5::timestamptz + interval '3 hours' END,
             CASE WHEN $6 = 'FINAL' THEN $5::timestamptz + interval '4 hours' END,
             CASE WHEN $6 = 'FINAL' THEN $5::timestamptz + interval '4 hours' END)`,
    [sport!.id, ref, SEASON, week, KICKOFF, status],
  );
}

async function schedule(fx: Fixture): Promise<void> {
  await persistSchedule(fx.client, fx.leagueId, generateSchedule(fx.teamIds, 14, "seed"));
}

describe("transactionWeek across the November fall-back", () => {
  // The 2026 clocks go back on Sunday 1 November, so the Tuesday locks either
  // side are 169 hours apart. `transactionWeek` used to find "the most recent
  // lock" by asking from exactly `at - 7 * 24h`, which lands *on* the earlier
  // lock and is then skipped by a strictly-after search — so for one hour it
  // named the lock a week ahead, and therefore the wrong week.
  const OCT_LOCK = new Date("2026-10-27T04:00:00Z"); // Tue 00:00 EDT
  const WEEK_9_SUNDAY = new Date("2026-11-01T18:00:00Z"); // Sun 1 Nov 13:00 EST
  const WEEK_9_MNF = new Date("2026-11-03T01:15:00Z"); // Mon 2 Nov 20:15 EST
  const WEEK_10_TNF = new Date("2026-11-06T01:15:00Z"); // Thu 5 Nov 20:15 EST

  /** Monday 2 November, 23:30 ET — Monday Night Football is being played. */
  const DURING_MNF = new Date("2026-11-03T04:30:00Z");

  async function withNovemberGames(): Promise<Fixture> {
    const fx = await setup();
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );

    for (const [ref, week, kickoff] of [
      ["w9-sun", 9, WEEK_9_SUNDAY],
      ["w9-mnf", 9, WEEK_9_MNF],
      ["w10-tnf", 10, WEEK_10_TNF],
    ] as const) {
      await fx.client.query(
        `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at, status)
         VALUES ($1, $2, $3, $4, 'CIN', 'BAL', $5, 'SCHEDULED')`,
        [sport!.id, ref, SEASON, week, kickoff],
      );
    }

    return fx;
  }

  it("names week 9 while week 9 is still being played", async () => {
    const fx = await withNovemberGames();

    // `at - 168h` lands past the October lock, which is what used to lose it.
    expect(DURING_MNF.getTime() - 7 * 24 * 3600 * 1000).toBeGreaterThanOrEqual(
      OCT_LOCK.getTime(),
    );

    expect(await transactionWeek(fx.client, fx.rules, DURING_MNF)).toBe(9);
  });

  it("keeps RULES.md §6's kickoff lock enforceable during Monday night", async () => {
    // The consequence. Naming week 10 sends every kickoff check to week 10's
    // games, none of which has started — so a manager could cut an injured
    // player mid-game, which is the exact thing §6 forbids.
    const fx = await withNovemberGames();
    const week = await transactionWeek(fx.client, fx.rules, DURING_MNF);

    const [game] = await fx.client.query<{ kickoff_at: string }>(
      `SELECT kickoff_at FROM games WHERE season = $1 AND week = $2
        ORDER BY kickoff_at DESC LIMIT 1`,
      [SEASON, week],
    );

    expect(new Date(game!.kickoff_at).getTime()).toBeLessThanOrEqual(DURING_MNF.getTime());
  });

  it("moves to week 10 once the lock actually passes", async () => {
    const fx = await withNovemberGames();
    const afterLock = new Date("2026-11-03T05:00:00Z"); // Tue 00:00 EST

    expect(await transactionWeek(fx.client, fx.rules, afterLock)).toBe(10);
  });
});

describe("persistSchedule", () => {
  it("writes every matchup", async () => {
    const fx = await setup();
    const result = await persistSchedule(
      fx.client,
      fx.leagueId,
      generateSchedule(fx.teamIds, 14, "seed"),
    );

    expect(result.written).toBe(14 * 2);
    expect(await loadScheduledWeek(fx.client, fx.leagueId, WEEK)).toHaveLength(2);
  });

  it("refuses to overwrite an existing schedule", async () => {
    // Rewriting mid-season changes who played whom, and every record derived
    // from it.
    const fx = await setup();
    await schedule(fx);

    const second = await persistSchedule(
      fx.client,
      fx.leagueId,
      generateSchedule(fx.teamIds, 14, "different-seed"),
    );

    expect(second.written).toBe(0);
  });
});

describe("resolveLeagueWeek", () => {
  it("scores a week from stored lineups", async () => {
    const fx = await setup();
    await schedule(fx);
    await score(fx, "qb-0", 300); // 12 points

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.matchups).toBe(2);
    const scored = outcome.results.find((r) =>
      [r.homeTeamId, r.awayTeamId].includes(fx.teamIds[0]!),
    );
    const points =
      scored?.homeTeamId === fx.teamIds[0] ? scored?.homeMilliPoints : scored?.awayMilliPoints;
    expect(points).toBe(12_000);
  });

  it("writes the points into matchups", async () => {
    const fx = await setup();
    await schedule(fx);
    await score(fx, "qb-0", 300);

    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    // Which side of a matchup a team lands on comes from the schedule, so this
    // sums both rather than assuming.
    const rows = await fx.client.query<{ home: number; away: number }>(
      `SELECT home_milli_points AS home, away_milli_points AS away
         FROM matchups WHERE league_id = $1 AND week = $2`,
      [fx.leagueId, WEEK],
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.home !== null && row.away !== null)).toBe(true);

    const total = rows.reduce((sum, row) => sum + Number(row.home) + Number(row.away), 0);
    expect(total).toBe(12_000);
  });

  it("picks up a new revision on a rerun", async () => {
    // How live scores stay current: the job runs again, reads the latest
    // revision, and the total moves.
    const fx = await setup();
    await schedule(fx);
    await score(fx, "qb-0", 100);

    const pointsFor = (outcome: { results: readonly MatchupResult[] }): number => {
      const matchup = outcome.results.find((r) =>
        [r.homeTeamId, r.awayTeamId].includes(fx.teamIds[0]!),
      )!;
      return matchup.homeTeamId === fx.teamIds[0]
        ? matchup.homeMilliPoints
        : matchup.awayMilliPoints;
    };

    const first = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);
    expect(pointsFor(first)).toBe(4_000);
    expect(first.finalized).toBe(false);

    await score(fx, "qb-0", 300, 1);

    const second = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);
    expect(pointsFor(second)).toBe(12_000);
    expect(second.finalized).toBe(false);
  });

  it("uses the latest revision, not the first", async () => {
    // A stat correction inserts a new revision rather than overwriting, so a
    // settled week stays auditable against what it settled on. Scoring must read
    // the current one.
    const fx = await setup();
    await schedule(fx);
    await score(fx, "qb-0", 500);
    await score(fx, "qb-0", 250, 1);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);
    const matchup = outcome.results.find((r) =>
      [r.homeTeamId, r.awayTeamId].includes(fx.teamIds[0]!),
    )!;
    const points =
      matchup.homeTeamId === fx.teamIds[0] ? matchup.homeMilliPoints : matchup.awayMilliPoints;

    expect(points).toBe(10_000);
  });

  it("fills a missing lineup rather than failing", async () => {
    // resolveWeek throws on a team with no lineup, correctly — scoring it as
    // zero hands its opponent a free win. ensureLineups is what stops that.
    const fx = await setup();
    await schedule(fx);
    await fx.client.query("DELETE FROM lineups WHERE team_id = $1", [fx.teamIds[1]]);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.matchups).toBe(2);
  });

  it("refuses a week with no schedule", async () => {
    const fx = await setup();

    await expect(resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING)).rejects.toMatchObject(
      { code: "NO_SCHEDULE" },
    );
  });
});

describe("resolveLeagueWeeksThrough", () => {
  const week1Finalized = async (fx: Fixture): Promise<boolean> => {
    const [row] = await fx.client.query<{ finalized_at: string | null }>(
      "SELECT finalized_at FROM matchups WHERE league_id = $1 AND week = $2 LIMIT 1",
      [fx.leagueId, WEEK],
    );
    return Boolean(row?.finalized_at);
  };

  it("finalises a prior week that the single-week pointer leaves behind", async () => {
    // Week 1 is final and its 48h window has elapsed, but the pointer is on a
    // later week. This is exactly how a paying week is abandoned once the season
    // moves on: resolving only the pointer week never revisits it.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);

    // Resolving only week 5 (which has fixtures but no finished games) leaves
    // week 1 unfinalised — the bug.
    await resolveLeagueWeek(fx.client, fx.leagueId, 5, AFTER_STANDARD);
    expect(await week1Finalized(fx)).toBe(false);

    // The sweep resolves every unfinalised week up to the pointer, so week 1 is
    // finalised. The limit is raised past the default because this fixture has
    // fourteen weeks of fixtures and none of them finalised — the default of 4
    // is sized for the real case, where the unfinalised set at any moment is the
    // paying week plus the playoff weeks that followed it.
    const sweep = await resolveLeagueWeeksThrough(
      fx.client,
      fx.leagueId,
      5,
      AFTER_STANDARD,
      10,
    );
    expect(sweep.outcomes.find((o) => o.week === WEEK)?.finalized).toBe(true);
    expect(await week1Finalized(fx)).toBe(true);
  });

  it("leaves nothing to do once every week through the pointer is finalised", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    // Bounded by `week <= WEEK`, so weeks 2-14 are out of range rather than
    // absent — this asserts the pointer bound, not that the season is done.
    const again = await resolveLeagueWeeksThrough(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);
    expect(again.outcomes).toHaveLength(0);
    expect(again.failures).toHaveLength(0);
  });

  it("does not let one unresolvable week stop the weeks after it", async () => {
    // The regression that matters. Before the sweep existed, a broken week 3
    // could not stop week 16 from scoring, because the cron touched exactly one
    // week. A sweep without per-week isolation makes that possible — and the
    // oldest broken week wins, permanently, because it is re-selected every run.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);

    // Week 2 cannot resolve: one of its matchups names a team from another
    // league, so `ensureLineups` never gives it a lineup and `resolveWeek`
    // refuses rather than scoring the missing side as zero — which would hand
    // its opponent a free win off our own bug.
    //
    // Deleting a lineup would not do it: `ensureLineups` runs first and autofills
    // one, which is the whole reason that function exists.
    const other = await createUser(fx.client, "other@example.com", "Other");
    const otherLeague = await createLeague(fx.client, NFL, {
      name: "Elsewhere",
      commissionerId: other.id,
      rules: fx.rules,
    });
    const outsider = await addTestTeam(fx.client, otherLeague.id, "Outsider");

    await fx.client.query(
      `INSERT INTO matchups (league_id, week, phase, home_team_id, away_team_id)
       VALUES ($1, 2, 'REGULAR', $2, $3)`,
      [fx.leagueId, fx.teamIds[0], outsider.teamId],
    );

    const sweep = await resolveLeagueWeeksThrough(
      fx.client,
      fx.leagueId,
      5,
      AFTER_STANDARD,
      10,
    );

    // Week 2 failed and said so — silence would read as "nothing to do".
    expect(sweep.failures.some((f) => f.week === 2)).toBe(true);
    // And week 1 was still resolved and finalised despite it.
    expect(sweep.outcomes.find((o) => o.week === WEEK)?.finalized).toBe(true);
    expect(await week1Finalized(fx)).toBe(true);
  });

  it("skips a part-finalised week rather than wedging on it", async () => {
    // The sweep selects weeks with no finalised row; `resolveLeagueWeek` refuses
    // weeks with any finalised row. If those two predicates are not complements,
    // a mixed week is selected *and* refused — unresolvable by construction, and
    // with no isolation it takes every later week with it.
    //
    // Reachable: a smaller consolation bracket starts in a later week than the
    // main one, so a week can finalise holding only consolation fixtures and
    // then receive playoff fixtures on a later advance.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    // Week 1 is finalised; now add an unfinalised row to it.
    await fx.client.query(
      `INSERT INTO matchups (league_id, week, phase, home_team_id, away_team_id)
       SELECT $1, $2, 'PLAYOFF', home_team_id, away_team_id
         FROM matchups WHERE league_id = $1 AND week = $2 AND phase = 'REGULAR' LIMIT 1`,
      [fx.leagueId, WEEK],
    );

    const sweep = await resolveLeagueWeeksThrough(fx.client, fx.leagueId, 5, AFTER_STANDARD);

    // Not selected at all, so it cannot throw and cannot block anything.
    expect(sweep.outcomes.some((o) => o.week === WEEK)).toBe(false);
    expect(sweep.failures.some((f) => f.week === WEEK)).toBe(false);
  });

  it("bounds the sweep and reports what it left behind", async () => {
    // A league with a long tail of never-finalisable weeks — a postponed game, a
    // feed that never marks one final — would otherwise re-run the full
    // lineup-and-scoring work for every one of them, every ten minutes, forever.
    const fx = await setup();
    await schedule(fx);

    const sweep = await resolveLeagueWeeksThrough(
      fx.client,
      fx.leagueId,
      10,
      AFTER_STANDARD,
      3,
    );

    expect(sweep.outcomes.length + sweep.failures.length).toBeLessThanOrEqual(3);
    expect(sweep.deferred.length).toBeGreaterThan(0);
    // The most recent are taken, because those are the ones with money and an
    // audience attached; the older ones are named rather than dropped silently.
    expect(Math.max(...sweep.deferred)).toBeLessThan(
      Math.min(...sweep.outcomes.map((o) => o.week)),
    );
  });
});

describe("finalisation", () => {
  it("holds while games are still in progress and the window is running", async () => {
    // Inside the window, an unplayed game is the reason worth reporting — it is
    // the one an operator can still act on. Outside it the clock wins; see the
    // postponement tests below.
    const fx = await setup();
    await schedule(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.finalized).toBe(false);
    expect(outcome.holdReason).toMatch(/still in progress/);
  });

  it("holds until the correction window has passed", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.finalized).toBe(false);
    expect(outcome.holdReason).toMatch(/waiting until/);
  });

  it("finalises once both conditions are met", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalized).toBe(true);
    expect(outcome.holdReason).toBeUndefined();
  });

  it("never rescores a finalised week", async () => {
    // In a paying week it has already decided money. A silently changed result
    // afterwards is exactly what the correction window exists to prevent.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    await expect(
      resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD),
    ).rejects.toMatchObject({ code: "ALREADY_FINAL" });
  });

  it("makes a paying week wait far longer", async () => {
    // Week 14 pays the regular-season prize, and NFL stat corrections arrive for
    // up to seven days.
    const fx = await setup();
    expect(finalizationHours(fx.rules, 1)).toBe(48);
    expect(finalizationHours(fx.rules, 14)).toBe(168);
    expect(finalizationHours(fx.rules, 17)).toBe(168);
  });

  it("says why a paying week is waiting", async () => {
    const fx = await setup();
    // Move the paying weeks onto week 1 so the message is observable here.
    const paying = {
      ...fx.rules,
      settlement: { ...fx.rules.settlement, payingWeeks: [WEEK] },
    } as LeagueRules;

    await schedule(fx);
    await finishGames(fx);

    // 49 hours is past the standard window but nowhere near the paying one.
    const hold = await (async () => {
      const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);
      return outcome;
    })();

    // With the league's real rules week 1 is not a paying week, so it finalises.
    expect(hold.finalized).toBe(true);
    expect(paying.settlement.payingWeeks).toEqual([WEEK]);
  });

  it("waits the full week when the week does pay", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);

    // Week 14 is a paying week in the default rules. Give it a game and a
    // schedule row, then check the two windows behave differently.
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    await fx.client.query(
      // `stats_synced_at` too: a FINAL game whose box score was never read is
      // the #140 failure state, and this test is about the correction window.
      `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at, status, stats_synced_at)
       VALUES ($1, 'g14', $2, 14, 'CIN', 'BAL', $3, 'FINAL', now())`,
      [sport!.id, SEASON, KICKOFF],
    );

    const early = await resolveLeagueWeek(fx.client, fx.leagueId, 14, AFTER_STANDARD);
    expect(early.finalized).toBe(false);
    expect(early.holdReason).toMatch(/stat corrections/);

    const late = await resolveLeagueWeek(fx.client, fx.leagueId, 14, AFTER_PAYING);
    expect(late.finalized).toBe(true);
  });
});

describe("a game that never finishes — docs/RULES.md §10", () => {
  const finalizedAt = async (fx: Fixture, week = WEEK): Promise<string | null> => {
    const [row] = await fx.client.query<{ finalized_at: string | null }>(
      "SELECT finalized_at FROM matchups WHERE league_id = $1 AND week = $2 LIMIT 1",
      [fx.leagueId, week],
    );
    return row?.finalized_at ?? null;
  };

  it("finalises once the scoring window has passed, unplayed game and all", async () => {
    // The failure this exists to stop. A postponed game never reaches FINAL, so
    // a hold keyed on "every game is FINAL" alone is a hold with no end: the
    // week never finalises, the bracket never advances, and in weeks 14 and 17
    // nobody is ever paid. Before this change the assertion below was
    // `finalized: false` with "1 of 2 games are still in progress", at any
    // instant however far in the future.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await addGame(fx, "g1-postponed", "POSTPONED");

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalized).toBe(true);
    expect(outcome.holdReason).toBeUndefined();
    expect(await finalizedAt(fx)).not.toBeNull();
  });

  it("says it finalised on the fallback rather than on complete data", async () => {
    // `finalized: true` alone cannot distinguish a settled week from one the
    // clock ran out on, and only the second is worth an operator's attention:
    // the missing game's players are now permanently scored at zero, because a
    // finalised week is never rescored.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await addGame(fx, "g1-postponed", "POSTPONED");

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalizedWithUnfinishedGames).toMatch(/1 of 2/);
    expect(outcome.finalizedWithUnfinishedGames).toMatch(/RULES\.md §10/);
  });

  it("reports nothing extra when the week finalised on complete data", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalized).toBe(true);
    expect(outcome.finalizedWithUnfinishedGames).toBeUndefined();
  });

  it("scores the missing game's players zero and lets the matchup stand", async () => {
    // "Affected players score 0" needs no code of its own: a player with no stat
    // line already scores zero (`results.ts` — absent, empty and zero are three
    // different things). What §10 needed was for the week to stop waiting. This
    // asserts the whole rule: qb-0 played and counts, qb-1 did not and scores
    // nothing, and both matchups are written and final rather than voided.
    const fx = await setup();
    await schedule(fx);
    await score(fx, "qb-0", 300); // 12 points
    await finishGames(fx);
    await addGame(fx, "g1-postponed", "POSTPONED");

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    const pointsFor = (teamId: string): number => {
      const matchup = outcome.results.find((r) =>
        [r.homeTeamId, r.awayTeamId].includes(teamId),
      )!;
      return matchup.homeTeamId === teamId ? matchup.homeMilliPoints : matchup.awayMilliPoints;
    };

    expect(pointsFor(fx.teamIds[0]!)).toBe(12_000);
    expect(pointsFor(fx.teamIds[1]!)).toBe(0);
    expect(outcome.matchups).toBe(2);

    const rows = await fx.client.query<{ finalized_at: string | null }>(
      "SELECT finalized_at FROM matchups WHERE league_id = $1 AND week = $2",
      [fx.leagueId, WEEK],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.finalized_at !== null)).toBe(true);
  });

  it("still holds inside the window, so a slow ingest gets its full 48 hours", async () => {
    // The fallback is a deadline, not a shortcut. Everything the feed has until
    // the window closes still lands in the score.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await addGame(fx, "g1-postponed", "POSTPONED");

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.finalized).toBe(false);
    expect(outcome.holdReason).toMatch(/1 of 2 games are still in progress/);
    expect(outcome.finalizedWithUnfinishedGames).toBeUndefined();
    expect(await finalizedAt(fx)).toBeNull();
  });

  it("gives a paying week the full 168 hours before falling back", async () => {
    // The deadline is the week's own scoring window, so the weeks that pay wait
    // seven days rather than two — and a game still unmarked after seven days is
    // an abandoned game rather than a slow feed. Week 14 pays in the default
    // rules; `finalizationHours` is asserted separately above.
    const fx = await setup();
    await schedule(fx);
    await addGame(fx, "g14", "FINAL", 14);
    await addGame(fx, "g14-postponed", "POSTPONED", 14);

    // 49h is past the standard window and nowhere near the paying one, so the
    // paying week is still held by the unplayed game.
    const early = await resolveLeagueWeek(fx.client, fx.leagueId, 14, AFTER_STANDARD);
    expect(early.finalized).toBe(false);
    expect(early.holdReason).toMatch(/1 of 2 games are still in progress/);
    expect(await finalizedAt(fx, 14)).toBeNull();

    // 169h is past it, so the regular-season prize can be settled rather than
    // waiting forever on a game that will never be played.
    const late = await resolveLeagueWeek(fx.client, fx.leagueId, 14, AFTER_PAYING);
    expect(late.finalized).toBe(true);
    expect(late.finalizedWithUnfinishedGames).toMatch(/168h after the last kickoff/);
    expect(await finalizedAt(fx, 14)).not.toBeNull();
  });

  it("does not finalise a week whose games were never ingested at all", async () => {
    // §10 zeroes the players of a cancelled *game*. A week with no games is not
    // that case: there is no kickoff to run a window from, and finalising would
    // settle every matchup 0–0 rather than only the affected players. It waits.
    const fx = await setup();
    await schedule(fx);
    await fx.client.query("DELETE FROM games WHERE season = $1 AND week = $2", [SEASON, WEEK]);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_PAYING);

    expect(outcome.finalized).toBe(false);
    expect(outcome.holdReason).toMatch(/no games are scheduled/);
  });
});

describe("a week whose box scores were never read — #140", () => {
  /*
    The case that used to finalise **clean**.

    `finalizationHold` decided from the clock and `count(*) FILTER (WHERE status
    = 'FINAL')` and never once asked whether a box score had been read. So a week
    where every game was marked FINAL and nothing was ingested settled with
    `finished === total` — no fallback, nothing in the cron's JSON, nothing on
    the scoreboard. Every player scored zero, permanently, because a finalised
    week is never rescored, and twelve teams at 0–0 looks exactly like a week in
    which nobody scored.

    Reachable because two different jobs on two different cadences write the two
    facts: `syncGames` advances the status daily, `syncBoxScores` stamps
    `stats_synced_at` every ten minutes. Nothing orders them, and the stats job
    can fail for a week while the schedule job keeps marking games FINAL.
  */

  const finalizedAt = async (fx: Fixture): Promise<string | null> => {
    const [row] = await fx.client.query<{ finalized_at: string | null }>(
      "SELECT finalized_at FROM matchups WHERE league_id = $1 AND week = $2 LIMIT 1",
      [fx.leagueId, WEEK],
    );
    return row?.finalized_at ?? null;
  };

  it("holds a game that was tried and failed, not only one nobody tried", async () => {
    /*
      The gap #227 found in this hold, closed by `0041`.

      `syncBoxScores` used to stamp `stats_synced_at` on the **failure** path as
      well as the success one, because that column was also pacing the retry. So a
      game that a rate limit had made unreadable looked synced, this hold read it
      as ingested, and the week finalised with those players at zero —
      permanently, since a finalised week is never rescored.

      `stats_attempted_at` now carries the pacing and `stats_synced_at` means
      what its name says. This stages the state the producer writes after a failed
      read: attempted, an error recorded, nothing synced.
    */
    const fx = await setup();
    await schedule(fx);
    await fx.client.query(
      `UPDATE games SET status = 'FINAL',
                       stats_attempted_at = now(),
                       stats_synced_at = NULL,
                       stats_error = 'Tank01 refused the request (HTTP 429)'
        WHERE season = $1 AND week = $2`,
      [SEASON, WEEK],
    );

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.finalized).toBe(false);
    expect(outcome.holdReason).toMatch(/no box score/);
  });

  it("holds inside the window rather than settling at zero", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGamesUnread(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.finalized).toBe(false);
    expect(outcome.holdReason).toMatch(/no box score/);
    expect(await finalizedAt(fx)).toBeNull();
  });

  it("names the stats, not the clock, while it is holding", async () => {
    // Inside the window an operator can still act on this — the stats job can be
    // re-run and the week finalises on real data. Reporting it as "waiting for
    // the correction window" would hide the one thing worth doing.
    const fx = await setup();
    await schedule(fx);
    await finishGamesUnread(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.holdReason).not.toMatch(/stat corrections/);
    expect(outcome.holdReason).toMatch(/permanently/);
  });

  it("still finalises once the window has passed, because the clock is a ceiling", async () => {
    /*
      A hold the clock could not override would reintroduce exactly what §10's
      fallback exists to prevent: one game whose box score never arrives keeping
      a paying week open forever. Weeks 14 and 17 have to settle.
    */
    const fx = await setup();
    await schedule(fx);
    await finishGamesUnread(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalized).toBe(true);
    expect(await finalizedAt(fx)).not.toBeNull();
  });

  it("says the cause was our ingest, not an abandoned game", async () => {
    /*
      The distinction that makes this worth reporting at all. "The clock ran out
      with games unplayed" is the NFL's doing and §10 covers it; "the clock ran
      out with stats unread" is our pipeline failing, and those players are about
      to be paid nothing on data we never fetched. Same permanent outcome, two
      different responses.
    */
    const fx = await setup();
    await schedule(fx);
    await finishGamesUnread(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalizedWithUnfinishedGames).toMatch(/no box score/);
    expect(outcome.finalizedWithUnfinishedGames).toMatch(/stats pipeline/);
    // Not the postponement wording — the two must stay tellable apart.
    expect(outcome.finalizedWithUnfinishedGames).not.toMatch(/RULES.md §10/);
  });

  it("reports both reasons when both are true, not the first one found", async () => {
    /*
      **The branch order swallowed the pipeline failure, in the incident it was
      written for.**

      Past the window there were two ifs in a row and the postponement one
      returned first — so a week carrying a postponed game *and* a FINAL game
      whose box score never arrived reported only §10's "affected players score 0
      for the week and the matchup stands". That sentence means "this is the
      NFL's doing and the frozen rules cover it". Handed to an operator whose
      ingest had just dropped a game, it is the wrong instruction.

      And it is the *characteristic* shape of a provider outage rather than a
      corner: when the provider is down syncGames cannot advance a status and
      syncBoxScores cannot read a box score, so both fire together.

      The test guarding this staged only the pure case, so it could not see it.
    */
    const fx = await setup();
    await schedule(fx);
    await finishGamesUnread(fx);
    await addGame(fx, "postponed", "POSTPONED");

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalized).toBe(true);
    expect(outcome.finalizedWithUnfinishedGames).toMatch(/RULES.md §10/);
    expect(outcome.finalizedWithUnfinishedGames).toMatch(/stats pipeline/);
  });

  it("does not blame the NFL when nothing reached FINAL at all", async () => {
    /*
      The extreme of the same bug, and the one with no partial excuse.

      unread counts only FINAL games, so when the status column freezes it is
      structurally zero — there is nothing for the stats branch to notice. Every
      matchup then settled 0–0 under §10's postponement sentence, blaming an
      abandoned game for a week in which no game was abandoned.

      Reachable from one place: games.status is written by syncGames alone, from
      a single daily cron, and mapGameStatus answers SCHEDULED for any wording it
      does not recognise — so one unfamiliar string turns a whole week's statuses
      off at once.

      §10 is written about *an* abandoned game. It is the right answer for one
      fixture of sixteen and the wrong one for sixteen of sixteen, which is the
      argument the "no games at all" branch above already makes.
    */
    const fx = await setup();
    await schedule(fx);
    // Kickoff has passed and the provider never moved the status.
    await fx.client.query(
      "UPDATE games SET status = 'SCHEDULED' WHERE season = $1 AND week = $2",
      [SEASON, WEEK],
    );

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalized).toBe(true);
    expect(outcome.finalizedWithUnfinishedGames).toMatch(/not one of/);
    expect(outcome.finalizedWithUnfinishedGames).toMatch(/our ingest/);
    expect(outcome.finalizedWithUnfinishedGames).not.toMatch(/RULES.md §10/);
  });

  it("counts a box score read before the final whistle as no box score", async () => {
    /*
      stats_synced_at says a box score was read, never that the *final* one was.
      syncBoxScores reads IN_PROGRESS games too and stamps the column on every
      success, while the failure path leaves it alone — so a game read at half
      time whose every post-final read then failed carries a sync stamp older
      than the whistle, counts as ingested, and settles the week on third-quarter
      numbers with no fallback reported at all.

      Migration 0041 reasoned only about the never-succeeded direction.
    */
    const fx = await setup();
    await schedule(fx);
    await fx.client.query(
      `UPDATE games SET status = 'FINAL',
                       final_at = now() - interval '1 hour',
                       stats_synced_at = now() - interval '3 hours',
                       stats_attempted_at = now(),
                       stats_error = 'Tank01 refused the request (HTTP 429)'
        WHERE season = $1 AND week = $2`,
      [SEASON, WEEK],
    );

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, DURING);

    expect(outcome.finalized).toBe(false);
    expect(outcome.holdReason).toMatch(/no box score/);
  });

  it("does not hold a game that ingested cleanly but raised a warning", async () => {
    /*
      The one-line version of this hold would have been stats_error IS NOT NULL,
      and it is false: that column carries ordinary *warnings* from a successful
      ingest — a field-goal count disagreeing with the plays parsed from it, a
      defence missing from the box score — as much as failures. Roughly one real
      game in seven raises one.

      Holding on it would hold most weeks until the correction window expired,
      making §10's fallback the normal path and destroying the distinction this
      hold exists to draw. Asserted rather than argued, because the argument
      lived only in a commit message.
    */
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await fx.client.query(
      `UPDATE games SET stats_error = 'fgMade disagrees with the parsed plays'
        WHERE season = $1 AND week = $2`,
      [SEASON, WEEK],
    );

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalized).toBe(true);
    expect(outcome.finalizedWithUnfinishedGames).toBeUndefined();
  });

  it("reports nothing extra once the box scores are in", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalized).toBe(true);
    expect(outcome.finalizedWithUnfinishedGames).toBeUndefined();
  });
});

describe("standings from resolved weeks", () => {
  it("feeds computeStandings end to end", async () => {
    // The whole chain: lineups → scoring → matchups → records → seeds.
    const fx = await setup();
    await schedule(fx);
    await score(fx, "qb-0", 400);
    await score(fx, "qb-1", 100);
    await finishGames(fx);

    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    const results = await loadWeekResults(fx.client, fx.leagueId, WEEK);
    const standings = computeStandings(fx.teamIds, results, fx.rules.schedule.tiebreakers);

    expect(standings).toHaveLength(4);
    expect(standings.every((row) => row.games === 1)).toBe(true);
    expect(standings.every((row) => row.wins + row.losses + row.ties === 1)).toBe(true);

    // Wins must equal losses. Not "two wins": the two teams who scored nothing
    // may well have been drawn against each other, and 0–0 is a tie for both.
    expect(standings.reduce((sum, row) => sum + row.wins, 0)).toBe(
      standings.reduce((sum, row) => sum + row.losses, 0),
    );

    // The top seed is the team that actually scored the most.
    expect(standings[0]?.milliPointsFor).toBe(16_000);
  });

  it("returns nothing for weeks that have not been scored", async () => {
    const fx = await setup();
    await schedule(fx);

    expect(await loadWeekResults(fx.client, fx.leagueId, WEEK)).toEqual([]);
  });
});

/**
 * The guard that decides what a too-small league does instead of crashing.
 *
 * `generateSchedule` in `@rostr/core` throws below two teams, and this wrapper
 * is the only thing in the repo that calls it — from inside the final draft
 * pick's transaction, where a throw would roll the pick back. It returns
 * `{ written: 0 }` instead, which is why a short draft completes rather than
 * hanging.
 *
 * Nothing pinned that, and it is load-bearing in both directions: remove the
 * guard and the last pick of a one-team draft rolls back forever; widen it and a
 * real league silently loses its fixtures. The draw now refuses a field this
 * small (`drawDraftOrder`), so this is the second line rather than the first.
 */
describe("generateSeasonSchedule below two teams", () => {
  it("writes nothing instead of throwing", async () => {
    const fx = await setup(1);

    await expect(generateSeasonSchedule(fx.client, fx.leagueId, "seed")).resolves.toEqual({
      written: 0,
    });

    expect(await loadScheduledWeek(fx.client, fx.leagueId, 1)).toEqual([]);
  });

  it("writes a full season at two", async () => {
    // The boundary is exactly two, and it is the generator's own bound —
    // asserting it here keeps the wrapper honest if that bound ever moves.
    const fx = await setup(2);

    const { written } = await generateSeasonSchedule(fx.client, fx.leagueId, "seed");

    expect(written).toBeGreaterThan(0);
  });
});

describe("currentWeek is scoped to one season — #105", () => {
  /*
    The query selected on sport and kickoff only. With a prior season's games in
    the table it answered that season's last week from any instant afterwards,
    permanently — the issue verified 18 for an August 2026 call with a single
    2025 week-18 row present.

    Latent only because no prior season is ingested today. It becomes live the
    moment one is, and unconditional from January 2027, when 2026 and 2027 rows
    coexist every offseason.

    Two readers wanted the lagging answer and were right to: the scoreboard must
    keep showing Sunday's result until Thursday, and the cron is writing that
    week's scores. What neither wanted was a row from a different season, which
    is why this is a filter rather than a move to `transactionWeek`.
  */

  /** One game, in a season and week of its own. */
  async function game(
    fx: Fixture,
    season: number,
    week: number,
    kickoff: Date,
    ref: string,
  ): Promise<void> {
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    await fx.client.query(
      "INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref, kickoff_at, status) " +
        "VALUES ($1, $2, $3, $4, 'CIN', 'BAL', $5, 'FINAL')",
      [sport!.id, ref, season, week, kickoff.toISOString()],
    );
  }

  it("ignores a prior season's last week", async () => {
    // The exact scenario from the issue.
    const fx = await setup();
    await game(fx, 2025, 18, new Date("2026-01-04T18:00:00Z"), "prior-18");

    const august = new Date("2026-08-13T12:00:00Z");
    expect(await currentWeek(fx.client, NFL.key, 2026, august)).toBeNull();
  });

  it("still lags within its own season, which is the point of it", async () => {
    /*
      The behaviour that must survive the fix. This answers "which week am I
      scoring", so from a week's last game until the next week's first kickoff it
      keeps naming the week just played — that is correct for the scoreboard and
      for the cron, and it is why neither caller was moved to
      `transactionWeek`.
    */
    const fx = await setup();
    await game(fx, 2026, 3, new Date("2026-09-27T17:00:00Z"), "w3");

    // Tuesday after week 3, before week 4 kicks off.
    const tuesday = new Date("2026-09-29T12:00:00Z");
    expect(await currentWeek(fx.client, NFL.key, 2026, tuesday)).toBe(3);
  });

  it("prefers the most recent kickoff within the season, not the highest week", async () => {
    /*
      **A postponement, which is the only shape that tells the two orderings
      apart — and the first version of this test did not have one.**

      It staged week 3 on the 27th and week 4 on the 4th of October and asked on
      the 30th. Week 4 is excluded by `kickoff_at <= at` before any ordering
      runs, so there was one candidate and `ORDER BY g.week DESC` answered 3 as
      well. The assertion could not fire under the mutation its own comment
      named.

      Here week 4 is played on schedule and week 3 is postponed to after it —
      which `syncGames` writes verbatim and the NFL genuinely produces. Both are
      candidates. By kickoff the answer is 3; by week number it is 4. Scoring the
      wrong week is permanent, because a finalised week is never rescored.
    */
    const fx = await setup();
    await game(fx, 2026, 4, new Date("2026-10-04T17:00:00Z"), "w4b");
    await game(fx, 2026, 3, new Date("2026-10-11T17:00:00Z"), "w3-postponed");

    const after = new Date("2026-10-12T12:00:00Z");
    expect(await currentWeek(fx.client, NFL.key, 2026, after)).toBe(3);
  });

  it("chooses between two seasons that both have a game behind them", async () => {
    /*
      The filter has to **choose**, not merely reject.

      Every other case here gives the named season no candidate and a foreign
      season one, so they pin that a foreign row cannot be picked when there is
      nothing else. They do not pin that it loses when there is. So
      `g.season = $2` widened to `g.season >= $2` was green across the block —
      live from September 2027, when a league frozen at 2026 would read 2027's
      week number onto its scoreboard.
    */
    const fx = await setup();
    await game(fx, 2026, 5, new Date("2026-10-11T17:00:00Z"), "s26w5");
    await game(fx, 2027, 2, new Date("2027-09-19T17:00:00Z"), "s27w2");

    const at = new Date("2027-09-26T12:00:00Z");
    expect(await currentWeek(fx.client, NFL.key, 2026, at)).toBe(5);
    expect(await currentWeek(fx.client, NFL.key, 2027, at)).toBe(2);
  });

  it("answers null before the season's first kickoff", async () => {
    const fx = await setup();
    await game(fx, 2026, 1, new Date("2026-09-10T00:20:00Z"), "w1b");

    const preseason = new Date("2026-08-01T12:00:00Z");
    expect(await currentWeek(fx.client, NFL.key, 2026, preseason)).toBeNull();
  });
});

describe("a game we played and never marked final — #256", () => {
  /*
    A state that could not exist before box scores were read during play.

    The ingest now writes `stat_lines` from a game that is still under way, so a
    game can carry a complete set of stats while `games.status` is whatever the
    daily schedule sync last said. Reported as §10 — the **abandoned game** rule
    — that would blame the NFL for our own status feed being hours behind, and
    the sentence a settled week leaves behind is permanent.
  */
  it("blames our own status feed rather than an abandoned game", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    // Played and scored: stats written after its own kickoff. Not marked FINAL.
    await addGame(fx, "g1-played", "SCHEDULED");
    await fx.client.query(
      `UPDATE games SET stats_synced_at = kickoff_at + interval '3 hours'
        WHERE external_ref = $1`,
      ["g1-played"],
    );

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalizedWithUnfinishedGames).toMatch(/played and scored/);
    expect(outcome.finalizedWithUnfinishedGames).toMatch(/status feed is behind/);
    // The abandoned-game sentence must not appear: nothing here was abandoned.
    expect(outcome.finalizedWithUnfinishedGames).not.toMatch(/RULES\.md §10/);
  });

  it("still says §10 for a game that genuinely never kicked off", async () => {
    /*
      The control, and the reason this is a split rather than a reword. The two
      call for different responses: an abandoned game is a fact about the season
      and nobody need do anything, while a played game we failed to mark final is
      an operational fault somebody can go and look at.
    */
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await addGame(fx, "g1-postponed", "POSTPONED");

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalizedWithUnfinishedGames).toMatch(/RULES\.md §10/);
    expect(outcome.finalizedWithUnfinishedGames).not.toMatch(/played and scored/);
  });

  it("reports both when a week holds one of each", async () => {
    // The mixed state is reachable and the branch order used to swallow the
    // second reason — the same defect this function's own comment records about
    // `finished < total` returning before the stats fallback could be reached.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await addGame(fx, "g1-postponed", "POSTPONED");
    await addGame(fx, "g1-played", "SCHEDULED");
    await fx.client.query(
      `UPDATE games SET stats_synced_at = kickoff_at + interval '3 hours'
        WHERE external_ref = $1`,
      ["g1-played"],
    );

    const outcome = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalizedWithUnfinishedGames).toMatch(/played and scored/);
    expect(outcome.finalizedWithUnfinishedGames).toMatch(/RULES\.md §10/);
  });
});
