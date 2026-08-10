/**
 * Resolving a week.
 *
 * The job that turns stat lines into standings. Everything it needs already
 * existed and nothing called it: lineups are stored, `resolveWeek` scores them,
 * `matchups` is where results live.
 *
 * ## Order matters, and it is not arbitrary
 *
 *   1. **Fill missing lineups.** `resolveWeek` throws if a scheduled team has no
 *      lineup, correctly — scoring a missing team as zero would hand its opponent
 *      a free win. The autolineup makes that condition true.
 *   2. **Score.**
 *   3. **Write results**, but only for weeks that are actually finished.
 *
 * ## Finalisation is a separate decision from scoring
 *
 * Scores are written continuously so a manager can watch their week. Whether a
 * week is *final* is a different question, and `docs/RULES.md` §7 answers it: a
 * paying week waits 168 hours because official NFL stat corrections arrive for up
 * to seven days, and a week that has paid out cannot be un-paid. Ordinary weeks
 * wait 48.
 *
 * So `resolveLeagueWeek` updates points every time it runs and sets
 * `finalized_at` only once the wait has elapsed. A finalised week is never
 * rescored.
 */

import { generateSchedule, indexScoringRules, resolveWeek, winnerOf } from "@rostr/core";
import type { LeagueRules, MatchupResult, ScheduledMatchup } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { getLeagueRules } from "./leagues.js";
import { ensureLineups, loadWeekLineups, loadWeekStats } from "./lineups.js";
import { withTransaction } from "./transaction.js";

/** Mirrors the `matchup_phase` enum in migration 0005. */
export type MatchupPhase = "REGULAR" | "PLAYOFF" | "CONSOLATION";

export class WeekError extends Error {
  constructor(
    message: string,
    readonly code: "LEAGUE_NOT_FOUND" | "NO_SCHEDULE" | "ALREADY_FINAL",
  ) {
    super(message);
    this.name = "WeekError";
  }
}

/**
 * Which NFL week an instant falls in, from the schedule rather than a calendar
 * guess: the week of the most recent kickoff at or before it.
 *
 * **This exists so no route has to take a week from the client.** A deadline
 * checked against a client-supplied week is not a deadline — anyone could
 * trade in January by posting `week: 1`. Callers that legitimately display an
 * arbitrary week (a lineup for a past week, say) can still accept one; callers
 * enforcing a rule must use this.
 *
 * Returns `null` before the season's first kickoff, when there is no week yet.
 */
export async function currentWeek(
  db: SqlClient,
  sportKey: string,
  at: Date,
): Promise<number | null> {
  const [row] = await db.query<{ week: number }>(
    `SELECT g.week
       FROM games g
       JOIN sports s ON s.id = g.sport_id
      WHERE s.key = $1 AND g.kickoff_at <= $2
      ORDER BY g.kickoff_at DESC
      LIMIT 1`,
    [sportKey, at.toISOString()],
  );

  return row ? Number(row.week) : null;
}

/** How long after the last kickoff a week may be finalised. */
export function finalizationHours(rules: LeagueRules, week: number): number {
  return rules.settlement.payingWeeks.includes(week)
    ? rules.settlement.payingFinalizationHours
    : rules.settlement.standardFinalizationHours;
}

/**
 * The scheduled matchups for a week, read back from the database.
 *
 * The schedule is generated once and stored; regenerating it here would risk a
 * different answer from a changed seed or a changed team list.
 */
export async function loadScheduledWeek(
  db: SqlClient,
  leagueId: string,
  week: number,
): Promise<readonly ScheduledMatchup[]> {
  const rows = await db.query<{
    week: number;
    home_team_id: string;
    away_team_id: string | null;
  }>(
    `SELECT week, home_team_id, away_team_id
       FROM matchups
      WHERE league_id = $1 AND week = $2
      ORDER BY id`,
    [leagueId, week],
  );

  return rows.map((row) => ({
    week: Number(row.week),
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
  }));
}

export interface ResolveWeekOutcome {
  readonly week: number;
  readonly matchups: number;
  readonly finalized: boolean;
  /** Why it was not finalised, when it was not. */
  readonly holdReason?: string;
  readonly results: readonly MatchupResult[];
}

/**
 * Score a league's week and write the results.
 *
 * Safe to run repeatedly — that is how live scores stay current. A finalised
 * week is left alone.
 */
