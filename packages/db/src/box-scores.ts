/**
 * Box scores into `stat_lines`.
 *
 * The missing producer. Everything downstream of this file was built and
 * reading an empty table: `loadWeekStats`, `loadAverages`, the scoreboard, and
 * through them every matchup score, every playoff seed and every payout. There
 * was no code path anywhere that turned a provider's box score into a stat row,
 * so on a real deployment every player scored zero and every week finalised
 * 0–0, permanently, because a finalised week is never rescored.
 *
 * It is a separate module from `sync.ts` because it is a different kind of job.
 * The other syncs are idempotent overwrites of reference data — players, byes,
 * rankings, projections — and they upsert. This one writes to an **append-only,
 * versioned** table that a settled week has to stay auditable against, and the
 * rules for that are the whole of what follows.
 */

import type { StatLine } from "@rostr/core";
import type { ProviderBoxScore, StatsProvider } from "@rostr/stats";
import type { SqlClient } from "./client.js";
import { loadSportIds } from "./sports.js";
import { withTransaction } from "./transaction.js";

/**
 * How long after a game is first *observed* FINAL we keep re-reading it.
 *
 * 168 hours is the NFL's own stat-correction period. `payingFinalizationHours`
 * was derived from that fact, not the reverse — which is why this constant does
 * not consult a league's rules. Finalisation is per league, so "the week is
 * settled" is not a question this function can ask: a league with a longer
 * window simply sees no new revisions after this, and a league with a shorter
 * one finalises first and ignores a later revision, which is what a correction
 * window means.
 *
 * `final_at` is stamped when we first *observe* FINAL, so a sync outage delays
 * the window's start — in the conservative direction. We re-read for longer,
 * never shorter.
 */
export const CORRECTION_WINDOW_HOURS = 168;

/**
 * How often a FINAL game inside that window is re-read.
 *
 * **Halved in cadence when the post-final read became an invariant.** This used
 * to be six hours because the sweep was doing double duty: it was the corrections
 * poller *and* it was how a box score eventually reached a game whose only read
 * predated the whistle. The second job now belongs to the post-final clause
 * below, which fires within `FAILED_RETRY_MINUTES` of `final_at` being stamped,
 * so what is left here is polling a feed that publishes corrections in daily
 * batches. Fourteen reads across seven days is ample for that.
 *
 * The residual is the trailing edge — a correction arriving in the last hours
 * before a paying week finalises — and a cadence is a poor way to buy that,
 * because it is a poller that happens to be running rather than a read placed
 * where the corrections arrive. `CLOSING_READ_HOURS` buys it directly, at one
 * read per game instead of a uniform smear.
 */
export const FINAL_RECHECK_HOURS = 12;

/**
 * A single re-read in the closing hours of a game's correction window.
 *
 * The sweep above is uniform across seven days; this is not. A correction that
 * changes a *paid* result is the one that lands late, and `RULES.md` §7 gives
 * weeks 14 and 17 a 168h window precisely because official NFL stat corrections
 * arrive for up to a week. Without this, widening the sweep would leave a
 * twelve-hour blind spot immediately before the two weeks that decide money.
 *
 * **It needs no league rules and asks no question this file cannot answer.**
 * `CORRECTION_WINDOW_HOURS` is a constant here already, and the header above
 * records that `payingFinalizationHours` was derived *from* it rather than the
 * reverse — so a band measured against the game's own `final_at` is league-blind
 * by construction. It fires for every week and is merely redundant on the
 * fourteen that do not pay, which is the correct direction for a guard.
 *
 * Ceiling: exactly one read per game. The band is this wide, and the pacing
 * conditions are the same width, so a successful read inside it cannot repeat.
 */
export const CLOSING_READ_HOURS = 12;

/** How soon a game whose last read did not fully succeed is tried again. */
export const FAILED_RETRY_MINUTES = 20;

/**
 * How long after kickoff a game may still be treated as live.
 *
 * A runaway bound, and it has to stay one. The live clause below keys on
 * `kickoff_at` rather than on a status, so nothing external ends the window: if
 * the provider never tells us the game is over, this constant is the only thing
 * that does. `mapGameStatus` answers `SCHEDULED` for wording it does not
 * recognise, and `IN_PROGRESS` has never been observed from this provider at
 * all, so "the status will advance" is not something to rely on.
 *
 * **Eight was safe as a bound and ruinous as a budget**, which is the trap that
 * needed naming rather than trimming. While selection waited on the provider to
 * move a status, the window was almost never entered; keyed on the clock it is
 * entered by every game, every week, so its width became a steady-state
 * multiplier. Eight hours at one read per tick is 47 reads a game — fourteen
 * concurrent games on a Sunday, and the afternoon costs more than the day's
 * quota. What keeps it a ceiling is `LIVE_POLL_MINUTES`: the cost is
 * `window / interval`, not `window × cadence`.
 *
 * Five hours is still comfortably longer than any real game including overtime
 * and a weather delay — the longest NFL game on record is a little over five,
 * and this measures from kickoff rather than from the end of regulation. Past
 * it the game is picked up by the post-final clause the moment a whistle is
 * observed, and by the correction sweep regardless.
 */
export const LIVE_WINDOW_HOURS = 5;

/**
 * How long after kickoff the first box score is fetched.
 *
 * There is nothing to read at kickoff. An empty response costs a metered call
 * and then throws `translated to no stat lines` — so without this the first
 * tick of every game on every Sunday records a failure, `stats_error` is set on
 * a perfectly healthy game, and the retry clause starts pacing it as though
 * something were wrong.
 *
 * Twenty minutes puts the first read after the opening drive, when there is a
 * score to show.
 */
export const LIVE_START_MINUTES = 20;

/**
 * How often a game inside its live window is re-read.
 *
 * **The single largest lever in this file's call budget**, and the reason
 * `LIVE_WINDOW_HOURS` is still a bound rather than a multiplier. Unpaced, the
 * live clause fires on every tick: six reads an hour, times the window, times
 * every game on the slate. Paced, a game costs `window / interval` reads no
 * matter how the cron is scheduled.
 *
 * **It governs freshness, never correctness.** The whistle is observed in-band
 * — the box score carries the game's own status — and the post-final clause
 * then reads within `FAILED_RETRY_MINUTES`, so the settled score is right within
 * about twenty minutes of the game ending whatever this constant says. That is
 * what makes it a dial rather than a risk: `docs/LIVE-SCORING.md` calls the
 * fetch interval "a config value, not an architecture", and this is that value.
 *
 * Twenty gives roughly nine reads across a game. 180 would give strictly
 * per-game semantics — one read early, one after the whistle — at about a third
 * of the calls.
 */
export const LIVE_POLL_MINUTES = 20;

/**
 * The shortest a real NFL game can take, kickoff to final whistle.
 *
 * A guard on **stamping final**, not on reading. The box score reports its own
 * status and nobody here has ever seen what that field says while a game is
 * being played — every fixture in this repo is a completed game. If it turns out
 * to read "Completed" from the moment the row exists, an ungated stamp would set
 * `final_at` at kickoff, open the 168h correction window three hours early, and
 * settle the week on a first-quarter box score. Silently, and in the direction
 * of a wrong result rather than a late one.
 *
 * **Requiring a prior successful read does not close that**, which is worth
 * saying because it is the obvious fix: the second read is twenty minutes in,
 * so the window would still open two and a half hours early.
 *
 * This trusts no vendor string. Two and a half hours is `0003`'s own figure for
 * when the game watcher should start looking, and no NFL game has finished
 * faster. `provider_status` records what actually arrived either way, so if the
 * feed really does say "Completed" at kickoff we learn it from a column rather
 * than from a settled week.
 */
export const MIN_GAME_MINUTES = 150;

