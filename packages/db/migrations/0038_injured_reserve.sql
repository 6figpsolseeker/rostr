-- Injured reserve, which the rules have always promised and nothing implemented.
--
-- `roster.irSlots` is 2 in the default rule set, sits in the frozen hashed
-- document every member signs, and is rendered by `RulesView` above the join
-- control. Nothing else in the repo read it. That is the same defect
-- `botsAllowed` was removed over — a guarantee members signed that did nothing —
-- except that here the answer is to implement it rather than delete it.
--
-- **A designation, not a lineup slot.** IR is a property of the roster, not of
-- one week: a player put on IR in week 3 is still on it in week 4 without
-- anybody re-stating it, and roster capacity must not vary week to week. So it
-- lives on `roster_entries` rather than in `lineups`.
--
-- **This column is mutable, and `roster_entries` is otherwise append-only.**
-- That is deliberate and worth naming, because the append-only shape exists so
-- any past week's roster can be reconstructed. IR reaches no past week: it
-- decides transactions and capacity, never who started or what anyone scored, so
-- a settled week stays exactly as provable as it was. What is genuinely lost is
-- the ability to say *when* somebody went on IR, and nothing needs to know.
ALTER TABLE roster_entries
  ADD COLUMN on_ir boolean NOT NULL DEFAULT false;

-- A released player is not on anybody's injured reserve. Without this a drop
-- would leave `on_ir` true on a historical row, and any future count that
-- forgot to filter on `released_at` would exempt a player who left months ago.
ALTER TABLE roster_entries
  ADD CONSTRAINT roster_entries_ir_requires_active
  CHECK (NOT on_ir OR released_at IS NULL);

-- The count of players a team has stashed, which both the capacity rule and the
-- IR limit consult on every transaction.
CREATE INDEX roster_entries_ir_idx
  ON roster_entries (team_id)
  WHERE on_ir AND released_at IS NULL;