export async function resolveLeagueWeek(
  db: SqlClient,
  leagueId: string,
  week: number,
  now: Date,
): Promise<ResolveWeekOutcome> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new WeekError("League has no rules", "LEAGUE_NOT_FOUND");

  const scheduled = await loadScheduledWeek(db, leagueId, week);
  if (scheduled.length === 0) {
    throw new WeekError(
      `League ${leagueId} has no schedule for week ${week}. Generate it first.`,
      "NO_SCHEDULE",
    );
  }

  const [already] = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM matchups
      WHERE league_id = $1 AND week = $2 AND finalized_at IS NOT NULL`,
    [leagueId, week],
  );
  if (Number(already?.count ?? 0) > 0) {
    // A finalised week is not rescored. In a paying week it has already decided
    // money, and a silently changed result afterwards is the exact thing the
    // correction window exists to prevent.
    throw new WeekError(`Week ${week} is already final`, "ALREADY_FINAL");
  }

  await ensureLineups(db, leagueId, week, Math.floor(now.getTime() / 1000));

  const lineups = await loadWeekLineups(db, leagueId, week);
  const stats = await loadWeekStats(db, stored.rules.sportKey, stored.rules.seasonYear, week);

  const { results } = resolveWeek(
    scheduled,
    lineups,
    stats,
    indexScoringRules(stored.rules.scoring),
    stored.rules.roster,
  );

  const hold = await finalizationHold(db, stored.rules, week, now);

  await withTransaction(db, async (tx) => {
    for (const result of results) {
      await tx.query(
        `UPDATE matchups
            SET home_milli_points = $3,
                away_milli_points = $4,
                finalized_at = CASE WHEN $5::boolean THEN $6 ELSE finalized_at END
          WHERE league_id = $1 AND week = $2
            AND home_team_id = $7
            AND away_team_id IS NOT DISTINCT FROM $8`,
        [
          leagueId,
          week,
          result.homeMilliPoints,
          result.awayMilliPoints,
          hold === null,
          now.toISOString(),
          result.homeTeamId,
          result.awayTeamId,
        ],
      );
    }
  });

  return {
    week,
    matchups: results.length,
    finalized: hold === null,
    ...(hold === null ? {} : { holdReason: hold }),
    results,
  };
}

/**
 * Resolve every week up to `throughWeek` that still has an unfinalised matchup.
 *
 * The scoring cron used to resolve only the single current week. That works for
 * standings weeks (48h window), whose window closes before the next week's first
 * kickoff moves the pointer on. It does **not** work for a paying week (168h):
 * week 15's Thursday game arrives ~4 days after week 14's last game, so the
 * pointer leaves week 14 three days before its window elapses, and it would never
 * be finalised — leaving the regular-season prize, and any bracket built from it,
 * on provisional scores forever. The same abandons week 17 once week-18 games are
 * ingested.
 *
 * Sweeping every still-unfinalised week fixes that. Each call is safe and
 * idempotent: a finalised week is filtered out here and would in any case be
 * refused by `resolveLeagueWeek`.
 */
export async function resolveLeagueWeeksThrough(
  db: SqlClient,
  leagueId: string,
  throughWeek: number,
  now: Date,
): Promise<readonly ResolveWeekOutcome[]> {
  const weeks = await db.query<{ week: number }>(
    `SELECT DISTINCT week FROM matchups
      WHERE league_id = $1 AND week <= $2 AND finalized_at IS NULL
      ORDER BY week`,
    [leagueId, throughWeek],
  );

  const outcomes: ResolveWeekOutcome[] = [];
  for (const { week } of weeks) {
    outcomes.push(await resolveLeagueWeek(db, leagueId, Number(week), now));
  }
  return outcomes;
}

/**
 * Why a week may not be finalised yet, or `null` if it may.
 *
 * Two conditions, both necessary: every game must be final, and the correction
 * window must have elapsed since the last kickoff.
 */
async function finalizationHold(
  db: SqlClient,
  rules: LeagueRules,
  week: number,
  now: Date,
): Promise<string | null> {
  const rows = await db.query<{ total: number; finished: number; last_kickoff: string | null }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE g.status = 'FINAL')::int AS finished,
            max(g.kickoff_at) AS last_kickoff
       FROM games g
       JOIN sports s ON s.id = g.sport_id
      WHERE s.key = $1 AND g.season = $2 AND g.week = $3`,
    [rules.sportKey, rules.seasonYear, week],
  );

  const row = rows[0];
  const total = Number(row?.total ?? 0);
  if (total === 0) return "no games are scheduled for this week yet";

  const finished = Number(row?.finished ?? 0);
  if (finished < total) return `${total - finished} of ${total} games are still in progress`;

  if (!row?.last_kickoff) return "no kickoff times are known";

  const hours = finalizationHours(rules, week);
  const clearsAt = new Date(new Date(row.last_kickoff).getTime() + hours * 3600 * 1000);

  if (now < clearsAt) {
    const paying = rules.settlement.payingWeeks.includes(week);
    return (
      `waiting until ${clearsAt.toISOString()} — ${hours}h after the last kickoff` +
      (paying
        ? ", because this week pays out and NFL stat corrections arrive for up to seven days"
        : "")
    );
  }

  return null;
}

