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
 * rescored — and that is enforced by `AND finalized_at IS NULL` on the write
 * itself, not by the `ALREADY_FINAL` check above it. The check reads in its own
 * statement and the write happens four round trips later, so two overlapping
 * runs both passed it and the slower one overwrote a settled result. Making the
 * write conditional is what closes that, because it is the write that has to
 * refuse.
 *
 * ## The wait is bounded, because a game may never be played
 *
 * `docs/RULES.md` §10 answers the postponed game in advance — "affected players
 * score 0 for that week, the matchup stands" — and the window above is the
 * "scoring window" that rule is written against. So once it has elapsed the week
 * finalises whether or not every game reached `FINAL`, and
 * {@link ResolveWeekOutcome.finalizedWithUnfinishedGames} says so. Waiting past
 * it instead would hold the week forever on one abandoned game, which in weeks 14
 * and 17 means nobody is ever paid.
 */

import {
  generateSchedule,
  indexScoringRules,
  latestWeekly,
  resolveWeek,
  winnerOf,
} from "@rostr/core";
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
 * arbitrary week (a lineup for a past week, say) can still accept one.
 *
 * **But a caller enforcing a rule wants `transactionWeek`, not this.** This
 * answers "which week am I scoring" and so keeps naming a week whose games have
 * all been played, right up until the next week kicks off — which is the correct
 * lag for the scoreboard and a three-day hole in any rule that binds on where a
 * roster change lands. It is also not season-scoped: with a prior season's games
 * ingested it answers "week 18" all summer. Both defects have been shipped and
 * fixed once each, in the waiver lock and in the trade deadline.
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

/**
 * The week the league is currently **transacting** in.
 *
 * **Not `currentWeek`, and the difference is a rule.** `currentWeek` answers
 * "which week's scores am I writing" from the most recent kickoff, so from a
 * week's first kickoff until the *next* week's first kickoff it keeps answering
 * that week — including the Tuesday-to-Thursday stretch in which every one of
 * its games has already been played. `docs/RULES.md` §6's kickoff lock asked
 * against that week refuses every player who played, for days, and §6 opens free
 * agency at Wednesday 03:00 ET in the middle of them.
 *
 * This answers a different question: which week's games belong to the cycle the
 * league is transacting in now. §6's own table defines that cycle — every
 * unrostered player returns to waivers at Tuesday 00:00 ET — so the week is the
 * first one kicking off after the most recent weekly lock.
 *
 * The boundary is a weekday and a local hour out of the league's frozen rules,
 * never an offset, so it follows the November DST change rather than sliding an
 * hour through it.
 *
 * **Season-scoped, which `currentWeek` is not.** With two seasons ingested — and
 * validating the engine against real 2025 box scores is planned work — that one
 * answers "week 18" all summer, from a row belonging to a season the caller then
 * does not look the player up in.
 *
 * `null` when the current cycle holds no games at all: before the schedule is
 * ingested, and after the season ends. A caller enforcing a rule must read that
 * as "this lock cannot be checked", never as "nothing is locked".
 */