/**
 * How many games in a row may fail before a run gives up.
 *
 * The per-game catch below is right that one bad game must not stop the other
 * fifteen. What it has no answer for is fifteen failing in a row, which is one
 * provider outage rather than fifteen faults — and every call after the first
 * few is spend against a provider that has already answered.
 *
 * That matters more now that selection is clock-keyed. A slate the provider
 * cannot serve is fourteen games selected on every tick, at up to three HTTP
 * attempts each; unbroken, one bad Sunday afternoon exceeds the day's quota and
 * leaves nothing for the recovery.
 *
 * **Applied to the retry clause only.** A breaker that stopped every read would
 * be worse than the outage: it would keep a game from ever being read, which is
 * a permanent zero, which is the defect this whole file exists to prevent.
 *
 * Consecutive, and reset by any success, so a single unreadable game never costs
 * the slate a tick. The games that did fail are stamped, so the next run paces
 * past them and reaches the healthy ones.
 */
export const CONSECUTIVE_FAILURE_LIMIT = 4;

/**
 * How long after a week's last kickoff a missing box score still raises an alarm.
 *
 * **Shorter than the correction window on purpose, and the difference is what an
 * alarm is for.** The screen keeps reporting a game for the full 168 hours,
 * because a permanent zero is worth seeing. A heartbeat must not: an alarm's job
 * is to fire once and be acted on, and one latched red for seven days is a
 * status board wearing an alarm's colours. That is the failure this file's own
 * note about a permanently-true signal already records, twice.
 *
 * Flat, rather than 48/168 by week. A per-week split here would be a second copy
 * of the paying-week rule, and the weeks it would extend are the ones that get
 * roughly five hundred work-list ticks and seven daily syncs inside their window
 * — a game still unread at hour 48 has already raised this and been seen.
 * Re-raising it for five more days adds nothing and costs the channel its
 * credibility.
 */
export const ALARM_WINDOW_HOURS = 48;

/**
 * The most games one run will fetch.
 *
 * A bound on *spend*, not on work: the provider is metered and nothing else in
 * this query limits how many games it can select at once.
 *
 * **It is not one call per game, and this said it was.** Since #97 the client
 * retries a transient failure up to three times, so twenty games is a ceiling of
 * sixty calls when the provider is refusing — which is exactly when the quota is
 * the thing under pressure. The number here was chosen against the old
 * arithmetic and has not been re-derived; what has changed is that the sentence
 * no longer hides the multiplier from whoever re-derives it. A season backfill — `pnpm db:sync 2025`, which is a planned task —
 * puts every game of a played season inside the correction window at once,
 * because `final_at` is stamped when a game is first *observed* final rather
 * than when it was played. Without a ceiling the first run of that fetches
 * hundreds of box scores in a tight loop and exhausts the daily quota.
 *
 * Twenty is comfortably above a full NFL week, so a normal Sunday never touches
 * it, and the leftovers of an abnormal one are picked up on the next run ten
 * minutes later rather than being dropped.
 */
export const MAX_GAMES_PER_RUN = 20;

/*
 * How many refs carrying stat lines a game must hold before its join rate means
 * anything.
 *
 * **A floor on the denominator, never on the matched count.** A floor on matches
 * is circular — a wholly broken player map produces two matched refs, which is
 * below any floor, so the guard would abstain in precisely the case it exists
 * for.
 *
 * The size is derived rather than chosen. The threshold below is a quarter, so
 * its reciprocal is four: the floor has to exceed four times the largest number
 * of *innocent* unmatched scoring refs a game can hold, or one of them alone
 * trips it. Across the thirteen corpus games the worst is two, giving a floor of
 * eight; twelve carries half again on top of that and still sits below the
 * twenty a finished game carries, so no completed game is ever exempted.
 *
 * The gate is load-bearing and not a formality. A return touchdown is as likely
 * on the opening kickoff as in the fourth quarter, and the work list takes
 * IN_PROGRESS games — so a returner who cannot be rostered, plus the two D/ST
 * units, is one unmatched of three at 13:01 on a Sunday. That is 33% and
 * entirely healthy.
 */
export const MIN_SCORING_REFS_TO_JUDGE = 12;

/*
 * The share of stat-bearing refs that may fail to join before the read is
 * treated as unusable. Basis points, because this repo does not put a float
 * anywhere near a decision about scoring.
 *
 * **Measured, not picked.** Across the thirteen corpus games checked against the
 * live player table, 5 of 277 refs that produced a stat line failed to join —
 * 1.81%, worst game 2 of 22 — and every one was a defensive or special-teams
 * player credited with a return touchdown. Nobody can roster those, so they cost
 * no points. A stale map gives ~100%.
 *
 * 2500 is 2.75x the worst healthy game. The looser 3333 was considered and
 * rejected on a nameable break rather than a preference: losing the running
 * backs from the pool is 23-27% of a game's scoring refs, which 2500 catches and
 * 3333 does not.
 *
 * **The denominator is deliberately stat-bearing refs and not all refs.** Sixty
 * to seventy percent of a real box score never joins and never should: it
 * carries everyone who took a snap, and `players` holds the six positions a
 * fantasy roster can field. Over all refs the healthy rate is 67-71% and no
 * threshold in that band means anything.
 */
export const MAX_UNJOINED_SCORING_BPS = 2500;

/**
 * "Under way, by our own clock" — the predicate that replaced the status gate.
 *
 * A function rather than a string only because the two callers number their
 * bind parameters differently. It is deliberately **one** definition with more
 * than one consumer: the work list selects on it, and the stats job's heartbeat
 * counts on it to decide whether a Sunday went unread.
 *
 * That sharing is the point. An alarm that asks a different question than the
 * selection it guards can go quiet for a reason the selection does not have —
 * which is precisely how issue #256 survived: `runStatsJob` reported no problem
 * because no game *failed*, while the work list was selecting nothing at all.
 * Two copies of this predicate would rebuild that gap one layer up.
 *
 * Note it does not include pacing. Pacing is about how often we may re-read a
 * game; this is about whether the game is being played, and the heartbeat wants
 * the second question without the first.
 */
export function UNDER_WAY_SQL(startMinutesParam: string, windowHoursParam: string): string {
  return `g.kickoff_tbd = false
                AND g.status <> 'FINAL'
                AND g.kickoff_at <= now() - make_interval(mins  => ${startMinutesParam}::int)
                AND g.kickoff_at >  now() - make_interval(hours => ${windowHoursParam}::int)`;
}

/**
 * "No box score from after the whistle" — the core of `finalizationHold`'s hold.
 *
 * One definition, three consumers, and it was three hand-written copies before
 * this: the hold (`week.ts`), the work list's post-final clause above, and the
 * operator view. The post-final clause carries a comment forbidding exactly that
 * — *"two spellings of it would let a week hold on a game this query has no
 * reason to select"* — while being the second spelling. This is the last cheap
 * moment to close it.
 *
 * Each consumer ANDs its own gate on, because those genuinely differ: the hold
 * and the view want `status = 'FINAL'`, the work list wants a 168h bound and
 * pacing. The *question* does not differ, and that is what lives here.
 *
 * **A null `final_at` on a FINAL game means the provider called it final without
 * saying when.** There is nothing to compare against, so any sync counts and
 * this does not hold on it. That asymmetry is `week.ts`'s and it is deliberate;
 * inverting it would make every such game hold forever.
 *
 * ## The contract this rests on, which nobody had written down
 *
 * `stats_synced_at < final_at` is false on a healthy game **only because the
 * read that observes the whistle writes both columns in one transaction** —
 * `ingestOneGame`'s success `UPDATE` assigns `stats_synced_at = now()` and
 * `final_at = COALESCE(final_at, now())` together, and `now()` is transaction
 * time, so they are equal rather than ordered.
 *
 * Move either assignment out of that transaction — a repair script, a writer
 * that stamps the sync separately — and every healthy game in the league reads
 * as unread here. That holds a week that should settle, and it turns the whole
 * operator screen amber, which is the noise floor that stops a screen being
 * read at all.
 *
 * `box-scores.test.ts` pins it directly: after a clean final read, the two
 * stamps are equal. Strictly equal, with no tolerance — a window would let a
 * genuine failure a moment later read as success, which is the direction that
 * costs a settled week.
 */
