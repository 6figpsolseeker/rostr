/**
 * Issue #76 part 2 — a finalised week must not be silently rescored.
 *
 * ## The defect these pin
 *
 * `resolveLeagueWeek` checks "is this week already final?" with a bare `SELECT
 * count(*)` **outside any transaction**, and then writes inside a *later*
 * transaction. Between the two sit `ensureLineups` (which opens a transaction of
 * its own), `loadWeekLineups`, `loadWeekStats` and `finalizationHold` — four
 * round trips. That check is a check-then-act with a wide window.
 *
 * The write used to carry no `finalized_at` predicate, so nothing held the
 * window closed. Two overlapping runs both read `count = 0` and both wrote; the
 * slower one's stat snapshot was older, and `finalized_at = CASE WHEN $5 THEN $6
 * ELSE finalized_at END` meant the row kept its original timestamp — so nothing
 * stored recorded that it had happened, and nothing revisits a finalised week to
 * find out. The write now carries `AND finalized_at IS NULL`, which is what
 * actually keeps a settled week settled.
 *
 * ## How the interleaving is produced, and what that does and does not prove
 *
 * The fast test project runs PGlite, which is a **single connection**. It cannot
 * run two real transactions at once, and `FOR UPDATE` holds nothing in it — the
 * repo says as much in `migrations/README.md`. So this does not prove anything
 * by racing.
 *
 * Instead it produces the interleaving deterministically. `PausingClient` wraps
 * the real client and suspends the slow run at the exact instruction boundary a
 * race would suspend it: after its guard read and its stat read, immediately
 * before its write transaction's `BEGIN`. The fast run then completes on the
 * unwrapped client, and the slow run is released.
 *
 * **Read this before trusting the results.** Because the slow run is suspended
 * *before* its `BEGIN`, the two write transactions never overlap in time: the
 * fast run commits, then the slow run starts and takes a fresh READ COMMITTED
 * snapshot that sees the committed `finalized_at`. The predicate is evaluated by
 * ordinary visibility rules. **That is not EvalPlanQual** — EPQ is the narrower
 * case where the two `UPDATE`s overlap, the loser blocks on the row lock, and
 * Postgres re-evaluates its `WHERE` against the winner's newly committed version
 * on wake-up. That case cannot be produced on one connection at all: pausing
 * after `BEGIN` would not create contention, it would nest two transactions and
 * let the fast run's `COMMIT` commit the slow run's work. Any test in this suite
 * claiming to cover EPQ would be lying.
 *
 * So these cover the interleaving that was actually reproduced — which is also
 * the wide one, since the read-to-write window is four round trips while the
 * write transaction is a single statement. The EPQ residual is closed by the
 * same predicate, by argument rather than by this file.
 *
 * What none of this proves: that two Vercel invocations do in fact overlap in
 * production. That is an argument about the schedule (`apps/web/vercel.json`
 * runs `score-week` every 10 minutes) and about the absence of any lock, not
 * something a single-connection test can observe. The predicate is worth having
 * regardless — `docs/RULES.md` §7 already says a correction arriving after a
 * paying week has finalised does not reopen it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, generateSchedule, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { setLineup } from "./lineups.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { loadScheduledWeek, persistSchedule, resolveLeagueWeek, winnerOf } from "./week.js";

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
/** Inside the 48h standings window — `finalizationHold` says "wait". */
const INSIDE_WINDOW = new Date(KICKOFF.getTime() + 47 * 3600 * 1000);
/** Past it — the week may finalise. */
const AFTER_STANDARD = new Date(KICKOFF.getTime() + 49 * 3600 * 1000);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A client that suspends its caller immediately before the write transaction.
 *
 * The gate is armed by `finalizationHold`'s query (the `FILTER (WHERE g.status =
 * 'FINAL')` aggregate) and fires on the next `BEGIN`, which is
 * `withTransaction`'s. Arming on the hold query rather than on the first `BEGIN`
 * matters: `ensureLineups` opens a transaction of its own when a team is missing
 * a lineup, and pausing there would be a different — and less interesting —
 * interleaving.
 *
 * No `connect`, so `withTransaction` runs the callback directly on it, exactly
 * as it does for PGlite.
 */
class PausingClient implements SqlClient {
  private armed = false;
  private fired = false;
  readonly reached = deferred();
  readonly release = deferred();
  /**
   * How many rows each `UPDATE matchups` actually touched.
   *
   * Readable only because the statement now ends in `RETURNING id`.
   * `PostgresClient.query` returns `result.rows` and discards `rowCount`, so
   * before that this number was not merely ignored — it was unobtainable, which
   * is why a refused write could not have been reported even in principle.
   */
  readonly rowsWritten: number[] = [];

  constructor(
    private readonly inner: SqlClient,
    private readonly pause = true,
  ) {
    if (!pause) {
      this.reached.resolve();
      this.release.resolve();
    }
  }

  async exec(sql: string): Promise<void> {
    if (
      this.pause &&
      this.armed &&
      !this.fired &&
      sql.trim().toUpperCase().startsWith("BEGIN")
    ) {
      this.fired = true;
      this.reached.resolve();
      await this.release.promise;
    }
    return this.inner.exec(sql);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    if (sql.includes("g.status = 'FINAL'")) this.armed = true;

    const rows = await this.inner.query<T>(sql, params);
    if (sql.includes("UPDATE matchups")) this.rowsWritten.push(rows.length);
    return rows;
  }
}

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  rules: LeagueRules;
  teamIds: string[];
  players: Map<string, string>;
  statKeys: Map<string, string>;
}

/** The same fixture `week.test.ts` uses, trimmed to what this needs. */
async function setup(teamCount = 4): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = buildNflPprRules({ seasonYear: SEASON, draft: DRAFT }) as LeagueRules;
  const league = await createLeague(db, NFL, {
    name: "Race League",
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

const finishGames = (fx: Fixture) =>
  fx.client.query("UPDATE games SET status = 'FINAL' WHERE season = $1 AND week = $2", [
    SEASON,
    WEEK,
  ]);

const schedule = (fx: Fixture) =>
  persistSchedule(fx.client, fx.leagueId, generateSchedule(fx.teamIds, 14, "seed"));

interface StoredRow {
  home_team_id: string;
  away_team_id: string | null;
  home_milli_points: number | null;
  away_milli_points: number | null;
  finalized_at: string | null;
}

/** The stored row for the matchup team 0 plays in. */
async function storedRow(fx: Fixture): Promise<StoredRow> {
  const [row] = await fx.client.query<StoredRow>(
    `SELECT home_team_id, away_team_id, home_milli_points, away_milli_points, finalized_at
       FROM matchups
      WHERE league_id = $1 AND week = $2
        AND (home_team_id = $3 OR away_team_id = $3)`,
    [fx.leagueId, WEEK, fx.teamIds[0]],
  );
  return row!;
}

const storedWinner = (row: StoredRow): string | null =>
  winnerOf({
    week: WEEK,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    homeMilliPoints: Number(row.home_milli_points ?? 0),
    awayMilliPoints: Number(row.away_milli_points ?? 0),
  });

/**
 * Set up team 0's matchup so the stale snapshot and the corrected one disagree
 * about the *winner*, not merely about a total. Returns the opponent's index.
 */
async function armWinnerFlip(fx: Fixture): Promise<{ opponentIndex: number }> {
  const scheduled = await loadScheduledWeek(fx.client, fx.leagueId, WEEK);
  const mine = scheduled.find(
    (m) => m.homeTeamId === fx.teamIds[0] || m.awayTeamId === fx.teamIds[0],
  )!;
  const opponentId = mine.homeTeamId === fx.teamIds[0] ? mine.awayTeamId! : mine.homeTeamId;
  const opponentIndex = fx.teamIds.indexOf(opponentId);
  expect(opponentIndex).toBeGreaterThan(0);

  // Revision 0 — the snapshot the slow run will read: team 0 has 4 points, the
  // opponent 8. The opponent is winning.
  await score(fx, "qb-0", 100);
  await score(fx, `qb-${opponentIndex}`, 200);

  return { opponentIndex };
}

describe("a finalised week survives a run that overlapped its finalisation", () => {
  it("CONTROL: the pre-check still refuses a serialised second run", async () => {
    // Nothing was ever wrong with the guard when the two runs do not overlap,
    // and the predicate does not replace it — it is still the cheap fast path
    // that avoids scoring a week nobody will write. Repeated here so the tests
    // below are visibly about the interleaving.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await armWinnerFlip(fx);

    await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);
    await expect(
      resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD),
    ).rejects.toMatchObject({ code: "ALREADY_FINAL" });
  });

  it("refuses the losing write and leaves the settled result byte-identical", async () => {
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    const { opponentIndex } = await armWinnerFlip(fx);

    // --- the slow run starts, reads its guard (count = 0) and its stats, and is
    // suspended immediately before its write transaction.
    const gated = new PausingClient(fx.client);
    const slow = resolveLeagueWeek(gated, fx.leagueId, WEEK, AFTER_STANDARD);
    await gated.reached.promise;

    // --- while it is suspended, an NFL stat correction lands. Team 0's
    // quarterback is upgraded from 100 to 500 passing yards: 4 points to 20, so
    // team 0 now wins a matchup it was losing.
    await score(fx, "qb-0", 500, 1);

    // --- the fast run (the 10-minute cron, or the manual `?week=` call — the
    // same code path) reads the guard, sees count = 0 because the slow run has
    // written nothing yet, scores the correction, and finalises.
    const fast = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);
    expect(fast.finalized).toBe(true);

    const settled = await storedRow(fx);
    expect(settled.finalized_at).not.toBeNull();
    expect(storedWinner(settled)).toBe(fx.teamIds[0]);

    // --- the slow run wakes and tries to write its pre-correction snapshot over
    // the finalised row.
    gated.release.resolve();
    await expect(slow).rejects.toMatchObject({ code: "ALREADY_FINAL" });

    // Both of the week's matchups were final, so both writes matched nothing.
    expect(gated.rowsWritten).toEqual([0, 0]);

    // The row is exactly what the fast run settled — not merely "still final".
    // The failure this replaces kept `finalized_at` and changed only the points,
    // so asserting the timestamp alone would have passed against the bug.
    expect(await storedRow(fx)).toEqual(settled);
    expect(storedWinner(await storedRow(fx))).toBe(fx.teamIds[0]);
    expect(storedWinner(await storedRow(fx))).not.toBe(fx.teamIds[opponentIndex]);
  });

  it("refuses it even when the losing run believes it is not finalising anything", async () => {
    // The worse shape, and the one a `finalized_at`-only guard would miss. The
    // slow run is a request that started inside the correction window — the
    // route takes `now = new Date()` at its own start, so two invocations do not
    // share one — therefore its `finalizationHold` says "wait" and `finalized`
    // is false. Its UPDATE used to take the `ELSE finalized_at` branch: points
    // replaced, timestamp preserved byte for byte, the row afterwards
    // indistinguishable from one finalised once and never touched. And it
    // reported `finalized: false, holdReason: "waiting until…"` while doing it.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    const { opponentIndex } = await armWinnerFlip(fx);

    const gated = new PausingClient(fx.client);
    const slow = resolveLeagueWeek(gated, fx.leagueId, WEEK, INSIDE_WINDOW);
    await gated.reached.promise;

    await score(fx, "qb-0", 500, 1);

    const fast = await resolveLeagueWeek(fx.client, fx.leagueId, WEEK, AFTER_STANDARD);
    expect(fast.finalized).toBe(true);

    const settled = await storedRow(fx);
    expect(settled.finalized_at).not.toBeNull();

    gated.release.resolve();
    await expect(slow).rejects.toMatchObject({ code: "ALREADY_FINAL" });

    // The predicate gates the whole statement, so the points are protected even
    // though this run would never have touched `finalized_at`.
    expect(await storedRow(fx)).toEqual(settled);
    expect(storedWinner(await storedRow(fx))).toBe(fx.teamIds[0]);
    expect(storedWinner(await storedRow(fx))).not.toBe(fx.teamIds[opponentIndex]);
  });

  it("CONTROL: an ordinary run writes every row and reports nothing refused", async () => {
    // The predicate must not be a fix that also stops the normal path working.
    // No prior finalisation, no pausing.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    const { opponentIndex } = await armWinnerFlip(fx);

    const watched = new PausingClient(fx.client, false);
    const outcome = await resolveLeagueWeek(watched, fx.leagueId, WEEK, AFTER_STANDARD);

    expect(outcome.finalized).toBe(true);
    // One row per matchup — the clause narrows nothing on an unfinalised week.
    expect(watched.rowsWritten).toEqual([1, 1]);
    expect(outcome.matchups).toBe(2);
    expect(outcome.matchupsAlreadyFinal).toBeUndefined();

    const row = await storedRow(fx);
    expect(row.finalized_at).not.toBeNull();
    // No correction landed in this test, so the pre-correction snapshot stands
    // and the opponent's 8 points beat team 0's 4. That is the *correct* result
    // here, and asserting team 0 — as the race tests do, after their correction
    // — would be asserting the bug.
    expect(storedWinner(row)).toBe(fx.teamIds[opponentIndex]);
  });

  it("keeps a legitimate write when only some of the week is final, and says so", async () => {
    // The reason a blanket throw would be wrong. A week can hold a settled row
    // beside an open one, and rolling the run back to punish the settled row
    // would destroy a real write to the open one — for which nothing would ever
    // try again, since the sweep skips a week holding any finalised row.
    //
    // The mixed state is constructed rather than raced: one of the week's two
    // rows is finalised directly while the slow run is suspended. That is the
    // only way to put a row in the loser's result set that the winner never
    // settled, because any real `resolveLeagueWeek` winner finalises every row
    // of the week at once.
    const fx = await setup();
    await schedule(fx);
    await finishGames(fx);
    await armWinnerFlip(fx);

    const gated = new PausingClient(fx.client);
    const slow = resolveLeagueWeek(gated, fx.leagueId, WEEK, AFTER_STANDARD);
    await gated.reached.promise;

    // Exactly one of the week's rows becomes final — the one team 0 is *not* in,
    // so the row asserted on afterwards is the one still open.
    const [locked] = await fx.client.query<{ id: string }>(
      `UPDATE matchups SET home_milli_points = 1, away_milli_points = 2, finalized_at = $3
        WHERE league_id = $1 AND week = $2
          AND home_team_id <> $4 AND away_team_id IS DISTINCT FROM $4
        RETURNING id`,
      [fx.leagueId, WEEK, AFTER_STANDARD.toISOString(), fx.teamIds[0]],
    );
    expect(locked).toBeDefined();

    gated.release.resolve();
    const outcome = await slow;

    const open = await storedRow(fx);
    const [stillLocked] = await fx.client.query<StoredRow>(
      `SELECT home_team_id, away_team_id, home_milli_points, away_milli_points, finalized_at
         FROM matchups WHERE id = $1`,
      [locked!.id],
    );

    // One skipped, one written — the input that must not throw.
    expect([...gated.rowsWritten].sort()).toEqual([0, 1]);

    // The finalised row is untouched...
    expect(Number(stillLocked!.home_milli_points)).toBe(1);
    expect(Number(stillLocked!.away_milli_points)).toBe(2);

    // ...the open row carries its real write...
    expect(open.home_milli_points).not.toBeNull();
    expect(Number(open.home_milli_points) + Number(open.away_milli_points)).toBe(12_000);

    // ...and the outcome describes what actually happened rather than what was
    // scored. Reporting `matchups: 2` here would assert a write the settled row
    // never received.
    expect(outcome.matchups).toBe(1);
    expect(outcome.matchupsAlreadyFinal).toBe(1);
  });
});