export async function transactionWeek(
  db: SqlClient,
  rules: LeagueRules,
  at: Date,
): Promise<number | null> {
  // The most recent weekly lock at or before `at`. This used to ask `nextWeekly`
  // from exactly `at - 7 * 24h`, which is an hour short across the fall-back and
  // named the *next* week for that hour — see `latestWeekly`.
  const since = latestWeekly(at, rules.waivers.weeklyLock, rules.waivers.timezone);

  const [row] = await db.query<{ week: number }>(
    `SELECT g.week
       FROM games g
       JOIN sports s ON s.id = g.sport_id
      WHERE s.key = $1 AND g.season = $2 AND g.kickoff_at > $3
      ORDER BY g.kickoff_at ASC
      LIMIT 1`,
    [rules.sportKey, rules.seasonYear, since.toISOString()],
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
  /**
   * How many matchups this run actually wrote — not how many it scored.
   *
   * The two differ only when a row was refused for being already final, which
   * `matchupsAlreadyFinal` then reports. Counting the scored results instead
   * would assert writes that a refused row never received.
   */
  readonly matchups: number;
  readonly finalized: boolean;
  /** Why it was not finalised, when it was not. */
  readonly holdReason?: string;
  /**
   * Set when the week finalised on `RULES.md` §10's postponement fallback —
   * the scoring window elapsed with games still not marked `FINAL`.
   *
   * Reported rather than inferred. A week settled on complete data and a week
   * settled because the clock ran out are different facts about the same
   * `finalized: true`, and only one of them is worth an operator's attention:
   * the games that never landed are now permanently scored as they stand,
   * because a finalised week is never rescored.
   */
  readonly finalizedWithUnfinishedGames?: string;
  /**
   * How many matchups this run declined to write because they were already
   * final, when it wrote at least one other.
   *
   * Present only when it happened, like `holdReason`. A run that was refused
   * everything throws `ALREADY_FINAL` instead — this field is the partial case,
   * where a week holds both a settled row and an open one and only the open one
   * moved. Reporting it matters for the same reason
   * `finalizedWithUnfinishedGames` does: without it the outcome describes writes
   * that did not happen, and an operator reads `matchups: 7` as seven rows
   * updated.
   */
  readonly matchupsAlreadyFinal?: number;
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

  const decision = await finalizationHold(db, stored.rules, week, now);
  const finalized = decision.hold === null;

  // `AND finalized_at IS NULL` is what actually keeps a settled week settled.
  // The check above is a fast path, not the guarantee: it reads in its own
  // autocommit statement, and by the time this transaction opens, four round
  // trips have passed — `ensureLineups` alone opens a transaction of its own.
  // Two runs overlapping in that gap both read zero, and the slower one used to
  // write its older stat snapshot straight over the finalised row, flipping who
  // won a week nothing would ever revisit.
  //
  // Moving the check inside the transaction would not have been enough. At READ
  // COMMITTED the loser blocks on the row lock, wakes when the winner commits,
  // and re-evaluates *this* WHERE against the committed row — so the predicate
  // has to be in the statement for the re-check to see it. That is also why no
  // `FOR UPDATE` is needed: serialising the two runs would only queue the loser
  // up to write its stale numbers in turn. The lock decides who writes first; it
  // cannot make a decision taken before the lock true afterwards.
  let written = 0;
  let alreadyFinal = 0;

  await withTransaction(db, async (tx) => {
    for (const result of results) {
      // `RETURNING id` because `PostgresClient.query` hands back `rows` and
      // drops `rowCount` — without it, a refused write is not merely ignored,
      // it is unobservable.
      const touched = await tx.query<{ id: string }>(
        `UPDATE matchups
            SET home_milli_points = $3,
                away_milli_points = $4,
                finalized_at = CASE WHEN $5::boolean THEN $6 ELSE finalized_at END
          WHERE league_id = $1 AND week = $2
            AND home_team_id = $7
            AND away_team_id IS NOT DISTINCT FROM $8
            AND finalized_at IS NULL
        RETURNING id`,
        [
          leagueId,
          week,
          result.homeMilliPoints,
          result.awayMilliPoints,
          finalized,
          now.toISOString(),
          result.homeTeamId,
          result.awayTeamId,
        ],
      );

      if (touched.length === 0) alreadyFinal++;
      else written++;
    }

    // Refused everything: another run settled this week while this one was
    // scoring, and the answer is the same one the fast path gives. Throwing
    // here costs nothing — the rollback has no writes to discard — and it keeps
    // the raced path and the serialised path reporting one fact.
    //
    // Refused *some* is a different fact and must not throw. A week can hold a
    // settled row beside an open one, and rolling back would destroy the
    // legitimate write to the open one. That case reports itself instead.
    if (written === 0 && results.length > 0) {
      throw new WeekError(`Week ${week} is already final`, "ALREADY_FINAL");
    }
  });

  return {
    week,
    matchups: written,
    finalized,
    ...(decision.hold === null ? {} : { holdReason: decision.hold }),
    ...(decision.fallback ? { finalizedWithUnfinishedGames: decision.fallback } : {}),
    ...(alreadyFinal > 0 ? { matchupsAlreadyFinal: alreadyFinal } : {}),
    results,
  };
}

/**
 * Resolve every week up to `throughWeek` that is not yet finalised.
 *
 * The scoring cron used to resolve only the single current week. That works for
 * a standings week (48h window), which closes before the next week's first
 * kickoff moves the pointer on. It does **not** work for a paying week (168h):
 * week 14's last game is a Monday night, week 15's first is the Thursday three
 * days later, so the pointer leaves week 14 with four days of its window still
 * to run and it is never finalised — leaving the regular-season prize, and any
 * bracket seeded from it, on provisional scores forever. The same abandons week
 * 17, the championship week, once week-18 games are ingested.
 *
 * Three properties are load-bearing, and each was got wrong first:
 *
 * **One week's failure may not stop the others.** A week that throws is recorded
 * and the sweep continues. Without that, an old unresolvable week blocks every
 * later week for that league on every run, forever — including the current one,
 * which is strictly worse than the bug being fixed, because before the sweep
 * existed a broken week 3 could not stop week 16 from scoring.
 *
 * **The selection and the refusal must agree.** This picks weeks where *no* row
 * is finalised; `resolveLeagueWeek` refuses a week where *any* row is. Selecting
 * on "any row unfinalised" instead makes a partially finalised week both
 * guaranteed to be selected and guaranteed to throw — unresolvable by
 * construction. That state is reachable: a smaller consolation bracket starts in
 * a later week than the main one, so a week can be finalised holding only
 * consolation fixtures and then receive playoff fixtures on a later advance.
 *
 * **It is bounded.** A league with a long tail of weeks that will not finalise —
 * a week whose games were never ingested at all, or one that throws every pass —
 * would otherwise re-run the full lineup-and-scoring work for every one of them
 * on every pass. The cap takes the most recent, because those are the ones with
 * money and an audience attached, and the caller is told what was left behind
 * rather than being left to infer it from silence.
 *
 * (A postponed game no longer belongs on that list: `finalizationHold` finalises
 * past the scoring window rather than waiting for a `FINAL` that never comes.
 * The cap still earns its keep for the cases above, and for a week whose window
 * simply has not closed yet.)
 */
export const SWEEP_LIMIT = 4;

export interface SweepOutcome {
  readonly outcomes: readonly ResolveWeekOutcome[];
  /** Weeks that threw, so a caller can surface them rather than guess. */
  readonly failures: readonly { readonly week: number; readonly reason: string }[];
  /** Older unfinalised weeks the cap left for a later run. */
  readonly deferred: readonly number[];
}

export async function resolveLeagueWeeksThrough(
  db: SqlClient,
  leagueId: string,
  throughWeek: number,
  now: Date,
  limit: number = SWEEP_LIMIT,
): Promise<SweepOutcome> {
  // `NOT EXISTS` rather than `finalized_at IS NULL`: a week is a candidate only
  // when none of its rows are finalised. See the note above on why the two
  // predicates have to be complements.
  const weeks = await db.query<{ week: number }>(
    `SELECT DISTINCT m.week
       FROM matchups m
      WHERE m.league_id = $1
        AND m.week <= $2
        AND NOT EXISTS (
              SELECT 1 FROM matchups f
               WHERE f.league_id = m.league_id
                 AND f.week = m.week
                 AND f.finalized_at IS NOT NULL
            )
      ORDER BY m.week`,
    [leagueId, throughWeek],
  );

  const all = weeks.map((row) => Number(row.week));
  // Ascending, and the *last* `limit` of them — the most recent. Ascending order
  // matters: a later week's fixtures may not exist until an earlier one
  // finalises, so resolving out of order would silently skip a round.
  const take = all.slice(Math.max(0, all.length - limit));
  const deferred = all.slice(0, Math.max(0, all.length - limit));

  const outcomes: ResolveWeekOutcome[] = [];
  const failures: { week: number; reason: string }[] = [];

  for (const week of take) {
    try {
      outcomes.push(await resolveLeagueWeek(db, leagueId, week, now));
    } catch (error) {
      failures.push({
        week,
        reason:
          error instanceof WeekError
            ? error.code
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }

  return { outcomes, failures, deferred };
}

/** What {@link finalizationHold} decided, and why. */
interface FinalizationDecision {
  /** Why the week may not be finalised yet, or `null` if it may. */
  readonly hold: string | null;
  /** Set only when it may *despite* games that never reached `FINAL`. */
  readonly fallback?: string;
}

/**
 * Whether a week may be finalised.
 *
 * Two conditions, and **only one of them is unconditional**: the correction
 * window must have elapsed since the week's last kickoff. Every game being
 * `FINAL` holds the week *inside* that window and stops holding it outside,
 * because a game that is never played never becomes `FINAL` and the wait would
 * otherwise have no end.
 *
 * ## Why the clock outranks the games
 *
 * `docs/RULES.md` §10 answers this contingency in advance, as it has to — the
 * rules are frozen at league creation and cannot be patched in December:
 *
 * > An NFL game is cancelled or postponed beyond the scoring window →
 * > **affected players score 0 for that week. The matchup stands.**
 *
 * "The scoring window" is the window this function already computes:
 * {@link finalizationHours} from the last kickoff, 48h normally and 168h for the
 * weeks that pay. Reading the rule against any other clock would mean inventing
 * a second deadline, and it would have to live in the rule set to be verifiable
 * — which would move the canonical encoding and break every anchored league's
 * `rules_hash`. So the rule is implemented against the window it names.
 *
 * **"Affected players score 0" needs no code here.** A player whose game was
 * never ingested has no row in `stat_lines_current`, `loadWeekStats` returns no
 * entry for him, and `scoreTeamLineup` scores an absent stat line as zero
 * (`packages/core/src/season/results.ts` — "absent, empty and zero are three
 * different things"). He is already scoring 0; the only thing standing between
 * that and a settled week was this hold. And "the matchup stands" is what
 * *not* intervening gets you: no row is voided, no opponent is credited.
 *
 * Stats that *did* arrive before a game was abandoned are kept, which the rule
 * does not speak to either way — see the note in the outcome type and the report
 * on this change. `stat_lines` is append-only precisely so a settled week stays
 * auditable, and deleting a partial line would be a larger intervention with no
 * rule behind it.
 *
 * ## What it costs
 *
 * A feed that stalls for a full 48 hours finalises the week on whatever stats
 * arrived, and a finalised week is never rescored — so a late stat line is a
 * correction that missed its window, exactly like one arriving at T+49h with
 * every game final. That is the same trade the window already makes, and it is
 * strictly better than the alternative: holding past the window means the week
 * never finalises at all, the bracket never advances (it reads finalised results
 * only), and weeks 14 and 17 never settle. One game's stats against the season's
 * payouts.
 *
 * Two things bound the risk. It is proportionate — 168h, not 48h, in the weeks
 * that pay, and a game unmarked for seven days is a real abandonment rather than
 * a slow ingest. And it is visible: the caller is told, rather than left to infer
 * a clean finalisation from the absence of a hold.
 *
 * The residual is a provider that keeps a postponed game in the same week and
 * moves its kickoff into the future: `last_kickoff` follows it and the window
 * moves with it. That is right when the game really is played later that week,
 * and it is the one case where the wait can still exceed the nominal window.
 */
async function finalizationHold(
  db: SqlClient,
  rules: LeagueRules,
  week: number,
  now: Date,
): Promise<FinalizationDecision> {
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
  // No games at all is not the postponement case and gets no fallback. There is
  // no kickoff to run a window from, and a week nobody has ingested would settle
  // every matchup 0–0 rather than zeroing the players of one abandoned game.
  if (total === 0) return { hold: "no games are scheduled for this week yet" };

  // `games.kickoff_at` is NOT NULL, so this cannot fire while `total > 0`. It
  // stays because the clock below is now the only thing that ends the wait, and
  // a missing clock must hold rather than finalise by default.
  if (!row?.last_kickoff) return { hold: "no kickoff times are known" };

  const finished = Number(row?.finished ?? 0);
  const hours = finalizationHours(rules, week);
  const clearsAt = new Date(new Date(row.last_kickoff).getTime() + hours * 3600 * 1000);

  if (now < clearsAt) {
    // Inside the window an unplayed game is the more useful thing to say: it is
    // the condition an operator can still act on, and the window is running
    // anyway.
    if (finished < total) {
      return { hold: `${total - finished} of ${total} games are still in progress` };
    }

    const paying = rules.settlement.payingWeeks.includes(week);
    return {
      hold:
        `waiting until ${clearsAt.toISOString()} — ${hours}h after the last kickoff` +
        (paying
          ? ", because this week pays out and NFL stat corrections arrive for up to seven days"
          : ""),
    };
  }

  if (finished < total) {
    return {
      hold: null,
      fallback:
        `finalised ${hours}h after the last kickoff with ${total - finished} of ${total} ` +
        `games not marked FINAL — docs/RULES.md §10: affected players score 0 for the ` +
        `week and the matchup stands`,
    };
  }

  return { hold: null };
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
