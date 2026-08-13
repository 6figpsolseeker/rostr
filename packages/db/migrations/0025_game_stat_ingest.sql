-- Box-score ingestion state, per game.
--
-- `stat_lines` carries no `game_id` — provenance is per (player, season, week),
-- which is sound because an NFL player appears in at most one regular-season
-- game a week. What that cannot express is "we read this box score and nothing
-- had changed", and the difference matters: without it, a correction sweep is
-- either a fetch of every game every ten minutes for seven days, or nothing.
--
-- It is also the only way to tell two states apart that are otherwise
-- byte-identical in the database: a game that was postponed and never played,
-- and a game that was played and that we failed to fetch. `RULES.md` §10's
-- fallback scores the first as zeros deliberately. Scoring the second as zeros
-- is a silent wrong answer, and `finalizationHold` currently cannot distinguish
-- them because it asks `games.status` and nothing else.
--
-- Additive and nullable. No trigger, no backfill, no change to any existing
-- column — a game nobody has fetched simply reads NULL.

ALTER TABLE games ADD COLUMN stats_synced_at timestamptz;
ALTER TABLE games ADD COLUMN stats_error     text;

COMMENT ON COLUMN games.stats_synced_at IS
  'When the box score for this game was last read, successfully or not. NULL means never.';

COMMENT ON COLUMN games.stats_error IS
  'Why the last box-score read did not fully succeed, or NULL if it did. A game '
  'left non-NULL is one whose stats are incomplete — it is re-read on a shorter '
  'interval, and it is the signal that a week may finalise around missing data.';

-- The producer's work list: games in this season, by status, ordered by how long
-- since we last looked. Matches the WHERE in `syncBoxScores`.
CREATE INDEX games_stats_due_idx ON games (season, status, stats_synced_at);
