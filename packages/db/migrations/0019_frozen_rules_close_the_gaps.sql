-- The immutability guarantee, made true.
--
-- 0004 says application-layer immutability is a promise and database-layer
-- immutability is a guarantee, and it is nearly right: `league_rules`,
-- `league_scoring_rules` and `league_roster_slots` reject UPDATE and DELETE, and
-- 0018 closed TRUNCATE. Three holes remain, and unlike TRUNCATE — which needs
-- table ownership — every one of these is reachable at ordinary application
-- privilege, from any bug in a route that writes to these tables.
--
-- ---------------------------------------------------------------------------
-- 1. leagues.rules_hash was unguarded, which also defeated the hash check
-- ---------------------------------------------------------------------------
--
-- It is the value that goes on-chain and that every member signs. 0014 added a
-- trigger to `leagues`, but it guards only the three `chain_*` columns, so the
-- hash itself could simply be rewritten.
--
-- Worse, `check_rules_hash_matches` compares an incoming `league_rules.hash`
-- against `leagues.rules_hash` — so control of the latter is control of the
-- check. Rewrite the hash first and any rule set at all can then be inserted
-- against it, with the trigger reporting success.
--
-- Frozen from the moment a rule set exists rather than from creation, because
-- `createLeague` writes the league row before the rules in one transaction.
-- Before that instant there is nothing on-chain and nothing signed.

CREATE FUNCTION leagues_rules_hash_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.rules_hash IS DISTINCT FROM OLD.rules_hash
     AND EXISTS (SELECT 1 FROM league_rules WHERE league_id = OLD.id) THEN
    RAISE EXCEPTION
      'league %.rules_hash is frozen: it is anchored on-chain and signed by every member',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leagues_rules_hash_immutable
  BEFORE UPDATE ON leagues
  FOR EACH ROW EXECUTE FUNCTION leagues_rules_hash_is_immutable();

-- ---------------------------------------------------------------------------
-- 2. The denormalised copies could still be ADDED to after the freeze
-- ---------------------------------------------------------------------------
--
-- 0004's triggers are `BEFORE UPDATE OR DELETE`. Nothing stopped an INSERT into
-- `league_scoring_rules` or `league_roster_slots` for a league whose rules were
-- already frozen — so a new scoring rule or an extra roster slot could appear
-- afterwards. `league_rules` stays untouched and still hashes correctly, while
-- the tables the app actually queries say something different. That is the same
-- damage as editing the rules, reached by a verb nobody guarded.
--
-- The insert that creates a league must still work, and `createLeague` writes
-- `league_rules` *before* the denormalised copies, in one transaction. So the
-- test cannot be "do rules exist" — during creation they already do.
--
-- `now()` in Postgres is transaction-start time, and `league_rules.created_at`
-- defaults to it. A rules row written by the current transaction therefore has
-- `created_at = now()`, and one frozen by any earlier transaction has
-- `created_at < now()`. That is the distinction: adding to a rule set frozen
-- *previously* is refused; writing the copies alongside the rules that were just
-- inserted is not.
--
-- This is preferred over comparing `xmin` to the current transaction id, which
-- expresses the same thing less legibly and drags in xid wraparound semantics
-- for no benefit.

CREATE FUNCTION reject_late_rule_insert() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM league_rules
     WHERE league_id = NEW.league_id
       AND created_at < now()
  ) THEN
    RAISE EXCEPTION
      '% is frozen for league %: rules cannot be added after creation',
      TG_TABLE_NAME, NEW.league_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER league_scoring_rules_no_late_insert
  BEFORE INSERT ON league_scoring_rules
  FOR EACH ROW EXECUTE FUNCTION reject_late_rule_insert();

CREATE TRIGGER league_roster_slots_no_late_insert
  BEFORE INSERT ON league_roster_slots
  FOR EACH ROW EXECUTE FUNCTION reject_late_rule_insert();

-- ---------------------------------------------------------------------------
-- 3. The draft draw could be re-forged by DELETE then INSERT
-- ---------------------------------------------------------------------------
--
-- `drafts_order_immutable` (0010) is `BEFORE UPDATE` only. Deleting the drafts
-- row and inserting a new one re-draws the order with any seed and blockhash the
-- caller likes — which is precisely the grinding attack 0010's header says four
-- mechanisms close, reached by going around all four.
--
-- It is self-limiting once picks exist, because `draft_picks` references
-- `drafts` ON DELETE RESTRICT. The window is between the draw and the first
-- pick, which is exactly when grinding an order is worth anything.

CREATE FUNCTION reject_drawn_draft_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.order_drawn_at IS NOT NULL THEN
    RAISE EXCEPTION
      'draft % has drawn its order from slot % and cannot be deleted',
      OLD.id, OLD.order_slot
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drafts_no_delete_after_draw
  BEFORE DELETE ON drafts
  FOR EACH ROW EXECUTE FUNCTION reject_drawn_draft_delete();

-- ---------------------------------------------------------------------------
-- TRUNCATE, for the tables 0018 did not cover
-- ---------------------------------------------------------------------------
--
-- Same reasoning as 0018, applied to the rest of the frozen surface. `TRUNCATE
-- teams CASCADE` wiped every draft position — bypassing
-- `teams_draft_position_immutable` — and cascaded into `league_memberships`,
-- destroying the signatures that are the only evidence members consented to the
-- rules they joined under.

CREATE FUNCTION reject_frozen_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    '% is frozen and cannot be truncated', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leagues_no_truncate
  BEFORE TRUNCATE ON leagues
  FOR EACH STATEMENT EXECUTE FUNCTION reject_frozen_truncate();

CREATE TRIGGER league_memberships_no_truncate
  BEFORE TRUNCATE ON league_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION reject_frozen_truncate();

CREATE TRIGGER teams_no_truncate
  BEFORE TRUNCATE ON teams
  FOR EACH STATEMENT EXECUTE FUNCTION reject_frozen_truncate();

CREATE TRIGGER drafts_no_truncate
  BEFORE TRUNCATE ON drafts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_frozen_truncate();

-- ---------------------------------------------------------------------------
-- What this still does not defend, deliberately
-- ---------------------------------------------------------------------------
--
-- No trigger can defend against dropping the trigger. `ALTER TABLE ... DISABLE
-- TRIGGER`, `DROP TRIGGER`, `DROP TABLE`, and `session_replication_role =
-- 'replica'` all remain available to whoever owns these tables, and that is the
-- irreducible floor rather than a gap to be closed here.
--
-- What changes is the threat these cover: a bug in a route, a careless reset
-- script, a bad migration, or a leaked DATABASE_URL used casually rather than
-- deliberately. 0004 names exactly those — "it survives a bug, a migration, or
-- someone with psql access" — and now it does.