export function UNREAD_SQL(alias = "g"): string {
  return `(${alias}.stats_synced_at IS NULL
            OR (${alias}.final_at IS NOT NULL
                AND ${alias}.stats_synced_at < ${alias}.final_at))`;
}

/**
 * How long a game whose whistle was observed by a *different* writer is given
 * before the operator screen calls it unread.
 *
 * **Nearly dead code, kept as defence in depth, and the reasoning matters more
 * than the number.** On the healthy path this state cannot arise at all: the
 * read that observes the whistle stamps the sync in the same transaction, so
 * the two are equal. It becomes reachable only when the *daily* schedule sync
 * stamps `final_at` on a game whose newest successful read was a live one —
 * which means the stats cron was down, the breaker deferred it, or every
 * post-final read failed. All three are hours stale by construction, so this
 * window delays nothing real.
 *
 * What it does suppress is the case where the contract in `UNREAD_SQL` has
 * broken. An arm whose safety rests on an unwritten invariant should not be the
 * thing that discovers the invariant moved, and forty minutes costs nothing to
 * an operator while covering two full retry cycles.
 */
export const STALE_GRACE_MINUTES = 40;

export interface BoxScoreSyncResult {
  readonly games: number;
  /** Stat lines seen for the first time — revision 0. */
  readonly inserted: number;
  /** Values that changed, written as a new revision. */
  readonly revised: number;
  /** Stats that vanished from a box score, zeroed by a new revision. */
  readonly retracted: number;
  /** Rows that matched what was stored and were deliberately not rewritten. */
  readonly unchanged: number;
  /** Named, not counted. A bare count once hid "every kicker in the league". */
  readonly unmatched: readonly string[];
  /**
   * Games that could not be ingested at all.
   *
   * The provider threw, the response translated to nothing, or the sport
   * registry and the provider map have diverged. Nothing was written for these.
   */
  readonly failures: readonly { readonly gameRef: string; readonly reason: string }[];
  /**
   * Games that **were** ingested, carrying something that did not reconcile.
   *
   * Separate from {@link failures}, and it was not: every warning the translator
   * raised was pushed onto that array, so the stats cron reported a game whose
   * ninety players all landed correctly as one that "failed to ingest". Both
   * directions of that are bad. A discrepancy read as a failure is a false alarm
   * on a healthy run, and — worse — it buries a real failure in the same count,
   * which is how a check stops being read at all.
   *
   * It matters more here than the mislabelling suggests. A week finalises after
   * 48 hours and is never rescored, so a warning nobody reads before then is a
   * permanently wrong score, and this is the only path by which a novel play
   * type or a renamed provider field becomes visible without somebody sweeping a
   * season by hand.
   */
  readonly warnings: readonly { readonly gameRef: string; readonly warning: string }[];
  /**
   * Games this run stopped short of, because the provider had failed
   * `CONSECUTIVE_FAILURE_LIMIT` times in a row.
   *
   * **Not a failure, and it must not be reported as one.** Nothing was attempted
   * for these and nothing was stamped, so the next run reaches them. A breaker
   * that read as a fault would turn a provider hiccup into a red heartbeat, and
   * a heartbeat that goes red for working behaviour stops being read — which is
   * the failure this whole change is about, one layer up.
   *
   * Named rather than counted, like {@link unmatched}: "four games deferred" and
   * "the whole 16:00 slate deferred" are different Sundays.
   */
  readonly deferred: readonly string[];
}

interface DueGame {
  readonly id: string;
  readonly external_ref: string;
  readonly kickoff_at: string;
  readonly season: number;
  readonly week: number;
  readonly home_team_ref: string;
  readonly away_team_ref: string;
}

/**
 * Read every box score that is due, and write what changed.
 *
 * ## Not scoped to "the current week", deliberately
 *
 * `currentWeek` is the week of the most recent kickoff, so on the Thursday of
 * week 6 it already reads 6 while week 5's correction window still has a day to
 * run. Scoping this to the current week reproduces exactly the bug
 * `resolveLeagueWeeksThrough` exists to fix — week 14 abandoned four days early
 * by week 15's Thursday game. The work list is driven by each game's own window
 * instead; `week` narrows it for tests and manual re-ingest only.
 *
 * ## Every write is conditional
 *
 * `stat_lines` is append-only and `stat_lines_current` takes the highest
 * revision per (player, season, week, stat_key, source). A re-run that sees the
 * same numbers must write **nothing**. Writing unconditionally would not make
 * any score wrong — the view still picks the newest — but at this cadence it
 * would bury the audit trail under thousands of identical rows, and nobody could
 * then tell "the NFL corrected this three times" from "the poller ticked". In
 * the seven days before a Week 14 payout, that column *is* the audit. So "has
 * this changed" is evaluated in the INSERT itself.
 *
 * ## A stat can also disappear
 *
 * An upsert cannot express a retraction, and the translator emits only non-zero
 * values while the provider omits an empty category. So a touchdown reassigned
 * from one player to another leaves the first player's row current and pays the
 * play twice. The second statement writes an explicit zero for any stat key
 * currently non-zero for a player this response *covered* and did not carry.
 */
