-- Three tables documented as history, made history. Issue #82.
--
-- Each one's comment promises a guarantee no trigger provided, so any bug in a
-- route that writes to them, or anyone holding the application's own database
-- role, could rewrite a record the product tells members is permanent. Same
-- correction 0019 made for the rules: a promise in the application is not a
-- guarantee until the database refuses.
--
-- Every UPDATE and DELETE the application issues against these tables was
-- enumerated before writing this, and each is still permitted below.

-- ---------------------------------------------------------------------------
-- 1. draft_picks — "Append-only. A pick is never updated or deleted." (0009)
-- ---------------------------------------------------------------------------
--
-- Nothing in the application updates or deletes a pick, so nothing is allowed.
-- A rewritten pick moves a player between rosters after the fact while the
-- draft board, which reads this table, agrees with the rewrite.

CREATE FUNCTION draft_picks_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'draft_picks is append-only: a pick is never updated or deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER draft_picks_append_only
  BEFORE UPDATE OR DELETE ON draft_picks
  FOR EACH ROW EXECUTE FUNCTION draft_picks_are_append_only();

CREATE TRIGGER draft_picks_no_truncate
  BEFORE TRUNCATE ON draft_picks
  FOR EACH STATEMENT EXECUTE FUNCTION reject_frozen_truncate();

-- ---------------------------------------------------------------------------
-- 2. league_memberships — the signed consent (0019)
-- ---------------------------------------------------------------------------
--
-- `rules_hash` and `signature` are "the only evidence members consented to the
-- rules they joined under", and 0019 guarded them against TRUNCATE only.
--
-- No UPDATE at all: nothing in the application issues one, and every column is
-- part of the record — who signed, for which team, from which wallet, when.
--
-- DELETE stays open until the draft order is drawn, because `removeMember`
-- legitimately deletes a free league's member before the draw and refuses
-- afterwards. After the draw the field is locked (0028), so a membership row
-- leaving then could only be erasing evidence.

CREATE FUNCTION league_memberships_are_signed_records() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'league_memberships is a signed record and cannot be updated'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM drafts
     WHERE league_id = OLD.league_id AND order_drawn_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'league % has drawn its draft order; its memberships can no longer be removed',
      OLD.league_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER league_memberships_signed
  BEFORE UPDATE OR DELETE ON league_memberships
  FOR EACH ROW EXECUTE FUNCTION league_memberships_are_signed_records();

-- ---------------------------------------------------------------------------
-- 3. roster_entries — "append-only with released_at" (0005)
-- ---------------------------------------------------------------------------
--
-- `trades.ts` says why: "a trade that edited history would make a settled week
-- unverifiable". A past week is scored from the rows that were active then, so
-- an edited row changes a result nobody re-scores.
--
-- The application does two things to an existing row, and both stay legal:
--   - releases it: `released_at` goes from NULL to a time, once;
--   - moves it on or off injured reserve: `on_ir`, freely, within 0038's CHECK.
-- Everything else about a row is what happened, and is refused. `league_id` is
-- derived by 0022's trigger, and is refused here only as a change.
--
-- DELETE is refused outright. A dropped player is released, never deleted.

CREATE FUNCTION roster_entries_are_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'roster_entries is history: release a row, never delete it'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.team_id IS DISTINCT FROM OLD.team_id
     OR NEW.league_id IS DISTINCT FROM OLD.league_id
     OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.acquired_via IS DISTINCT FROM OLD.acquired_via
     OR NEW.acquired_at IS DISTINCT FROM OLD.acquired_at
     OR (OLD.released_at IS NOT NULL
         AND NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
    RAISE EXCEPTION
      'roster_entries % is history: only a release and the IR flag may change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER roster_entries_history
  BEFORE UPDATE OR DELETE ON roster_entries
  FOR EACH ROW EXECUTE FUNCTION roster_entries_are_history();

CREATE TRIGGER roster_entries_no_truncate
  BEFORE TRUNCATE ON roster_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_frozen_truncate();
