-- Projected season totals.
--
-- **Raw stats, not points.** The provider ships its own fantasy point total and
-- it is deliberately discarded: every league scores against its own frozen rules,
-- and ours pays 4 for a passing touchdown where a provider's default may pay 6.
-- Storing someone else's arithmetic would put a number on the draft board that
-- disagrees with the number that decides matchups.
--
-- Same shape as a stat line, so the same scoring engine produces both a
-- projection and a result. There is only one definition of a point in this
-- system.

CREATE TABLE player_projections (
  player_id    uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  season       smallint NOT NULL,
  -- Which provider said so. Projections differ wildly between sources, and a
  -- second opinion later must not silently overwrite the first.
  source       text NOT NULL,
  stat_key_id  uuid NOT NULL REFERENCES stat_keys (id),
  -- Whole units, as everywhere else. Projections arrive fractional (63.9
  -- receptions) and are rounded at the boundary: the error is far smaller than
  -- the uncertainty already in a projection, and it keeps the scoring engine
  -- integer-only.
  value        integer NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season, source, stat_key_id)
);

CREATE INDEX player_projections_season_idx ON player_projections (season, source);