export async function syncBoxScores(
  db: SqlClient,
  provider: StatsProvider,
  sportKey: string,
  season: number,
  week?: number,
): Promise<BoxScoreSyncResult> {
  const ids = await loadSportIds(db, sportKey);

  const due = await db.query<DueGame>(
    `SELECT g.id, g.external_ref, g.kickoff_at, g.season, g.week, g.home_team_ref, g.away_team_ref
       FROM games g
      WHERE g.sport_id = $1
        AND g.season = $2
        AND ($3::int IS NULL OR g.week = $3)
        -- POSTPONED and CANCELLED have no box score, and RULES.md section 10
        -- already scores those players 0 through the absence of a stat line.
        --
        -- **Stated explicitly now, because it used to be free.** It fell out of
        -- the old status IN ('IN_PROGRESS','FINAL') gate, and that gate is
        -- gone — so without this line the two statuses that genuinely never
        -- produce a box score would be fetched for as long as their clock
        -- allowed.
        AND g.status NOT IN ('POSTPONED', 'CANCELLED')
        -- **SCHEDULED is no longer excluded, and its exclusion was issue #256.**
        --
        -- games.status is written by syncGames and by nothing else, and
        -- syncGames runs from one cron at 09:20 UTC — 05:20 Eastern. The
        -- earliest kickoff in the synced season is 09:30 Eastern and the latest
        -- whistle is around 03:35 UTC, so there is no instant at which that job
        -- can observe a game in play: the column went SCHEDULED to FINAL,
        -- always, and this query therefore selected nothing at all while games
        -- were being played. Sunday's slate was first read on Monday morning,
        -- sixteen and a half hours after the first kickoff.
        --
        -- What replaces it is the clock. Whether a game has started is a fact we
        -- hold — kickoff_at is NOT NULL, written months ahead, and is what
        -- every lineup lock already keys on. Whether the provider has got round
        -- to saying so is a different question, and not one a box-score fetch
        -- should wait on.
        --
        -- This outer bound is what keeps stats_attempted_at IS NULL below
        -- finite: without it, every unplayed fixture of the season is selected
        -- on the first tick.
        --
        -- **The start offset lives here rather than only on the live clause**,
        -- and putting it there alone was wrong. "Never attempted" is an OR
        -- sibling that fires first, so a game five minutes into its first
        -- quarter was selected by it and read immediately -- which is the exact
        -- call the offset exists to prevent: nothing to translate, a metered
        -- call spent, a throw, and stats_error set on a perfectly healthy game.
        -- A test caught it; the clause alone did not.
        --
        -- A FINAL game is exempt because the offset is about whether there is
        -- anything to read yet, and a finished game has a complete box score
        -- however long ago it kicked off.
        AND (g.status = 'FINAL'
             OR (g.kickoff_at <= now() - make_interval(mins => $9::int)
                 AND g.kickoff_tbd = false))
        -- **Every clause here needs a ceiling.** This query is the main thing
        -- pacing a metered provider, so a clause that can stay true indefinitely
        -- is a call every ten minutes until the season ends.
        --
        -- It used to say "the only thing" and "the loop below has no delay in
        -- it". Neither survived #97: the client now sleeps between its own
        -- attempts, and one selection here can cost up to three calls.
        AND (
              -- Never *attempted*. Keyed on the attempt rather than the sync
              -- since #227: a game that failed has no sync time, and selecting
              -- on that would re-read it every tick — the hammering the retry
              -- clause below exists to prevent.
              g.stats_attempted_at IS NULL
           -- Live. This is the clause that makes live scoring exist, and the
           -- comment that used to sit here claimed it already did — "bounded by
           -- the clock rather than by the provider agreeing to move the status
           -- on" described the opposite of what the code did, since it selected
           -- on IN_PROGRESS, a value this provider has never once emitted.
           --
           -- Four bounds, and each closes a different runaway:
           --
           --   kickoff_tbd    the stored hour is the earliest the game *could*
           --                  start, not the hour it did. Eight fixtures across
           --                  weeks 16 and 17 carry it, because the NFL holds
           --                  those hours back for flex scheduling — so reading
           --                  the clock passing a stand-in as the game starting
           --                  polls a 20:20 game from 13:00 and stops forty
           --                  minutes into the real one, in the playoff and
           --                  championship weeks. Migration 0030 says this about
           --                  the column in its own words.
           --   status         once the whistle is observed the post-final clause
           --                  owns the game; without this a finished game keeps
           --                  paying for its live window.
           --   +LIVE_START    there is nothing to read at kickoff, and an empty
           --                  response costs a call and records a false failure.
           --   -LIVE_WINDOW   the runaway bound. Nothing external ends this
           --                  window, so it must end itself.
           --
           -- And paced, which is the difference between a bound and a budget.
           OR (${UNDER_WAY_SQL("$9", "$7")}
               AND (g.stats_attempted_at IS NULL
                    OR g.stats_attempted_at < now() - make_interval(mins => $10::int)))
           -- Read once more after the whistle, whoever stamped it.
           --
           -- This is finalizationHold's own unread predicate, deliberately:
           -- the thing that stops a week settling is the thing the producer must
           -- go and fetch, and two spellings of it would let a week hold on a
           -- game this query has no reason to select.
           --
           -- **It existed nowhere before, because it was not needed.** The first
           -- read of any game was necessarily *after* the whistle — nothing was
           -- fetched during play — so stats_synced_at < final_at was satisfied
           -- by accident. Reading live breaks that accident: the last live read
           -- predates final_at, and without this clause the week would hold on
           -- a game the sweep will not revisit for FINAL_RECHECK_HOURS. Reading
           -- during play would have made finalisation *worse* than not reading.
           --
           -- Self-extinguishing: one success puts the sync stamp past final_at.
           OR (g.final_at IS NOT NULL
               AND g.final_at > now() - make_interval(hours => $5::int)
               AND ${UNREAD_SQL("g")}
               AND (g.stats_attempted_at IS NULL
                    OR g.stats_attempted_at < now() - make_interval(mins => $4::int)))
           -- Retry. Bounded on **kickoff_at**, not final_at, and that is a fix
           -- rather than a tidy-up: final_at is nullable, and the state where
           -- it is null is exactly the state this clause is needed in. A game
           -- read cleanly at 19:50 whose provider then fails for the rest of the
           -- window has stats_error set and no final_at — so a bound of
           -- final_at > now() - 168h is NULL, false, and the sweep below is
           -- false for the same reason. Nothing selected that game again until
           -- the daily sync stamped final_at the next morning, leaving a
           -- thirteen-hour-old third-quarter box score as the week's numbers.
           --
           -- kickoff_at is NOT NULL and ours. Same 168h ceiling, shifted three
           -- hours earlier, and true in the state that matters.
           --
           -- The bound must stay: stats_error is set by ordinary *warnings* as
           -- well as failures — a field-goal count that disagrees with the plays
           -- parsed from it, a defence missing from the box score — so one game
           -- with a permanent discrepancy was re-read seventy-two times a day
           -- for the rest of the season, and sixteen of them would have exceeded
           -- the daily quota outright.
           OR (g.stats_error IS NOT NULL
               AND g.stats_attempted_at < now() - make_interval(mins => $4::int)
               AND g.kickoff_at > now() - make_interval(hours => $5::int))
           -- The NFL stat-correction sweep. Bounded on **both** columns, and the
           -- attempt bound is the load-bearing one.
           --
           -- It read only the sync time until this change, which was the one
           -- clause #227 left behind when it moved pacing onto the attempt. A
           -- game that had synced and then began failing kept its old sync
           -- stamp, so this predicate stayed true and re-selected it on every
           -- tick: six calls an hour for the rest of the 168h window, roughly a
           -- thousand for one game, against the quota the retry clause above
           -- exists to protect. The retry clause could not restrain it — it is
           -- an OR sibling, not a gate.
           OR (g.final_at > now() - make_interval(hours => $5::int)
               AND g.stats_synced_at < now() - make_interval(hours => $6::int)
               AND g.stats_attempted_at < now() - make_interval(hours => $6::int))
           -- One last look before the correction window closes.
           --
           -- The sweep above is a uniform smear across seven days. A correction
           -- that changes a *paid* result is not uniformly distributed — it is
           -- the one that lands late, which is why RULES.md section 7 gives
           -- weeks 14 and 17 a 168h window in the first place. A cadence buys
           -- that badly: it is a poller that happens to be running rather than a
           -- read placed where the corrections arrive.
           --
           -- Ceiling: exactly one read per game. The band is CLOSING_READ_HOURS
           -- wide and both pacing conditions are the same width, so a success
           -- inside it cannot repeat.
           OR (g.final_at > now() - make_interval(hours => $5::int)
               AND g.final_at < now() - make_interval(hours => $5::int - $11::int)
               AND g.stats_synced_at < now() - make_interval(hours => $11::int)
               AND g.stats_attempted_at < now() - make_interval(hours => $11::int))
        )
      -- Never-read first, then live, then **newest** first.
      --
      -- "Never read" is the honest column since #227: a failed game has no sync
      -- stamp, still has no stats, and still scores its players zero, so it
      -- belongs at the front with the untried ones rather than behind them.
      --
      -- But that promotion is what made the old kickoff_at ASC dangerous, and
      -- the comment above it — "plain kickoff order would let a backlog of old
      -- games starve today's" — became false at the moment it was written. A
      -- provider outage fails a whole slate at once; twenty minutes later those
      -- games sort into the front tier ahead of the live ones and, oldest-first,
      -- consume the whole LIMIT before the current afternoon is reached. Live
      -- scoring stops for every league while the newest failures are read last.
      --
      -- Newest-first inverts that. Within a tier the game closest to now is the
      -- one whose zero is about to be seen on a scoreboard or frozen by a
      -- finalisation; a week-old failure inside its correction window is real
      -- but not urgent, and it is still reached once the fresh work is done.
      --
      -- The second tier is money before screens, and it is new. A whistle that
      -- has already blown decides a settled score; a live read decides a screen.
      -- When a Sunday selects more than the LIMIT, the game whose absence would
      -- hold a week open goes first.
      --
      -- The tier it replaces read (g.status = 'IN_PROGRESS') DESC and sorted
      -- nothing whatsoever, because that value is never written — so a live game
      -- and a week-old correction re-read competed on kickoff order alone.
      ORDER BY (g.stats_synced_at IS NULL) DESC,
               (g.final_at IS NOT NULL
                AND (g.stats_synced_at IS NULL
                     OR g.stats_synced_at < g.final_at)) DESC,
               (${UNDER_WAY_SQL("$9", "$7")}) DESC,
               g.kickoff_at DESC
      LIMIT $8`,
    [
      ids.sportId,
      season,
      week ?? null,
      FAILED_RETRY_MINUTES,
      CORRECTION_WINDOW_HOURS,
      FINAL_RECHECK_HOURS,
      LIVE_WINDOW_HOURS,
      MAX_GAMES_PER_RUN,
      LIVE_START_MINUTES,
      LIVE_POLL_MINUTES,
      CLOSING_READ_HOURS,
    ],
  );

  // One query each, not one per player. Same reason as `syncProjections`: a row
  // at a time against a hosted database is thousands of round trips.
  const statKeyIds = new Map(
    (
      await db.query<{ id: string; key: string }>(
        "SELECT id, key FROM stat_keys WHERE sport_id = $1",
        [ids.sportId],
      )
    ).map((row) => [row.key, row.id]),
  );
  const playerRows = await db.query<{
    id: string;
    external_ref: string;
    position_id: string | null;
  }>(
    "SELECT id, external_ref, primary_position_id AS position_id FROM players WHERE sport_id = $1",
    [ids.sportId],
  );
  const playerIds = new Map(playerRows.map((row) => [row.external_ref, row.id]));

  /*
    **The pool is checked before a box score is fetched, not inferred from one.**

    This map is built once and serves the whole slate, so a hole in it is a
    property of the run rather than of any game. That makes it checkable here,
    for free, against our own database — and checking it here aborts before
    spending up to `MAX_GAMES_PER_RUN` metered calls on a run that can only
    produce garbage.

    The predicate is position **coverage**, not pool size. A size floor would be
    a sport-size assumption, and invariant 3 says sports are data and never
    structure. Every position the registry declares must have somebody behind it,
    which needs no threshold: it fires only at zero, and for a synced pool the
    smallest group is in the dozens.

    **It catches the failure the per-game ratio is structurally blind to.**
    Kickers are roughly two of twenty scoring refs, so losing every kicker in the
    league moves that ratio to about 9% — under every threshold, on every game,
    forever, while every kicker scores zero permanently. Because that damage is
    uniform across teams the standings look plausible too, so nothing downstream
    notices either. This file has paid for that lesson once already: a bare count
    of unmatched players once hid exactly that.

    Throwing is the established shape here rather than a new convention —
    `loadSportIds` above throws `SportNotSeededError` for the same class of
    whole-run precondition. `runStatsJob` wraps each season in its own catch, so
    other seasons still run and the heartbeat goes red.
  */
  const populated = new Set(playerRows.map((row) => row.position_id).filter(Boolean));
  const emptyPositions = [...ids.positionIds]
    .filter(([, positionId]) => !populated.has(positionId))
    .map(([key]) => key)
    .sort();
  if (emptyPositions.length > 0) {
    throw new Error(
      `The player pool has no ${emptyPositions.join(", ")} for ${sportKey}. ` +
        `Every box score would score those positions zero, so no game was read. ` +
        `Run the players sync before retrying.`,
    );
  }

  let inserted = 0;
  let revised = 0;
  let retracted = 0;
  let unchanged = 0;
  const unmatched: string[] = [];
  const failures: { gameRef: string; reason: string }[] = [];
  const warnings: { gameRef: string; warning: string }[] = [];

  const deferred: string[] = [];
  let consecutiveFailures = 0;

  for (const game of due) {
    /*
      **A run stops when the provider is refusing; it does not stop for one bad
      game.** The catch below is right that one failure must not cost the other
      fifteen their read. What it has no answer for is fifteen failing in a row,
      which is one outage rather than fifteen faults — and every call after the
      first few is spend against a provider that has already answered.

      That matters more now that selection is clock-keyed. A slate the provider
      cannot serve is fourteen games selected on every tick at up to three HTTP
      attempts each; unbroken, one bad afternoon exceeds the day's quota and
      leaves nothing for the recovery. Broken, a run costs at most four games.

      Deferred, not failed. These games are **not** stamped: we did not attempt
      them, and `stats_attempted_at` means what 0042's comment says it means. So
      the next tick reaches them once the games that did fail are paced out, and
      four permanently-unreadable games cost the slate one tick rather than
      blocking it.
    */
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      deferred.push(game.external_ref);
      continue;
    }
    try {
      const box = await provider.getBoxScore(game.external_ref);
      const outcome = await ingestOneGame(db, provider.name, game, box, statKeyIds, playerIds);

      inserted += outcome.inserted;
      revised += outcome.revised;
      retracted += outcome.retracted;
      unchanged += outcome.unchanged;
      unmatched.push(...outcome.unmatched);
      // One entry per warning rather than one joined string per game, so a
      // caller can count them and a reader can see them. The joined form still
      // goes to `games.stats_error`, which is a column and wants one value.
      for (const warning of outcome.warnings) {
        warnings.push({ gameRef: game.external_ref, warning });
      }

      // Reset on any success: the breaker is about a provider that has stopped
      // answering, not about a running total of bad games.
      consecutiveFailures = 0;
    } catch (error) {
      // **One game's failure never stops the other fifteen.** The shape every
      // cron loop in this repo uses — and note the unit here is a *game*, not a
      // league, because one box score is scored against every league at once. A
      // game that fails to ingest zeroes its players everywhere, not in one
      // place.
      //
      // Recorded, never swallowed: the attempt is stamped so the retry is paced,
      // and the reason is stored so a game that can never be read does not look
      // healthy forever while the week finalises around it.
      const reason = error instanceof Error ? error.message : String(error);
      // **The attempt, not the sync.** #227: stamping `stats_synced_at` here made
      // a game that could not be read indistinguishable from one that was, so
      // #140's hold — which reads that column as "has a box score" — let the week
      // finalise with those players at zero. The attempt is what paces the retry
      // and it is recorded; the sync is not, because none happened.
      await db.query(
        "UPDATE games SET stats_attempted_at = now(), stats_error = $2 WHERE id = $1",
        [game.id, reason],
      );
      failures.push({ gameRef: game.external_ref, reason });
      consecutiveFailures++;
    }
  }

  return {
    // Selected, not necessarily read — see `deferred`.
    games: due.length,
    deferred,
    inserted,
    revised,
    retracted,
    unchanged,
    unmatched,
    failures,
    warnings,
  };
}

