-- Weekly projections, the autofill toggle, and the end of abandonment.
--
-- 0013 stored projected *season totals*, which is what a draft board needs: it
-- ranks who to pick for the year. Filling a lineup is a different question —
-- who scores most **this Sunday** — and a season total cannot answer it. A
-- player on bye projects zero for the week and unchanged for the season.
--
-- The provider serves both from one endpoint: `getNFLProjections` with no week
-- returns the season aggregate, with a week returns that week alone. So this is
-- the same shape with `week` added to the key, not a second table.

-- ---------------------------------------------------------------------------
-- Projections gain a week
-- ---------------------------------------------------------------------------
--
-- Week 0 means the season aggregate, so the existing rows keep their meaning and
-- the draft board keeps working. A nullable column would have been the other
-- option, but then the primary key would not constrain it — Postgres treats
-- NULLs as distinct, so the same player could hold two season projections from
-- one source.

ALTER TABLE player_projections ADD COLUMN week smallint NOT NULL DEFAULT 0
  CHECK (week >= 0 AND week <= 22);

COMMENT ON COLUMN player_projections.week IS
  'Week 1-22, or 0 for the season aggregate that the draft board uses.';

ALTER TABLE player_projections DROP CONSTRAINT player_projections_pkey;
ALTER TABLE player_projections
  ADD PRIMARY KEY (player_id, season, week, source, stat_key_id);

-- The autofill reads one week for every rostered player at lock time, so the
-- lookup is by week rather than by player.
CREATE INDEX player_projections_week_idx ON player_projections (season, week, source);

-- ---------------------------------------------------------------------------
-- Autofill is a preference, not a rule
-- ---------------------------------------------------------------------------
--
-- Which *method* the autofill uses is in the frozen rule set (`roster.autofill`)
-- because it decides everyone's playoff seeds and has to be verifiable. Whether
-- your own team gets filled is nobody else's business, so it lives here, is
-- mutable, and defaults to on.
--
-- Off means empty slots score nothing, which is the honest meaning of the
-- toggle. `ensureLineups` still writes a lineup row either way, because
-- `resolveWeek` throws on a team with no lineup at all — scoring a missing team
-- as zero would hand its opponent a free win off our own bug.
--
-- Bots ignore it. There is no manager to forget.

ALTER TABLE teams ADD COLUMN autofill_enabled boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- Abandonment is gone
-- ---------------------------------------------------------------------------
--
-- `strikes` was written in 0005 and never incremented by anything. The rule it
-- served counted consecutive weeks with an invalid lineup, and the autofill
-- runs before a week is scored — so a lineup was never invalid at the moment
-- the count would have happened. It could not fire.
--
-- Removed rather than repaired. A manager who stops setting lineups is not
-- defrauding anyone, and forfeiting their stake for inattention is a rule people
-- would discover by losing money to it. The autofill keeps their team
-- competitive, so the league is not harmed either. It also deletes an escrow
-- instruction that would have moved one member's stake to another.
--
-- Dropped rather than left in place, because a column nothing writes is a
-- standing invitation for something to start writing it.

ALTER TABLE teams DROP COLUMN strikes;
