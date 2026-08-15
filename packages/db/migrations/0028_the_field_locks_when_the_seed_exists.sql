-- The field locks when the seed exists, not when the order is drawn.
--
-- `0010` wrote the right sentence and gated on the wrong event. Its header says:
--
--   "Letting a team join after the seed is known would restore the whole attack:
--    watch the block land, compute what adding a bot would do, then add it."
--
-- and then it refuses only once `order_drawn_at IS NOT NULL`. Those are the same
-- instant only if the draw happens the moment the seed exists, and it does not:
-- the draw is a button the commissioner presses, `drawDraftOrder` refuses only
-- *before* `scheduled_at` and has no upper bound, and `joinLeague` gates on the
-- league still being FORMING — which it is until `startDraft` runs, after the
-- draw. So there was a window of arbitrary length in which the seed was public
-- and `teams` rows still inserted.
--
-- The seed is the first Solana block at or after `drafts.scheduled_at`, mixed
-- with the league id and the rules hash. All three are public and frozen, so the
-- seed is computable by anyone the instant that time passes. `scheduled_at` is
-- therefore the moment the field has to close, and it is the moment
-- `docs/RULES.md` already names: "A league never reaches 2 humans by the draft
-- date" is written against the draft date being the filling deadline.
--
-- ## Not the attack the old comments describe
--
-- Every comment in the repo describes re-minting a bot with a fresh UUID.
-- That has never worked: `generateDraftOrder` shuffles *positions* and
-- `seededIndex` takes no team id, so identities are inert payload. The real
-- lever is the **size** of the field, and the sharpest form of it is a
-- commissioner who has not yet joined choosing when to insert themselves —
-- measured at a mean pick of 1.64 against a fair 6.50.
--
-- ## DELETE as well as INSERT
--
-- `0010` guarded INSERT only. Removing a team changes the field exactly as
-- adding one does, and delete-then-add is an unbounded re-roll rather than a
-- single blind draw. Only an application check in `removeBot` stood in the way,
-- in a function with no production caller.

CREATE OR REPLACE FUNCTION teams_locked_after_order_draw() RETURNS trigger AS $$
DECLARE
  d record;
  league uuid := COALESCE(NEW.league_id, OLD.league_id);
BEGIN
  SELECT order_drawn_at, scheduled_at INTO d
    FROM drafts WHERE league_id = league;

  -- No draft row yet. `createLeague` and `createDraftRecord` are two separate
  -- transactions, so this is the ordinary state of a league between them, and
  -- nothing is locked because nothing has been scheduled.
  IF NOT FOUND THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF d.order_drawn_at IS NOT NULL THEN
    RAISE EXCEPTION
      'League % has already drawn its draft order; the field is locked', league
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- `clock_timestamp()`, not `now()`. `now()` is the transaction's start time, so
  -- a transaction opened a moment before the scheduled time would insert under
  -- the old rule however long it then took. The window is microseconds and not
  -- reachable through the app; it costs nothing to be right about it.
  IF d.scheduled_at <= clock_timestamp() THEN
    RAISE EXCEPTION
      'League % was scheduled to draft at %; the field locked then', league, d.scheduled_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER teams_locked_after_draw ON teams;

CREATE TRIGGER teams_locked_after_draw
  BEFORE INSERT OR DELETE ON teams
  FOR EACH ROW EXECUTE FUNCTION teams_locked_after_order_draw();

-- ---------------------------------------------------------------------------
-- The lock instant is the one members signed
-- ---------------------------------------------------------------------------

-- `drafts.scheduled_at` now decides when the field closes, so it has to be the
-- same number the members signed rather than a copy that happens to agree.
--
-- Two things were true before this and both are the reason it is here. Nothing
-- made the column immutable — no trigger touched it — so whoever could reach the
-- database could move the lock. And nothing checked it against
-- `league_rules.rule_json`, which is itself immutable by trigger (`0004`): the
-- route sets them from one value at creation and no test held it to that, so the
-- two were free to drift. They already had: the draft fixtures froze rules at one
-- instant and wrote `scheduled_at` a year later, and nothing noticed.
--
-- Comparing against the frozen document is what keeps this checkable by a
-- stranger. It is the property that rules out deriving the seed from a "close the
-- field" timestamp of our own: an instant our server writes is one an auditor has
-- to trust, and the whole point of drawing from the chain is that they do not.
CREATE FUNCTION drafts_scheduled_at_matches_frozen_rules() RETURNS trigger AS $$
DECLARE
  frozen bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at THEN
    RAISE EXCEPTION
      'Draft % has a scheduled time frozen at league creation; it cannot be moved',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT (rule_json -> 'draft' ->> 'scheduledAt')::bigint INTO frozen
    FROM league_rules WHERE league_id = NEW.league_id;

  IF frozen IS NULL THEN
    RAISE EXCEPTION 'League % has no frozen rules to schedule against', NEW.league_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.scheduled_at <> to_timestamp(frozen) THEN
    RAISE EXCEPTION
      'Draft scheduled for % but the frozen rules say %',
      NEW.scheduled_at, to_timestamp(frozen)
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drafts_scheduled_at_frozen
  BEFORE INSERT OR UPDATE ON drafts
  FOR EACH ROW EXECUTE FUNCTION drafts_scheduled_at_matches_frozen_rules();
