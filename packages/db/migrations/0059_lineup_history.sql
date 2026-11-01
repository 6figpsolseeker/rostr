-- Every change to a lineup slot, kept. Issue #102.
--
-- `lineups` is updated in place, so when a manager says "that is not the lineup
-- I set" nothing stored can answer them — and a finalised week is never
-- rescored, so a wrong row found later changes no points. `roster_entries` is
-- append-only for exactly this reason; a lineup decides a matchup as directly.
--
-- **A trigger, not an insert in each writer.** Three functions write `lineups`
-- today (the manager's save, the autofill, the release that empties a slot) and
-- the class of bug this exists to catch is a write nobody expected. A trigger
-- records the ones a fourth writer, a hand-run fix or a stray UPDATE would make.
--
-- **Changes only.** The autofill re-writes every slot every ten minutes; a row
-- per pass would be nine per team per tick saying nothing happened. A slot
-- created empty records nothing either — nothing was chosen.

-- Who wrote the slot last. Each application writer sets it on every write, so
-- the trigger can copy it. NULL means a write that did not say: a test fixture,
-- or SQL run by hand — which is exactly the write worth seeing named as such.
ALTER TABLE lineups ADD COLUMN written_by text
  CONSTRAINT lineups_written_by_known
    CHECK (written_by IN ('MANAGER', 'AUTOFILL', 'RELEASE'));

CREATE TABLE lineup_writes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The slot, by its own key rather than by `lineups.id`. Nothing in the
  -- application deletes a lineup row, but if anything ever does, its history
  -- must outlive it — a foreign key to the row would either block the delete
  -- or take the history with it.
  team_id             uuid NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
  week                smallint NOT NULL,
  slot_type_id        uuid NOT NULL REFERENCES slot_types (id),
  slot_index          smallint NOT NULL,
  player_id           uuid REFERENCES players (id),
  previous_player_id  uuid REFERENCES players (id),
  written_by          text,
  -- clock_timestamp, not now(): two changes in one transaction must still order.
  written_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX lineup_writes_slot_idx ON lineup_writes (team_id, week, written_at);

-- A delete is recorded as the slot emptying, with no writer: the application
-- issues none, so one that removes a starter is precisely the unexpected write
-- this table is for.
CREATE FUNCTION lineups_record_write() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.player_id IS NOT NULL THEN
      INSERT INTO lineup_writes
        (team_id, week, slot_type_id, slot_index, player_id, previous_player_id, written_by)
      VALUES (OLD.team_id, OLD.week, OLD.slot_type_id, OLD.slot_index, NULL, OLD.player_id, NULL);
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.player_id IS NULL THEN
      RETURN NULL;
    END IF;
  ELSIF OLD.player_id IS NOT DISTINCT FROM NEW.player_id THEN
    RETURN NULL;
  END IF;

  INSERT INTO lineup_writes
    (team_id, week, slot_type_id, slot_index, player_id, previous_player_id, written_by)
  VALUES (
    NEW.team_id, NEW.week, NEW.slot_type_id, NEW.slot_index,
    NEW.player_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.player_id END,
    NEW.written_by
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lineups_record_write
  AFTER INSERT OR UPDATE OR DELETE ON lineups
  FOR EACH ROW EXECUTE FUNCTION lineups_record_write();

-- History, made history: the same guarantee 0055 gives draft_picks.
CREATE FUNCTION lineup_writes_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'lineup_writes is append-only: a lineup change is never rewritten'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lineup_writes_append_only
  BEFORE UPDATE OR DELETE ON lineup_writes
  FOR EACH ROW EXECUTE FUNCTION lineup_writes_are_append_only();

CREATE TRIGGER lineup_writes_no_truncate
  BEFORE TRUNCATE ON lineup_writes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_frozen_truncate();

COMMENT ON TABLE lineup_writes IS
  'Every change to a lineup slot, written by trigger. Append-only.';
COMMENT ON COLUMN lineups.written_by IS
  'MANAGER, AUTOFILL or RELEASE — who wrote this slot last. NULL: unstated.';
