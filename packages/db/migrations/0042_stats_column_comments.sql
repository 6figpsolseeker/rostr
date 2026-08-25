-- Correct two column comments that asserted guarantees the code did not provide.
--
-- `0041` split "we tried to read this game" from "we wrote stat lines for it",
-- and described the result in two `COMMENT ON COLUMN` strings that were both
-- wrong in the same direction — each claiming a cleaner separation than the
-- query actually implemented. This repo treats a comment asserting a guarantee
-- the code does not provide as a defect in its own right, and a comment stored
-- in the database is the one place a reader cannot check it against the source
-- sitting next to it.
--
-- 1. "every clause selecting a game for re-read is bounded against this"
--
--    False when written. Of the four OR-branches in the box-score work list,
--    one selected live games with no attempt bound at all, and the NFL
--    stat-correction sweep was bounded against `stats_synced_at` — the very
--    column `0041` had just removed from the failure path. So a game that had
--    synced and then began failing kept a frozen-true predicate and was
--    re-fetched on every tick, roughly a thousand metered calls for one game,
--    which is the quota burn the retry bound exists to prevent. The sweep is
--    now bounded on both columns and the comment says what is true.
--
-- 2. "Use stats_attempted_at for pacing, never this."
--
--    Contradicted ten lines below in its own file, where the index comment says
--    the sweep "genuinely wants the sync time". Both are needed and they answer
--    different questions: the attempt paces, the sync selects.
--
-- Also narrowed: NULL is not the only value meaning "no box score for this game
-- as it finally stood". A game read while IN_PROGRESS carries a sync stamp
-- older than the final whistle, and `finalizationHold` now treats that as
-- unread too — otherwise a game whose every post-final read failed settles the
-- week on third-quarter numbers.
--
-- No data changes. Comments only.

COMMENT ON COLUMN games.stats_attempted_at IS
  'When the box-score producer last tried this game, successfully or not. Set on '
  'both the success and failure paths. This is what paces re-reads: every clause '
  'of the work list that can select an already-attempted game is bounded against '
  'it, so a game that cannot be read is not re-fetched every tick. The one clause '
  'not bounded against it selects only games that have never been attempted.';

COMMENT ON COLUMN games.stats_synced_at IS
  'When stat lines were last written for this game. NULL means none ever were — '
  'including for a game that was tried and failed, which is the distinction 0041 '
  'introduced. It says a box score was read, not that the final one was: a game '
  'read while IN_PROGRESS carries a stamp older than final_at, and finalizationHold '
  'counts that as unread. Selection may read this column; pacing must not rely on '
  'it alone, because the failure path deliberately leaves it untouched.';
