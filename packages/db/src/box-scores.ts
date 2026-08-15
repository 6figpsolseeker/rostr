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
 * A bound on *spend*, not on work: the provider is metered, a run makes one call
 * per game, and nothing else in this query limits how many games it can select
 * at once. A season backfill — `pnpm db:sync 2025`, which is a planned task —
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
  readonly failures: readonly { readonly gameRef: string; readonly reason: string }[];
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
        -- **Every clause here needs a ceiling.** This query is the only thing
        -- pacing a metered provider — the loop below has no delay in it — so a
        -- clause that can stay true indefinitely is a call every ten minutes
        -- until the season ends.
        AND (
              g.stats_synced_at IS NULL
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
               AND g.stats_synced_at < now() - make_interval(mins => $4::int)
               AND g.final_at > now() - make_interval(hours => $5::int))
           -- The NFL stat-correction sweep.
           OR (g.final_at > now() - make_interval(hours => $5::int)
               AND g.stats_synced_at < now() - make_interval(hours => $6::int))
        )
      -- Never-read first, then live, then everything else oldest-first. The
      -- order is doing real work now that there is a LIMIT: a game nobody has
      -- read scores its players zero *right now*, where a re-read only refines a
      -- number that already exists, and plain kickoff order would let a backlog
      -- of old games starve today's.
      ORDER BY (g.stats_synced_at IS NULL) DESC,
               (g.status = 'IN_PROGRESS') DESC,
               g.kickoff_at
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
  const playerIds = new Map(
    (
      await db.query<{ id: string; external_ref: string }>(
        "SELECT id, external_ref FROM players WHERE sport_id = $1",
        [ids.sportId],
      )
    ).map((row) => [row.external_ref, row.id]),
  );

  let inserted = 0;
  let revised = 0;
  let retracted = 0;
  let unchanged = 0;
  const unmatched: string[] = [];
  const failures: { gameRef: string; reason: string }[] = [];

  for (const game of due) {
    try {
      const box = await provider.getBoxScore(game.external_ref);
      const outcome = await ingestOneGame(db, provider.name, game, box, statKeyIds, playerIds);

      inserted += outcome.inserted;
      revised += outcome.revised;
      retracted += outcome.retracted;
      unchanged += outcome.unchanged;
      unmatched.push(...outcome.unmatched);
      if (outcome.problem) {
        failures.push({ gameRef: game.external_ref, reason: outcome.problem });
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
      await db.query(
        "UPDATE games SET stats_synced_at = now(), stats_error = $2 WHERE id = $1",
        [game.id, reason],
      );
      failures.push({ gameRef: game.external_ref, reason });
    }
  }

  return { games: due.length, inserted, revised, retracted, unchanged, unmatched, failures };
}

interface GameOutcome {
  readonly inserted: number;
  readonly revised: number;
  readonly retracted: number;
  readonly unchanged: number;
  readonly unmatched: string[];
  /** Set when the game was only partly ingested and must be re-read. */
  readonly problem: string | null;
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

  for (const [ref, lines] of usable) {
    const playerId = playerIds.get(ref);
    if (!playerId) {
      unmatched.push(ref);
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

    const problem = problems.length > 0 ? problems.join("; ") : null;
    await tx.query("UPDATE games SET stats_synced_at = now(), stats_error = $2 WHERE id = $1", [
      game.id,
      problem,
    ]);

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
      problem,
    };
  });
}
