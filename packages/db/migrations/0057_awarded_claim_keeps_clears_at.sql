-- An awarded claim records when its player was due to clear. Issue #109.
--
-- Awarding a claim deletes the player's `waiver_wire` row, and that row was the
-- only place `clears_at` lived. So after an award nothing stored could say
-- whether it was early — the exact defect #106 fixed, which destroyed its own
-- evidence as it fired. Re-deriving it from the previous holder's `released_at`
-- no longer works either: the Tuesday weekly lock puts players on the wire with
-- no drop behind them.
--
-- Written by the run at award time, from the wire row it is about to delete,
-- not at filing: a re-drop moves `clears_at` after a claim is filed, and the
-- question is what it was when the award happened. "Was this early" is then
-- `processed_at < clears_at`, one comparison on one row.
--
-- Null for a claim decided before this column existed, and for an award whose
-- player had no wire row at the time.
--
-- Not done here: the priority order before and after each run (the issue's
-- option 3), which is the damage that compounds. That needs a table, not a
-- column.
--
-- Forward-only, like every migration here.

ALTER TABLE waiver_claims
  ADD COLUMN clears_at timestamptz;
