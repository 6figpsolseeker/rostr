-- Draft rankings.
--
-- Feeds `DraftablePlayer.rank`, which the draft engine takes as an input and
-- previously had no source for.
--
-- Rankings are dated and versioned rather than overwritten: ADP moves daily
-- through the preseason, and a draft that happened on a given day should remain
-- explicable from the board as it stood that day.

CREATE TABLE player_rankings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  season        smallint NOT NULL,
  -- Which provider said so. Rankings from two sources must stay distinguishable.
  source        text NOT NULL,
  -- Scoring format the ranking assumes: PPR, HALF, STANDARD.
  ranking_type  text NOT NULL,
  -- Average draft position in milli-units: "3.2" is stored as 3200.
  -- Integers everywhere, for the same reason scoring uses milli-points.
  overall_milli integer NOT NULL CHECK (overall_milli > 0),
  -- Positional rank as the provider expresses it: "RB1", "WR3".
  position_rank text,
  as_of         date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, season, source, ranking_type, as_of)
);

CREATE INDEX player_rankings_board_idx
  ON player_rankings (season, source, ranking_type, as_of, overall_milli);

-- The current board for a season and format: the most recent date we have.
CREATE VIEW player_rankings_current AS
SELECT DISTINCT ON (player_id, season, source, ranking_type)
  player_id, season, source, ranking_type, overall_milli, position_rank, as_of
FROM player_rankings
ORDER BY player_id, season, source, ranking_type, as_of DESC;