/**
 * How many of this season's games are being played right now.
 *
 * **The check that would have caught issue #256, and the one that catches the
 * next version of it.** `runStatsJob` computed its health from failed seasons
 * and failed games alone, so a Sunday on which the work list matched *nothing*
 * recorded `last_outcome = null` and `pnpm cron:status` read green — through the
 * entire failure, every ten minutes, for as long as it lasted. A run over zero
 * games genuinely is healthy on a Tuesday in June; what nothing could tell was
 * the difference between that and a slate the pipeline never looked at.
 *
 * Two properties make it a usable signal rather than a permanent alarm:
 *
 * - It asks **the same question the work list asks** — literally the same SQL
 *   fragment, not a second copy of it. An alarm that can drift from the
 *   selection it guards is one that can go quiet for a reason the selection does
 *   not have, which is the shape of the bug it exists to catch.
 * - It is **self-limiting**. `UNDER_WAY_SQL` is bounded at both ends of
 *   `kickoff_at`, so this can only be non-zero while games are actually being
 *   played. It cannot become permanently true the way an unbounded backlog count
 *   does — a mistake this repo has already paid for twice, in `season-sync`'s
 *   undated fixtures and in `outstanding.total`.
 *
 * Deliberately no pacing condition. Pacing is about how often a game may be
 * re-read; this is about whether one is being played. A job that read every live
 * game five minutes ago is healthy, and would report zero if this asked the
 * narrower question.
 */
