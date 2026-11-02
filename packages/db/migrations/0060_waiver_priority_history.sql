-- Every change to a team's waiver priority, kept. Issue #380.
--
-- `processWaivers` rewrites `teams.waiver_priority` in place and nothing kept
-- the previous order. `waiver_claims.priority_at_claim` covers only teams that
-- filed, so after one wrong run the order was wrong for the rest of the season
-- with nothing to show what it should have been.
--
-- **A trigger, as 0059 does for lineups.** Two functions write the column (the
-- seed at draft completion, and each run), and a hand-run repair is exactly the
-- write that most needs recording.
--
-- **Changes only, and that is enough to rebuild the whole order.** The seed is
-- recorded too, so a team's priority at any instant is the `priority_after` of
-- its latest row at or before it. A team the run did not move has no new row and
-- needs none.
--
-- **`changed_at` is `now()`, the transaction's start, on purpose.** A waiver run
-- is one transaction, so every change it makes carries the same timestamp, and
-- that timestamp is what groups them into one run. A rolled-back run writes
-- nothing, because the trigger's insert rolls back with it.

CREATE TABLE waiver_priority_changes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id        uuid NOT NULL REFERENCES leagues (id) ON DELETE RESTRICT,
  team_id          uuid NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
  priority_before  smallint,
  priority_after   smallint,
  changed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX waiver_priority_changes_league_idx
  ON waiver_priority_changes (league_id, changed_at);

CREATE FUNCTION teams_record_waiver_priority() RETURNS trigger AS $$
BEGIN
  INSERT INTO waiver_priority_changes (league_id, team_id, priority_before, priority_after)
  VALUES (NEW.league_id, NEW.id, OLD.waiver_priority, NEW.waiver_priority);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER teams_record_waiver_priority
  AFTER UPDATE OF waiver_priority ON teams
  FOR EACH ROW
  WHEN (OLD.waiver_priority IS DISTINCT FROM NEW.waiver_priority)
  EXECUTE FUNCTION teams_record_waiver_priority();

-- History, made history: the same guarantee 0055 gives draft_picks.
CREATE FUNCTION waiver_priority_changes_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'waiver_priority_changes is append-only: a priority change is never rewritten'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER waiver_priority_changes_append_only
  BEFORE UPDATE OR DELETE ON waiver_priority_changes
  FOR EACH ROW EXECUTE FUNCTION waiver_priority_changes_are_append_only();

CREATE TRIGGER waiver_priority_changes_no_truncate
  BEFORE TRUNCATE ON waiver_priority_changes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_frozen_truncate();

COMMENT ON TABLE waiver_priority_changes IS
  'Every change to teams.waiver_priority, written by trigger. Append-only. Rows sharing changed_at are one waiver run.';
