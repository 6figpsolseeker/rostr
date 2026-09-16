-- What the autofill decided, and the number it decided on.
--
-- Four places promised this and none of them delivered it (issue #267):
--
--   * `docs/RULES.md` §8 — "The projection used is recorded with the lineup, so
--     the decision is checkable after the fact."
--   * `packages/core/src/season/autolineup.ts` — "what makes it honest is that
--     the number used is recorded".
--   * `docs/DECISIONS.md` — "store the projection used, with its source, and the
--     decision is as reproducible as anything else in the system."
--   * `packages/core/src/rules/types.ts` — on the **hashed** `autofill` field
--     itself, which is the one members sign.
--
-- The last is why this is a migration rather than an edit to three sentences.
-- That DECISIONS.md line is the argument that overturned RULES.md's explicit
-- refusal of projections — the refusal being that a provider changing its model
-- would alter the outcome of a rule that can never be amended — and the answer
-- given was "store what was used, and it stays reproducible". `roster.autofill`
-- is frozen per league, so for every league that already exists the mode cannot
-- be changed and the promise cannot be withdrawn. It can only be kept.
--
-- And the input is destroyed in the ordinary course of business: `player_projections`
-- is upserted `DO UPDATE SET value = EXCLUDED.value` on a key carrying no
-- revision and no `as_of`, so every resync overwrites the number the autofill
-- ranked on, in place. Reading the decision back out of the projections table is
-- therefore not merely unimplemented, it is impossible.

-- When the autofill wrote this slot. NULL means a person did.
--
-- **A new column rather than `locked_at`**, which is dead — written once as a
-- literal NULL by one insert, never read anywhere, never set. "Dead, therefore
-- free" is how a column acquires a second meaning; it is left exactly as it is.
--
-- It also answers a question the schema could not: an empty slot now means two
-- things, "the autofill could not fill it" and "nobody has been near it", and
-- `unsetLineups` needs to tell them apart before it can warn about the first.
ALTER TABLE lineups ADD COLUMN autofilled_at timestamptz;

-- The number this player was ranked on, in milli-points, and where it came from.
--
-- Milli-points because every score in this system is an integer (invariant 2);
-- a projection is scored through the same `scorePlayer` as a real week.
--
-- `ranked_on` is the mode's own answer for *this player*, not the league's mode:
-- under WEEKLY_PROJECTION a player with no projection is ranked on his season
-- average instead of being dumped to the bottom, so the two differ per slot and
-- only the per-slot answer reconstructs the decision.
--
-- Both are NULL for a slot the autofill left empty, and for a player with no
-- record at all — which is itself the explanation for why he sorted where he did.
ALTER TABLE lineups ADD COLUMN ranked_milli_points integer;
ALTER TABLE lineups ADD COLUMN ranked_on text;

-- The projections source, when that is what was used. `PRIMARY_PROJECTION_SOURCE`
-- today; recorded rather than assumed, because the constant can move and a league
-- scored under the old one must still be reconstructable.
ALTER TABLE lineups ADD COLUMN ranked_source text;

ALTER TABLE lineups ADD CONSTRAINT lineups_ranked_on_known
  CHECK (ranked_on IS NULL OR ranked_on IN ('PROJECTION', 'AVERAGE'));

-- A number without a basis is not a record of anything, and a basis with no
-- number would be a claim about a value nobody stored.
ALTER TABLE lineups ADD CONSTRAINT lineups_ranked_value_needs_basis
  CHECK ((ranked_milli_points IS NULL) = (ranked_on IS NULL));

-- A source belongs to a projection. An average has none — it is computed from
-- this league's own stat lines, which are already sourced per row.
ALTER TABLE lineups ADD CONSTRAINT lineups_ranked_source_is_a_projection
  CHECK (ranked_source IS NULL OR ranked_on = 'PROJECTION');

COMMENT ON COLUMN lineups.autofilled_at IS
  'When the autofill wrote this slot; NULL means a person set it.';
COMMENT ON COLUMN lineups.ranked_milli_points IS
  'The value this player was ranked on when the autofill chose him.';
COMMENT ON COLUMN lineups.ranked_on IS
  'PROJECTION or AVERAGE — which number ranked him, per player, not per league.';
COMMENT ON COLUMN lineups.ranked_source IS
  'The projections source used, when ranked_on is PROJECTION.';
