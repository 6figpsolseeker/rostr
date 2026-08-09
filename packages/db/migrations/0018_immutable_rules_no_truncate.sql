-- Immutable rule tables must also refuse TRUNCATE.
--
-- The immutability triggers in 0004 are BEFORE UPDATE OR DELETE ... FOR EACH ROW.
-- Row-level triggers do not fire on TRUNCATE, so `TRUNCATE league_rules` (or the
-- two denormalised copies) would wipe the hashed rules without any trigger
-- firing — while the on-chain hash and members' signatures still point at them.
-- 0007 revokes TRUNCATE from the Data-API roles, but the app connects as the
-- owning role, which is not stopped by that grant. A statement-level trigger is.

CREATE FUNCTION reject_rule_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'league rules are immutable and cannot be truncated';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER league_rules_no_truncate
  BEFORE TRUNCATE ON league_rules
  FOR EACH STATEMENT EXECUTE FUNCTION reject_rule_truncate();

CREATE TRIGGER league_scoring_rules_no_truncate
  BEFORE TRUNCATE ON league_scoring_rules
  FOR EACH STATEMENT EXECUTE FUNCTION reject_rule_truncate();

CREATE TRIGGER league_roster_slots_no_truncate
  BEFORE TRUNCATE ON league_roster_slots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_rule_truncate();
