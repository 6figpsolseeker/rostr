-- One copy of the rule document, not two. Issue #300.
--
-- `league_rules` stored the document twice: `canonical`, the exact bytes that
-- were hashed, signed, pinned and anchored, and `rule_json`, the same document
-- as jsonb so SQL could reach a field without a JSON.parse. `0045` made the two
-- agree on INSERT. This removes the second, so there is nothing left to agree.
--
-- `0004` calls `rule_json` authoritative and `0045` carries the correction.
-- Both files are applied and cannot be edited. After this migration the column
-- they describe does not exist.
--
-- The three readers move to `canonical::jsonb` in the same commit: the lobby
-- listing (`apps/web/src/app/api/leagues/route.ts`), the empty-slot notice in
-- `packages/db/src/notifications.ts`, and `0028`'s draft-clock trigger below.
--
-- ---------------------------------------------------------------------------
-- Two functions are replaced, and their original files now describe old bodies
-- ---------------------------------------------------------------------------
--
-- `CREATE OR REPLACE` on `0028`'s and `0045`'s trigger functions. The trigger
-- names, events and fire order are unchanged, so `0045`'s note about name order
-- still holds. What changes is one column reference in the first and one check
-- in the second. Searching either function's name finds this file.
--
-- ---------------------------------------------------------------------------
-- What the jsonb column was enforcing without saying so
-- ---------------------------------------------------------------------------
--
-- A jsonb column refuses text Postgres's json parser accepts and its jsonb
-- parser does not: an escaped NUL (`\u0000`) is the known case. `canonical` is
-- text and would take it. Every reader now casts `canonical::jsonb`, so a row
-- holding one would fail each of them, and the lobby query lists every public
-- league in one statement, so one such row would fail it for everybody. The
-- byte check therefore casts on INSERT, which refuses the row exactly where the
-- column used to.

CREATE OR REPLACE FUNCTION check_stored_rule_bytes() RETURNS trigger AS $$
BEGIN
  -- Let the column's own NOT NULL answer for a null. See 0045.
  IF NEW.canonical IS NULL THEN
    RETURN NEW;
  END IF;

  -- The bytes are the bytes that were hashed.
  IF encode(sha256(convert_to(NEW.canonical, 'UTF8')), 'hex') IS DISTINCT FROM NEW.hash THEN
    RAISE EXCEPTION
      'stored rule bytes do not hash to their declared hash: league % declares %, its % canonical bytes hash to %',
      NEW.league_id, NEW.hash, length(NEW.canonical),
      encode(sha256(convert_to(NEW.canonical, 'UTF8')), 'hex')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Those bytes are JSON, checked before anything casts them. See 0045.
  IF NEW.canonical IS NOT JSON THEN
    RAISE EXCEPTION
      'canonical is not JSON: league % — the hashed bytes are not a rule document',
      NEW.league_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- And they are jsonb, because every reader casts them to it. Raises
  -- "unsupported Unicode escape sequence" for an escaped NUL, as the dropped
  -- column did.
  PERFORM NEW.canonical::jsonb;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION drafts_scheduled_at_matches_frozen_rules() RETURNS trigger AS $$
DECLARE
  frozen bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at THEN
    RAISE EXCEPTION
      'Draft % has a scheduled time frozen at league creation; it cannot be moved',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- `canonical`, the bytes members signed and a stranger can fetch from the
  -- pin. `0028` read `rule_json` here.
  SELECT (canonical::jsonb -> 'draft' ->> 'scheduledAt')::bigint INTO frozen
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

-- DDL fires no row triggers, so `league_rules_immutable` (0004) and the
-- TRUNCATE guard (0018) do not see this. No index, view or constraint names
-- the column.
ALTER TABLE league_rules DROP COLUMN rule_json;

COMMENT ON COLUMN league_rules.canonical IS
  'The exact bytes that were hashed, and the document that is pinned. The only '
  'copy of the rules: SQL that needs a field casts canonical::jsonb. Checked on '
  'INSERT by league_rules_stored_bytes_match_hash: it must hash to hash, and it '
  'must be valid JSON that casts to jsonb.';
