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

/** How often a FINAL game inside that window is re-read. */
export const FINAL_RECHECK_HOURS = 6;

/** How soon a game whose last read did not fully succeed is tried again. */
export const FAILED_RETRY_MINUTES = 20;

/**
 * How long after kickoff a game may still be treated as live.
 *
 * An in-progress game is re-read on **every** run, which is the point — that is
 * what live scoring is. What it must not do is run forever. A game whose status
 * never advances past `IN_PROGRESS` would otherwise be fetched every ten minutes
 * for the rest of the season, and that is not hypothetical: `mapGameStatus`
 * answers `SCHEDULED` for wording it does not recognise, the three endpoints
 * disagree about how they spell a finished game, and only two of the five
 * statuses have ever been observed live.
 *
 * Eight hours is roughly two and a half times a real game, so it cannot end a
 * game that is genuinely being played — including overtime and a weather delay
 * — and it bounds the runaway at one afternoon instead of one season. Past it
 * the game is still re-read by the correction sweep below, just on a six-hour
 * cadence rather than a ten-minute one.
 */
export const LIVE_WINDOW_HOURS = 8;

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
}

interface DueGame {
  readonly id: string;
  readonly external_ref: string;
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
    `SELECT g.id, g.external_ref, g.season, g.week, g.home_team_ref, g.away_team_ref
       FROM games g
      WHERE g.sport_id = $1
        AND g.season = $2
        AND ($3::int IS NULL OR g.week = $3)
        -- A SCHEDULED game has no box score. POSTPONED and CANCELLED have none
        -- either, and RULES.md section 10 already scores those players 0 through
        -- the absence of a stat line.
        AND g.status IN ('IN_PROGRESS', 'FINAL')
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
           -- Live, and bounded by the clock rather than by the provider
           -- agreeing to move the status on.
           OR (g.status = 'IN_PROGRESS'
               AND g.kickoff_at > now() - make_interval(hours => $7::int))
           -- Retry, bounded by the same window as the sweep below. Without the
           -- final_at bound this never expired: stats_error is set by
           -- ordinary *warnings* as well as failures — a field-goal count that
           -- disagrees with the plays parsed from it, a defence missing from the
           -- box score — so one game with a permanent discrepancy was re-read
           -- seventy-two times a day for the rest of the season, and sixteen of
           -- them would have exceeded the daily quota outright.
           OR (g.stats_error IS NOT NULL
               AND g.stats_attempted_at < now() - make_interval(mins => $4::int)
               AND g.final_at > now() - make_interval(hours => $5::int))
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
      ORDER BY (g.stats_synced_at IS NULL) DESC,
               (g.status = 'IN_PROGRESS') DESC,
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

  for (const game of due) {
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
    }
  }

  return {
    games: due.length,
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
 * Games still carrying an unresolved ingest problem.
 *
 * **The reader `games.stats_error` never had.** The column has been written
 * since `0027` — by warnings as much as by failures, which is exactly what paces
 * the retry — and nothing anywhere read it back. So a discrepancy survived the
 * run that found it, survived the week finalising around it, and was visible to
 * nobody: `cron_runs.last_outcome` holds one row per job and the next clean run
 * overwrites it, so a warning raised at noon is gone by ten past.
 *
 * Ordered most recent first and bounded, because this is read on a ten-minute
 * cadence and the interesting thing is that there are problems rather than the
 * full list of them. The count is returned alongside so a truncated list cannot
 * read as the whole of it.
 *
 * Not scoped to a season on purpose. A game inside its correction window is
 * still being re-read, and one past it never will be again — that second case is
 * the one worth surfacing, because whatever it says is now permanent.
 */
export async function unresolvedStatsProblems(
  db: SqlClient,
  sportKey: string,
  limit = 20,
): Promise<{
  readonly total: number;
  readonly games: readonly {
    readonly gameRef: string;
    readonly season: number;
    readonly week: number;
    readonly problem: string;
    /**
     * When the game went final, or `null` if it has not.
     *
     * Carried because the only useful question about a flagged game is whether
     * anything can still be done about it: a correction after the window has
     * closed writes a revision no finalised matchup will ever read. The window
     * itself is a league rule — 48h normally, 168h for weeks 14 and 17 — so the
     * instant is reported here and the judgement is left to the caller.
     */
    readonly finalAt: Date | null;
  }[];
}> {
  const ids = await loadSportIds(db, sportKey);

  const [counted] = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total
       FROM games
      WHERE sport_id = $1 AND stats_error IS NOT NULL`,
    [ids.sportId],
  );

  const games = await db.query<{
    external_ref: string;
    season: number;
    week: number;
    stats_error: string;
    final_at: Date | null;
  }>(
    `SELECT external_ref, season, week, stats_error, final_at
       FROM games
      WHERE sport_id = $1 AND stats_error IS NOT NULL
      ORDER BY kickoff_at DESC
      LIMIT $2`,
    [ids.sportId, limit],
  );

  return {
    total: Number(counted?.total ?? 0),
    games: games.map((row) => ({
      gameRef: row.external_ref,
      season: Number(row.season),
      week: Number(row.week),
      problem: row.stats_error,
      finalAt: row.final_at === null ? null : new Date(row.final_at),
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
  const usable = new Map<string, readonly StatLine[]>();
  for (const [ref, lines] of box.players) {
    if (ref.startsWith("DST_") && !lines.some((line) => line.statKey === "def_pts_allowed")) {
      problems.push(`${ref} has no def_pts_allowed and was not written`);
      continue;
    }
    usable.set(ref, lines);
  }
  for (const abv of [game.home_team_ref, game.away_team_ref]) {
    if (!usable.has(`DST_${abv}`)) problems.push(`DST_${abv} is missing from the box score`);
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
    // Both, on the success path. The attempt column paces the retry and must not
    // lose its pacing just because the read worked.
    await tx.query(
      "UPDATE games SET stats_synced_at = now(), stats_attempted_at = now(), stats_error = $2 WHERE id = $1",
      [game.id, problem],
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
