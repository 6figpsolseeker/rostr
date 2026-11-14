-- A draft's pick clock and round count cannot change once written. Issue #69.
--
-- `0009` says `pick_seconds` is "copied from the frozen rules so the clock
-- cannot be changed mid-draft by editing anything". Nothing enforced that, and
-- `rounds` had no guard either. Both are read from this row, not from the
-- rules, every time the draft runs: the pick deadline is `clock_started_at +
-- pick_seconds`, and `rounds` decides when the draft is complete. So an UPDATE
-- of either changed a live draft's clock or length, quietly, against rules
-- every member signed.
--
-- `0028` closed the same gap for `scheduled_at`. This is the other two.
--
-- No code path updates either column: the create route writes both once, in
-- the same transaction that freezes the rules, from those rules. So this
-- refuses nothing the application does.
--
-- UPDATE only. Checking an INSERT against the rules would mean recomputing the
-- round count from the roster in SQL, for a write that already comes from the
-- rules in the same transaction. The defect here is a change after the fact.
--
-- `UPDATE OF` fires only when a statement names one of the columns, so the
-- draft's other updates (status, clock, the order draw) never reach this.
-- `IS DISTINCT FROM` lets a statement that sets a column to its current value
-- through.

CREATE FUNCTION drafts_clock_is_frozen() RETURNS trigger AS $$
BEGIN
  IF NEW.pick_seconds IS DISTINCT FROM OLD.pick_seconds THEN
    RAISE EXCEPTION
      'Draft % has a pick clock frozen at league creation (% seconds); it cannot be changed',
      OLD.id, OLD.pick_seconds
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.rounds IS DISTINCT FROM OLD.rounds THEN
    RAISE EXCEPTION
      'Draft % has a round count frozen at league creation (%); it cannot be changed',
      OLD.id, OLD.rounds
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drafts_clock_frozen
  BEFORE UPDATE OF pick_seconds, rounds ON drafts
  FOR EACH ROW EXECUTE FUNCTION drafts_clock_is_frozen();
