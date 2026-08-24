-- "When did we last try" and "do we have stats" become two columns.
--
-- `stats_synced_at` was stamped by `syncBoxScores` on **both** paths — on a
-- successful ingest, and on a failure alongside the reason in `stats_error`.
-- The failure stamp was deliberate and load-bearing: it is the only thing
-- pacing the retry, and `0027`'s own comment records what happened without it.
-- One game with a permanent discrepancy was re-read seventy-two times a day for
-- the rest of the season, and sixteen such games would have exceeded the daily
-- quota outright.
--
-- The cost is that the column answered two questions with one value, and the
-- second answer was wrong. #140 added a hold on finalisation — a week does not
-- settle while any FINAL game has no box score — and read `stats_synced_at IS
-- NULL` to mean "no box score". That catches a game nobody ever *tried* to read
-- and misses one somebody tried and failed on, because the failure stamped the
-- column. So the week finalised with those players at zero, permanently, which
-- is precisely what a rate limit on a Sunday produces. Issue #227.
--
-- `stats_attempted_at` takes the pacing. `stats_synced_at` goes back to meaning
-- what its name says, and is set only when stats were actually written.
--
-- ## The backfill is deliberately incomplete, and that is the honest option
--
-- Every existing row that was synced was also attempted, so the attempt column
-- is filled from it. What cannot be recovered is the other direction: for a row
-- carrying both a timestamp and a `stats_error`, nothing here can tell a
-- *failure* from a *successful ingest that raised warnings* — `stats_error` has
-- always been written by both, which is exactly why it could not simply be read
-- as the hold condition instead.
--
-- So historical `stats_synced_at` values are left alone rather than
-- retroactively nulled on a guess. A past failure keeps claiming it synced; the
-- distinction holds from here. Inventing history to make a new invariant look
-- older than it is would be worse than a documented gap, and the alternative —
-- nulling every row with an error — would blank the successful ingests that
-- merely had a discrepancy, which is most of them.
--
-- No production week has finalised yet, so nothing has been decided on the
-- ambiguous rows.
ALTER TABLE games
  ADD COLUMN stats_attempted_at timestamptz;

UPDATE games
   SET stats_attempted_at = stats_synced_at
 WHERE stats_synced_at IS NOT NULL;

COMMENT ON COLUMN games.stats_attempted_at IS
  'When the box-score producer last tried this game, successfully or not. Paces '
  'the retry: every clause selecting a game for re-read is bounded against this, '
  'because a game that cannot be read must not be re-fetched every tick. Set on '
  'both the success and failure paths.';

COMMENT ON COLUMN games.stats_synced_at IS
  'When stat lines were last written for this game. NULL means no box score has '
  'been ingested — including for a game that was tried and failed, which is the '
  'distinction 0041 introduced and which finalizationHold depends on. Use '
  'stats_attempted_at for pacing, never this.';

-- The index backing the due query follows the column that now paces it.
-- `0027`'s `games_stats_due_idx` on (season, status, stats_synced_at) stays, for
-- the correction sweep, which genuinely wants the sync time.
CREATE INDEX games_stats_attempt_idx
  ON games (season, status, stats_attempted_at);