/**
 * Draw a league's season schedule and store it.
 *
 * Called when the draft completes, which is the first moment the field is
 * genuinely final. Seeded from the draft's own order seed — already derived from
 * a Solana block nobody could predict, already recorded — so the schedule is as
 * checkable as the draft order, and for the same reason: schedule luck is
 * retained deliberately, which means nobody may be able to arrange it.
 *
 * Idempotent. A league that already has fixtures keeps them.
 *
 * **Does not open a transaction**, unlike `persistSchedule`. It is called from
 * inside the transaction that records the final pick, and `withTransaction`
 * issues a real `BEGIN` on whichever client it is handed — nesting one would
 * make the inner `COMMIT` commit the outer work too.
 */
export async function generateSeasonSchedule(
  db: SqlClient,
  leagueId: string,
  seed: string,
): Promise<{ written: number }> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new WeekError("League has no rules", "LEAGUE_NOT_FOUND");

  // Ordered by join slot so the input to the generator is deterministic — it
  // sorts internally too, but relying on that would be relying on an
  // implementation detail of a different module.
  const teams = await db.query<{ id: string }>(
    "SELECT id FROM teams WHERE league_id = $1 ORDER BY slot",
    [leagueId],
  );
  if (teams.length < 2) return { written: 0 };

  return writeSchedule(
    db,
    leagueId,
    generateSchedule(
      teams.map((team) => team.id),
      stored.rules.schedule.regularSeasonWeeks,
      seed,
    ),
  );
}

/** The write itself, with no transaction of its own. */
async function writeSchedule(
  db: SqlClient,
  leagueId: string,
  schedule: readonly ScheduledMatchup[],
): Promise<{ written: number }> {
  const [existing] = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM matchups WHERE league_id = $1",
    [leagueId],
  );
  if (Number(existing?.count ?? 0) > 0) {
    // Rewriting a schedule mid-season changes who played whom, which changes
    // every record derived from it.
    return { written: 0 };
  }

  for (const matchup of schedule) {
    await db.query(
      `INSERT INTO matchups (league_id, week, phase, home_team_id, away_team_id)
       VALUES ($1, $2, 'REGULAR', $3, $4)`,
      [leagueId, matchup.week, matchup.homeTeamId, matchup.awayTeamId],
    );
  }

  return { written: schedule.length };
}

/**
 * Write a generated schedule into `matchups`, in its own transaction.
 *
 * Separate from resolution: the schedule is drawn once, at the start of a
 * season, and resolution runs every week against what was drawn.
 *
 * Use `generateSeasonSchedule` from inside an existing transaction instead —
 * `withTransaction` issues a real `BEGIN`, so nesting is not free.
 */
export async function persistSchedule(
  db: SqlClient,
  leagueId: string,
  schedule: readonly ScheduledMatchup[],
): Promise<{ written: number }> {
  return withTransaction(db, (tx) => writeSchedule(tx, leagueId, schedule));
}

/**
 * Results for the standings.
 *
 * **Regular-season games only.** Seeds are decided by the regular season, and a
 * bracket game counting toward a record would let a team improve the seed that
 * put them in the bracket — and, worse, would keep shifting the standings that
 * the bracket was built from. `phase` is the filter; the week bound alone is not
 * enough, because playoff weeks share the same table.
 */
export async function loadWeekResults(
  db: SqlClient,
  leagueId: string,
  throughWeek: number,
  phase: MatchupPhase = "REGULAR",
  finalizedOnly = false,
): Promise<readonly MatchupResult[]> {
  // `finalizedOnly` is what the playoff bracket asks for. Advancement and the
  // derived champion must key on a settled result, not a provisional one: a
  // bracket built from live or not-yet-finalised scores advances the wrong team
  // (and lays orphan fixtures), and a paying week's result can still change
  // inside the correction window. A finalised matchup always has points, so this
  // narrows rather than contradicts the `home_milli_points IS NOT NULL` guard.
  const rows = await db.query<{
    week: number;
    home_team_id: string;
    away_team_id: string | null;
    home_milli_points: number | null;
    away_milli_points: number | null;
  }>(
    `SELECT week, home_team_id, away_team_id, home_milli_points, away_milli_points
       FROM matchups
      WHERE league_id = $1 AND week <= $2 AND phase = $3 AND home_milli_points IS NOT NULL${
        finalizedOnly ? " AND finalized_at IS NOT NULL" : ""
      }
      ORDER BY week, id`,
    [leagueId, throughWeek, phase],
  );

  return rows.map((row) => ({
    week: Number(row.week),
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    homeMilliPoints: Number(row.home_milli_points ?? 0),
    awayMilliPoints: Number(row.away_milli_points ?? 0),
  }));
}

export { winnerOf };
