-- The rules hash covers the bytes it is a hash of. Issue #294.
--
-- `0004` checks that an incoming `league_rules` row declares the hash its league
-- declares, and that is all it checks. `check_rules_hash_matches` reads
-- `NEW.hash` and never looks at `NEW.canonical` or `NEW.rule_json`, so a plain
-- INSERT at ordinary application privilege can store *any bytes at all* under a
-- correct hash — and both that trigger and the on-chain anchor accept it.
--
-- `0019` closed the sibling hole, where `leagues.rules_hash` could be rewritten
-- after the fact, and its header says so. This is the half it left open: the
-- hash was made immutable without anything tying it to the document it hashes.
--
-- Reproduced before writing this, on a database with 0001–0044 applied: a row
-- whose `canonical` and `rule_json` hold a different rule set entirely is
-- accepted; and a row whose two byte columns disagree *with each other* is
-- accepted, passes `verifyStoredRules`, matches the chain, and still serves the
-- wrong number to the lobby.
--
-- ---------------------------------------------------------------------------
-- Why it is worth a migration when there is no live exploit
-- ---------------------------------------------------------------------------
--
-- `createLeague` is the only production writer and it binds one string to both
-- columns, one line apart, from one encoder. So nothing today can produce a
-- divergent row, and this closes a hole rather than fixing a leak.
--
-- It is filed and fixed anyway for three reasons.
--
-- **Two live consumers already document the guarantee as though it held.**
-- `apps/web/src/app/api/leagues/route.ts` reads `rule_json` for the lobby's
-- seat count, draft time and buy-in under the comment *"come from the frozen
-- rule document rather than from a column, because that document is what a
-- member signs"* — and `rule_json` is a column, and not the one the hash
-- covers. `0028` reads the same column to decide what `drafts.scheduled_at` is
-- allowed to be, under a comment calling the document *"checkable by a
-- stranger"*. A stranger holds the **pinned** bytes, which are `canonical`.
-- Comments like those are how a second writer gets written.
--
-- **`0004` says the wrong column is authoritative, and cannot be corrected.**
-- Its line *"`league_rules.rule_json` remains authoritative"* was true when
-- written and is now false: `getLeagueRules` does not even SELECT that column,
-- and roughly forty-seven production call sites read `canonical`. An applied
-- migration may never be edited, so that sentence stands in the tree forever
-- and this header is the correction. It is plausibly *why* `0028` wired an
-- enforcement decision to the unhashed column.
--
-- **The window closes.** `league_rules` refuses UPDATE and DELETE, so a row
-- written before this trigger exists can never be repaired or removed — only
-- exempted. The table is effectively empty today. Once real leagues exist, this
-- migration needs a backfill story it does not need now.
--
-- ---------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------
--
-- **A second trigger, not a rewrite of `0004`'s.** `CREATE OR REPLACE` on
-- `check_rules_hash_matches` would leave `0004` describing a function body that
-- no longer runs, in a repo that treats a comment asserting something untrue as
-- a defect in its own right. The cost is that fire order now matters — see
-- below.
--
-- **Two sequential `IF`s, not one `OR`.** PostgreSQL does not guarantee the
-- evaluation order of `OR` operands. With the operands the other way round, a
-- `canonical` that is not JSON at all raises `22P02 invalid input syntax for
-- type json` from the cast instead of the byte check's own message. Sequential
-- statements make the order structural rather than incidental.
--
-- **The name is load-bearing.** Same-event triggers fire in *name* order, so
-- `league_rules_stored_bytes_match_hash` sorts after `league_rules_hash_matches`
-- and `0004` still answers the coarser question first: a row declaring the wrong
-- league's hash is reported as a hash mismatch, not as a byte mismatch. Renaming
-- this to sort earlier changes which error a caller sees. There is a test
-- pinning that order.
--
-- **`sha256(bytea)`, not `pgcrypto`.** Built in since PostgreSQL 11 and present
-- in both Supabase and PGlite; `CREATE EXTENSION pgcrypto` fails outright in
-- PGlite (`extension "pgcrypto" is not available`), which would take every
-- database-backed test in the repo down with it. Verified byte-identical to
-- `sha256Hex` in `packages/core` across ASCII, emoji, CJK, NFC and NFD accents,
-- and a real 3908-byte `encodeLeagueRules` document.
--
-- **`convert_to(…, 'UTF8')` names the encoding the hash is defined over** rather
-- than inheriting the server's. On a UTF8 database it is the identity, and it is
-- what makes the digest portable instead of a property of the deployment.
--
-- ---------------------------------------------------------------------------
-- What this does not do
-- ---------------------------------------------------------------------------
--
-- It makes the three columns agree with **each other**. It cannot know they are
-- the rules the commissioner meant: `0019` freezes `leagues.rules_hash` only
-- once a `league_rules` row exists, so a writer controlling both rows can still
-- write a self-consistent league holding rules nobody agreed to. This closes
-- divergence, not substitution.
--
-- Nor does it catch a duplicated key on its own terms. The first check catches
-- one *because the duplicate changes the bytes*, and therefore the hash. The
-- second cannot: `canonical::jsonb` normalises duplicates exactly as `rule_json`
-- does. That is acceptable rather than a gap — jsonb and JavaScript's own
-- `JSON.parse` both keep the last duplicate, so once the bytes are pinned the
-- two columns cannot disagree about anything a reader can observe.

CREATE FUNCTION check_stored_rule_bytes() RETURNS trigger AS $$
BEGIN
  -- The bytes are the bytes that were hashed.
  IF encode(sha256(convert_to(NEW.canonical, 'UTF8')), 'hex') IS DISTINCT FROM NEW.hash THEN
    RAISE EXCEPTION
      'stored rule bytes do not hash to their declared hash: league % declares %, its % canonical bytes hash to %',
      NEW.league_id, NEW.hash, length(NEW.canonical),
      encode(sha256(convert_to(NEW.canonical, 'UTF8')), 'hex')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- And the column that gets queried is the document those bytes encode.
  --
  -- Second, so that a `canonical` which is not JSON at all is refused by the
  -- check above with its own message, rather than by this cast with `22P02`.
  IF NEW.rule_json IS DISTINCT FROM NEW.canonical::jsonb THEN
    RAISE EXCEPTION
      'rule_json is not the document in canonical: league % — the queried column and the hashed column hold different rules',
      NEW.league_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Named to sort after `league_rules_hash_matches`. See the note above; this is
-- not cosmetic.
CREATE TRIGGER league_rules_stored_bytes_match_hash
  BEFORE INSERT ON league_rules
  FOR EACH ROW EXECUTE FUNCTION check_stored_rule_bytes();

COMMENT ON COLUMN league_rules.canonical IS
  'The exact bytes that were hashed, and the document that is pinned. '
  'Authoritative: getLeagueRules parses this column and nothing else, and every '
  'rule decision in the application comes from it. Checked against hash on '
  'INSERT by league_rules_stored_bytes_match_hash.';

COMMENT ON COLUMN league_rules.rule_json IS
  'The same document as canonical, parsed, so SQL can reach individual rule '
  'fields without a round trip. A convenience copy and never the source of '
  'truth — 0004 called it authoritative and that has long been false. Pinned to '
  'canonical on INSERT by league_rules_stored_bytes_match_hash, so the two '
  'cannot disagree about anything a reader can observe.';