export async function gamesUnderWay(
  db: SqlClient,
  sportKey: string,
  season: number,
): Promise<number> {
  const ids = await loadSportIds(db, sportKey);
  const [row] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM games g
      WHERE g.sport_id = $1
        AND g.season = $2
        AND g.status NOT IN ('POSTPONED', 'CANCELLED')
        AND ${UNDER_WAY_SQL("$3", "$4")}`,
    [ids.sportId, season, LIVE_START_MINUTES, LIVE_WINDOW_HOURS],
  );
  return row?.n ?? 0;
}

/**
 * Every ingest state worth an operator's attention, with what it costs.
 *
 * **The screen this feeds could not tell "no stats at all" from "ingested with a
 * warning".** Both rendered identically, because the only thing selected on was
 * `stats_error IS NOT NULL` — a column set by ordinary warnings as much as by
 * failures. A field-goal count disagreeing with itself and a game whose every
 * player scores zero looked the same, and the page said in its own prose that
 * every row had been ingested and scored. Issue #233.
 *
 * ## Three states, because the operator has three responses
 *
 * `NO_STATS`     — nothing usable was written. Every player in this game scores
 *                  zero, in every league, and once the week finalises that is
 *                  permanent.
 * `STALE`        — stats exist from an earlier read and the latest read failed,
 *                  so the scoreboard is older than the game.
 * `DISCREPANCY`  — ingested, latest read succeeded, a translator check
 *                  disagreed. The routine one, roughly one game in seven.
 *
 * The severity is computed **once, here in SQL**, and drives both the label and
 * the `ORDER BY` tier. Two spellings would let a row sort into one bucket and
 * wear another, which is issue #233's own defect one layer up.
 *
 * ## A played game with no stats is found by the clock, not by an error
 *
 * The first arm keys on `kickoff_at` rather than on an error or a status, and
 * that is the lesson of #256 applied one layer up. A game starved by
 * `MAX_GAMES_PER_RUN` on a fourteen-game slate, or skipped by the consecutive
 * failure breaker — which deliberately stamps nothing, because it did not
 * attempt them — carries **no error, no sync stamp, and whatever status the
 * daily sync last wrote**. That is exactly the class this screen exists for, and
 * every predicate keyed on `stats_error` misses it until the next morning.
 *
 * ## What it deliberately does not report
 *
 * A **discrepancy on a game still being played** is a partial box score
 * disagreeing with itself, which is not a defect. The translator's warnings are
 * ungated, so without the suppression below a slate's worth of transient noise
 * lands here every Sunday — and a page that is amber every Sunday is a page
 * nobody opens. `STALE` is *not* suppressed while live: that is the state in
 * which the scoreboard is showing managers numbers that will never move.
 *
 * ## Two counts, because a screen and an alarm want different things
 *
 * `total` is unbounded, as it always was — a game past its correction window can
 * never be re-read, so its problem is permanent and worth keeping visible.
 * `blockingRecent` is bounded to the window in which somebody could still change
 * the outcome, and it is the only one fit to reach a heartbeat. A count that
 * only ever grows is a permanently-true health signal, which this repo has
 * already paid for twice.
 */
export type IngestState = "NO_STATS" | "STALE" | "DISCREPANCY";

export async function unresolvedStatsProblems(
  db: SqlClient,
  sportKey: string,
  limit = 20,
): Promise<{
  /** Everything flagged, however old. The screen's number. */
  readonly total: number;
  /**
   * Games with no usable box score whose week can still be corrected.
   *
   * The alarm's number, and the only one of the two that can fall to zero.
   * Bounded at `ALARM_WINDOW_HOURS` from the week's last kickoff rather than at
   * the full correction window: an alarm's job is to fire once and be acted on,
   * and one latched red for seven days is a status board wearing an alarm's
   * colours.
   */
  readonly blockingRecent: number;
  readonly games: readonly {
    readonly gameRef: string;
    readonly season: number;
    readonly week: number;
    readonly ingest: IngestState;
    /**
     * The provider's complaint, when there is one.
     *
     * **Nullable, which it was not before.** A game selected by the clock rather
     * than by an error carries nothing here, and a caller that assumes a string
     * renders an empty card — which is how the state this screen was fixed to
     * show would stay invisible after all of it.
     */
    readonly problem: string | null;
    readonly kickoffAt: Date;
    readonly finalAt: Date | null;
    readonly syncedAt: Date | null;
    readonly isFinal: boolean;
    /**
     * The last kickoff of this game's week — the instant `finalizationHold`
     * measures its correction window from.
     *
     * Carried because the screen measured from the game's own `final_at` and the
     * hold measures from here, so the two disagreed by about 28 hours on an
     * early Sunday game: the screen reported a week uncorrectable while it was
     * still fully correctable. A schedule fact, not a league rule, so carrying
     * it keeps this function league-blind exactly as it was.
     */
    readonly weekLastKickoff: Date;
  }[];
}> {
  const ids = await loadSportIds(db, sportKey);

  /*
    Passed as an instant rather than as an hour count, because the bound sits
    inside an aggregate FILTER and Postgres declines to infer a parameter's type
    there even through an explicit cast. Clock skew between this process and the
    database is irrelevant against a 48-hour window.
  */
  const alarmSince = new Date(Date.now() - ALARM_WINDOW_HOURS * 3_600_000).toISOString();

  /*
    The selection, written once and used by both queries.

    `status NOT IN (...)` first: a postponed or cancelled game never produces a
    box score, RULES.md section 10 already scores its players zero, and without
    this the first arm would report every one of them forever.
  */
  const selection = `
        g.sport_id = $1
    AND g.status NOT IN ('POSTPONED', 'CANCELLED')
    AND (
          -- Played by our own clock, and nothing written.
          (g.stats_synced_at IS NULL
           AND g.kickoff_tbd = false
           AND g.kickoff_at < now() - ($2::int * interval '1 minute'))
          -- Read, but not after the whistle. See STALE_GRACE_MINUTES.
       OR (g.status = 'FINAL'
           AND ${UNREAD_SQL("g")}
           AND g.final_at < now() - ($3::int * interval '1 minute'))
          -- Flagged, and settled enough to judge.
       OR (g.stats_error IS NOT NULL
           AND (g.status = 'FINAL'
                OR g.kickoff_at < now() - ($4::int * interval '1 hour')))
        )`;

  /*
    Order matters and the first two arms are not interchangeable.

    NO_STATS is claimed by "nothing written" *before* the unread test, because a
    game with no sync stamp at all has no `final_at` to compare against and would
    otherwise fall through to DISCREPANCY — which is the calmest tier, for the
    worst state. That is issue #233's own shape.
  */
  const severity = `
        CASE
          WHEN g.stats_synced_at IS NULL THEN 'NO_STATS'
          WHEN g.status = 'FINAL' AND ${UNREAD_SQL("g")} THEN 'NO_STATS'
          WHEN g.stats_attempted_at > g.stats_synced_at THEN 'STALE'
          ELSE 'DISCREPANCY'
        END`;

  /*
    The week's last kickoff, as a join rather than a window function.

    A window function evaluates **after** WHERE, so `max(kickoff_at) OVER
    (PARTITION BY season, week)` would see only the rows that survived the
    filter and return the last *flagged* kickoff. On a week where only the
    Thursday game is flagged that lands almost five days early, and in the
    dangerous direction: the screen would report a week closed to corrections
    while it was still fully open. Measured, not reasoned.
  */
  const weekEnd = `
      JOIN (SELECT season, week, max(kickoff_at) AS week_last_kickoff
              FROM games
             WHERE sport_id = $1
             GROUP BY season, week) w
        ON w.season = g.season AND w.week = g.week`;

  const [counted] = await db.query<{ total: string; blocking_recent: string }>(
    `WITH flagged AS (
       SELECT ${severity} AS severity,
              -- Evaluated here rather than in the FILTER below: Postgres will
              -- not infer a parameter's type inside an aggregate FILTER, even
              -- through an explicit cast.
              (w.week_last_kickoff > $5::timestamptz) AS recent
         FROM games g ${weekEnd}
        WHERE ${selection}
     )
     SELECT count(*)::text AS total,
            count(*) FILTER (
              WHERE severity IN ('NO_STATS', 'STALE') AND recent
            )::text AS blocking_recent
       FROM flagged`,
    [ids.sportId, MIN_GAME_MINUTES, STALE_GRACE_MINUTES, LIVE_WINDOW_HOURS, alarmSince],
  );

  const games = await db.query<{
    external_ref: string;
    season: number;
    week: number;
    ingest: IngestState;
    stats_error: string | null;
    kickoff_at: Date;
    final_at: Date | null;
    stats_synced_at: Date | null;
    is_final: boolean;
    week_last_kickoff: Date;
  }>(
    `SELECT g.external_ref, g.season, g.week, g.stats_error, g.kickoff_at,
            g.final_at, g.stats_synced_at,
            (g.status = 'FINAL') AS is_final,
            w.week_last_kickoff,
            ${severity} AS ingest
       FROM games g ${weekEnd}
      WHERE ${selection}
      -- Severity before recency, and before the LIMIT.
      --
      -- This used to be kickoff_at DESC alone, which meant a page of routine
      -- warnings from last week pushed the one game whose players all score
      -- zero off the end of the list. The same argument the work list already
      -- makes for its own tiers: under truncation, the row that decides money
      -- goes first.
      ORDER BY CASE ${severity}
                 WHEN 'NO_STATS' THEN 0
                 WHEN 'STALE' THEN 1
                 ELSE 2
               END,
               g.kickoff_at DESC
      LIMIT $5`,
    [ids.sportId, MIN_GAME_MINUTES, STALE_GRACE_MINUTES, LIVE_WINDOW_HOURS, limit],
  );

  return {
    total: Number(counted?.total ?? 0),
    blockingRecent: Number(counted?.blocking_recent ?? 0),
    games: games.map((row) => ({
      gameRef: row.external_ref,
      season: Number(row.season),
      week: Number(row.week),
      ingest: row.ingest,
      problem: row.stats_error,
      kickoffAt: new Date(row.kickoff_at),
      finalAt: row.final_at === null ? null : new Date(row.final_at),
      syncedAt: row.stats_synced_at === null ? null : new Date(row.stats_synced_at),
      isFinal: row.is_final,
      weekLastKickoff: new Date(row.week_last_kickoff),
    })),
  };
}

interface GameOutcome {
  readonly inserted: number;
  readonly revised: number;
  readonly retracted: number;
  readonly unchanged: number;
  readonly unmatched: string[];
  /**
   * Everything about this game that did not reconcile.
   *
   * The game was still ingested — that is the whole of the `fatal`/`warnings`
   * split the translator makes, and it is why these are not failures. They are
   * joined into `games.stats_error`, which is what paces the re-read.
   */
  readonly warnings: string[];
}

async function ingestOneGame(
  db: SqlClient,
  source: string,
  game: DueGame,
  box: ProviderBoxScore,
  statKeyIds: ReadonlyMap<string, string>,
  playerIds: ReadonlyMap<string, string>,
): Promise<GameOutcome> {
  // **Season and week come from the game row, never from the box score.** A
  // provider handed only a game reference cannot know them and returns 0 for
  // both; trusting those would write every row into a (0, 0) coordinate that
  // nothing ever reads, and every matchup would score zero with no error.
  const season = Number(game.season);
  const week = Number(game.week);

  const unmatched: string[] = [];
  const problems: string[] = [...box.warnings];

  // The `def_pts_allowed` obligation, asserted here because this is the last
  // layer that knows a unit *played* — the translator is not told which teams
  // are in the game. A unit missing it is skipped rather than half-written: a
  // partial D/ST scores wrongly and looks right, because points allowed is the
  // only tiered rule in the sport and absent is not zero.
  //
  // The *game* is not discarded over it. The player lines are still written and
  // `stats_error` is left set, so it is re-read shortly.
  /*
    Is this read of a genuinely finished game?

    Two conditions, and the second trusts no vendor string. The provider says so
    — the box score carries its own `gameStatus` — and the clock agrees that
    enough time has passed for a game to have been played.

    The clock half exists because **nobody has ever fetched a mid-game box score
    from this provider.** Every fixture in this repo is a completed game, so if
    `gameStatus` turns out to read "Completed" from the moment the row exists, an
    unguarded stamp would set `final_at` at kickoff, open the 168h correction
    window three hours early, and settle the week on a first-quarter box score.
    Silently, and toward a wrong result rather than a late one.

    Requiring a *previous* successful read does not close that — the second read
    is twenty minutes in — which is why the guard is the clock. See
    `MIN_GAME_MINUTES`.
  */
  const kickedOffMinutesAgo = (Date.now() - new Date(game.kickoff_at).getTime()) / 60_000;
  const finishedGame = box.status === "FINAL" && kickedOffMinutesAgo >= MIN_GAME_MINUTES;

  const usable = new Map<string, readonly StatLine[]>();
  for (const [ref, lines] of box.players) {
    /*
      **A team defense is written only from a finished game.**

      Both of the sport's tiered ladders top out at zero — `def_pts_allowed` at 0
      pays 5, and `def_yds_allowed` at 0-99 pays 5 — so a first-quarter read does
      not report a defense that has conceded nothing *yet*. It reports a shutout,
      worth ten points before a single sack, for every unit in every game, and
      then counts down all afternoon as real yards land.

      `scorePlayer` treats absent as nothing and an explicit zero as the top
      rung, which is exactly the distinction the guard below already draws for a
      unit missing its points-allowed line. This is the same argument one step
      earlier: a partial D/ST scores wrongly and looks right.

      The unit's countable events — sacks, interceptions, defensive touchdowns —
      are withheld with it rather than written alone, because they arrive on the
      same ref and splitting the line would leave a half-written unit, which is
      the state this whole block exists to prevent. Everything lands within
      `FAILED_RETRY_MINUTES` of the whistle, via the post-final clause.

      Understated is the safe direction here. Overstated is not.
    */
    if (ref.startsWith("DST_") && !finishedGame) continue;
    if (ref.startsWith("DST_") && !lines.some((line) => line.statKey === "def_pts_allowed")) {
      problems.push(`${ref} has no def_pts_allowed and was not written`);
      continue;
    }
    usable.set(ref, lines);
  }
  /*
    Only meaningful for a finished game, and that gating is load-bearing rather
    than tidy. Left ungated, every live read of every game would push two
    warnings, `stats_error` would be set on a perfectly healthy Sunday, and the
    retry clause would then pace the game at three reads an hour on top of the
    live clause — for the whole afternoon, every week.
  */
  if (finishedGame) {
    for (const abv of [game.home_team_ref, game.away_team_ref]) {
      if (!usable.has(`DST_${abv}`)) problems.push(`DST_${abv} is missing from the box score`);
    }
  }

  const covered: string[] = [];
  const rowPlayer: string[] = [];
  const rowStatKey: string[] = [];
  const rowValue: number[] = [];

  /*
    Two tallies, and only one of them is evidence.

    A ref carrying no stat line and no `players` row costs nothing: it writes
    nothing and covers nothing. A ref carrying lines is a score that went
    somewhere and did not arrive. The guard below counts only the second.
  */
  let scoringRefs = 0;
  const unmatchedScoring: string[] = [];

  for (const [ref, lines] of usable) {
    const scoring = lines.length > 0;
    if (scoring) scoringRefs++;

    const playerId = playerIds.get(ref);
    if (!playerId) {
      unmatched.push(ref);
      if (scoring) unmatchedScoring.push(ref);
      continue;
    }

    // Covered even with no lines. Most players in a real box score have none of
    // the stats we score; they are still *covered*, so a stat that used to be
    // there and is not any more is retractable. They simply write nothing.
    covered.push(playerId);

    for (const line of lines) {
      const statKeyId = statKeyIds.get(line.statKey);
      if (!statKeyId) {
        // Throws, and the per-game catch records it. The sport registry and the
        // provider map having diverged should fail loudly on every game rather
        // than quietly dropping a stat everybody is scored on.
        throw new Error(
          `Box score references unknown stat key "${line.statKey}". ` +
            `The sport registry and the provider map have diverged.`,
        );
      }
      rowPlayer.push(playerId);
      rowStatKey.push(statKeyId);
      rowValue.push(line.value);
    }
  }

  // A response carrying nothing at all is not a game in which nothing happened.
  // Retracting against it would zero the week.
  if (rowValue.length === 0) {
    throw new Error(`Box score ${game.external_ref} translated to no stat lines`);
  }

  /*
    The same guard as the one above with its threshold raised off zero. Issue
    #232.

    That one asks whether *anything* joined; this asks whether the players who
    **scored** joined. The gap between them was the whole defect: two synthesised
    `DST_<abv>` refs match thirty-two stable rows and carry a `def_pts_allowed`
    written even at nought, so they clear the empty check on their own while
    every skill player in the game fails to join. The read then recorded itself
    as a clean success.

    **Throwing rather than recording a warning is the load-bearing choice**, and
    the reason is one column. A warning reaches `stats_error`, and the statement
    that writes it also stamps `stats_synced_at` — which is what the week's
    finalisation hold reads, not `stats_error`. So a flagged game would still
    claim to have synced, the week would still settle at zero, and the flag would
    sit on a page nobody was watching. The per-game catch already withholds that
    stamp, sets the error, records a failure and writes nothing, which is all
    four things this needs; it also sits above the transaction, so `failures`'
    promise that nothing was written stays literally true.

    **Writing the joined rows and withholding the stamp was considered and
    rejected.** Those rows are right-and-incomplete rather than wrong, and in
    every branch where the pool is repaired inside the window the two designs end
    byte-identical — there are roughly a hundred and forty retries in a
    forty-eight hour window. They differ only where the pool stays broken *and*
    nobody reads a red heartbeat for two days. There, a partial week settles at
    around forty percent of normal scoring with each team penalised in proportion
    to how many of its own starters were missing from our table, which is a
    permanent win-loss record distributed by an artifact of our database — and
    biased, because the players missing are disproportionately rookies and recent
    signings. All-zero settles as ties, which is uniform, obvious on the
    scoreboard, and already what `RULES.md` §10 prescribes for a game whose stats
    never arrive. There is no rule anywhere for a game we half-read.

    This does not prevent the bad outcome. It delays it and makes it loud: the
    hold is bounded, and past the correction window the week finalises regardless
    with the reason named. That is the correct ceiling — a week that can never
    settle is worse than the defect being fixed.
  */
  if (
    scoringRefs >= MIN_SCORING_REFS_TO_JUDGE &&
    unmatchedScoring.length * 10_000 > scoringRefs * MAX_UNJOINED_SCORING_BPS
  ) {
    // Named, not counted — the idiom this file already uses for `unmatched`, and
    // for the reason recorded there: a bare count once hid every kicker in the
    // league. The scoring list is five names across thirteen real games, so it
    // is short enough to print.
    const named = unmatchedScoring.slice(0, 8).join(", ");
    throw new Error(
      `Box score ${game.external_ref}: ${unmatchedScoring.length} of ${scoringRefs} ` +
        `players carrying stats did not match the player pool ` +
        `(${named}${unmatchedScoring.length > 8 ? ", …" : ""}). ` +
        `The pool is stale, or the provider changed its refs.`,
    );
  }

  const ptsAllowedId = statKeyIds.get("def_pts_allowed") ?? null;

  return withTransaction(db, async (tx) => {
    // The draft's idiom. Two overlapping runs would otherwise both read
    // `revision = 3` and both insert 4; the unique constraint catches that, but
    // the lock means it does not have to.
    await tx.query("SELECT id FROM games WHERE id = $1 FOR UPDATE", [game.id]);

    // Three arrays and three scalars — **six bind parameters however many rows**,
    // so the 65535 parameter cap `syncProjections` chunks around is structurally
    // unreachable here rather than avoided by arithmetic.
    const written = await tx.query<{ fresh: boolean }>(
      `WITH incoming (player_id, stat_key_id, value) AS (
         SELECT * FROM unnest($4::uuid[], $5::uuid[], $6::integer[])
       ),
       cur AS (
         SELECT c.player_id, c.stat_key_id, c.value, c.revision
           FROM stat_lines_current c
          WHERE c.season = $1 AND c.week = $2 AND c.source = $3
            AND c.player_id = ANY($4::uuid[])
       )
       INSERT INTO stat_lines
              (player_id, season, week, stat_key_id, value, source, revision)
       SELECT i.player_id, $1, $2, i.stat_key_id, i.value, $3,
              COALESCE(c.revision + 1, 0)
         FROM incoming i
         LEFT JOIN cur c
           ON c.player_id = i.player_id AND c.stat_key_id = i.stat_key_id
        WHERE c.player_id IS NULL OR c.value IS DISTINCT FROM i.value
       RETURNING (revision = 0) AS fresh`,
      [season, week, source, rowPlayer, rowStatKey, rowValue],
    );

    // The mirror. Scoped to players this response *covered* — a player absent
    // from the box score is never retracted, which is what stops a truncated
    // response from wiping a game.
    //
    // `def_pts_allowed` is excluded by key, and that exclusion is the most
    // important line in this file: a retraction writes 0, and 0 for that key is
    // not "no data", it is a **shutout** — the top tier of the only tiered rule
    // in the sport, worth ten points. A genuine correction to it still lands,
    // because a value that is present goes through the upsert above.
    const zeroed = await tx.query<{ id: string }>(
      `INSERT INTO stat_lines
              (player_id, season, week, stat_key_id, value, source, revision)
       SELECT c.player_id, $1, $2, c.stat_key_id, 0, $3, c.revision + 1
         FROM stat_lines_current c
        WHERE c.season = $1 AND c.week = $2 AND c.source = $3
          AND c.player_id = ANY($4::uuid[])
          AND c.value <> 0
          AND ($7::uuid IS NULL OR c.stat_key_id <> $7)
          AND NOT EXISTS (
                SELECT 1 FROM unnest($5::uuid[], $6::uuid[]) AS i(player_id, stat_key_id)
                 WHERE i.player_id = c.player_id AND i.stat_key_id = c.stat_key_id)
       RETURNING id`,
      [season, week, source, covered, rowPlayer, rowStatKey, ptsAllowedId],
    );

    // Joined into one column, and still called `stats_error` because that is
    // what `0027` named it and what the work-list query above reads to pace a
    // re-read. The column's own comment says it is set by warnings too. What the
    // *caller* is handed is the list, unjoined — see `GameOutcome.warnings`.
    const problem = problems.length > 0 ? problems.join("; ") : null;
    /*
      Both stamps on the success path — the attempt column paces the retry and
      must not lose its pacing just because the read worked.

      And the game's own status, which is the second half of issue #256's fix.
      Until now `games.status` had exactly one writer, `syncGames`, on a daily
      cron; the box score has been carrying the answer all along and it was
      discarded at the adapter. Writing it here is what makes the scoreboard stop
      calling a finished game "playing" for seventeen hours, and what lets
      `finalizationHold` see a whistle within ten minutes instead of overnight.

      Three properties, each of which has a way to go wrong:

      - **Only a successful read writes it.** The failure path below stamps the
        attempt and the error and leaves status alone: a game we could not read
        is not a game we know anything new about.
      - **`finishedGame`, not `box.status`.** The clock guard is included, so a
        provider that reports "Completed" from kickoff cannot open the correction
        window early. See where it is computed.
      - **`final_at` is COALESCEd**, so a later read cannot restart the 168h
        window. `syncGames` has always done the same; a second writer must not be
        the one that breaks it.

      `provider_status` is recorded on every successful read, final or not,
      because the mid-game wording is the thing nobody has ever seen.
    */
    await tx.query(
      `UPDATE games
          SET stats_synced_at = now(),
              stats_attempted_at = now(),
              stats_error = $2,
              provider_status = $4,
              provider_status_code = $5,
              status = CASE WHEN $3 THEN 'FINAL' ELSE status END,
              final_at = CASE WHEN $3 THEN COALESCE(final_at, now()) ELSE final_at END
        WHERE id = $1`,
      [game.id, problem, finishedGame, box.providerStatus, box.providerStatusCode],
    );

    let inserted = 0;
    let revised = 0;
    for (const row of written) {
      if (row.fresh) inserted++;
      else revised++;
    }

    return {
      inserted,
      revised,
      retracted: zeroed.length,
      unchanged: rowValue.length - written.length,
      unmatched,
      warnings: problems,
    };
  });
}
