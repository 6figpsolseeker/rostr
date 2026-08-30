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
-- allowed to be, under a comment saying that comparing against the frozen
-- document is *"what keeps this checkable by a stranger"*. A stranger holds the
-- **pinned** bytes, which are `canonical`.
-- Comments like those are how a second writer gets written.
--
-- **`0004` says the wrong column is authoritative, and cannot be corrected.**
-- Its line *"`league_rules.rule_json` remains authoritative"* was true when
-- written and is now false: `getLeagueRules` does not even SELECT that column,
-- and roughly forty-seven production call sites read `canonical`. An applied
-- migration may never be edited, so that sentence stands in the tree forever
-- and this header is the correction.
--
-- (An earlier draft guessed that line was *why* `0028` wired an enforcement
-- decision to the unhashed column. Cut: `0028` gives its own reason — that
-- `rule_json` "is itself immutable by trigger (0004)" — and never cites the
-- authority claim. Attributing a motive to another commit is not something to
-- put in a file that can never be edited.)
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
-- **Sequential `IF`s, not one `OR`.** PostgreSQL does not guarantee the
-- evaluation order of `OR` operands, so a compound condition would leave which
-- message you get up to the planner. Sequential statements make the order
-- structural. The explicit `IS NOT JSON` check exists for the same reason and is
-- not redundant with them: a correct hash over bytes that are not JSON passes
-- the first check and would otherwise reach the cast.
--
-- **The name is load-bearing, and for more than the message.** Same-event
-- triggers fire in *name* order — byte order, not collation, so it is stable
-- across locales — and `league_rules_stored_bytes_match_hash` sorts after
-- `league_rules_hash_matches`, so `0004` still answers the coarser question
-- first: a row declaring the wrong league's hash is reported as a hash mismatch
-- rather than a byte mismatch. There is a test pinning that.
--
-- For *this* pair the order only decides the message, since neither function
-- modifies `NEW`. It decides correctness the moment any `BEFORE INSERT` trigger
-- that *does* modify `NEW` is added at any sort position: one sorting after this
-- can rewrite `canonical` and `rule_json` after both checks have passed, and one
-- sorting between the two can rewrite `hash` after `0004` has accepted it.
-- Demonstrated, both of them. Adding a mutating trigger to this table is
-- therefore not a local change.
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
-- third cannot: `canonical::jsonb` normalises duplicates exactly as `rule_json`
-- does. That is acceptable rather than a gap — jsonb and JavaScript's own
-- `JSON.parse` both keep the last duplicate, so a duplicate that survived would
-- not change what either reader sees.
--
-- An earlier draft of this header claimed that, once the bytes are pinned, the
-- two columns "cannot disagree about anything a reader can observe". **Review
-- falsified it.** jsonb equality is *numeric* equality, so `{"a":1}` and
-- `{"a":1.0}` were equal to the original check while `->> 'a'` answered `1` and
-- `1.0` — and both consumers cast that result, so `0028` and the lobby query
-- would have failed with `invalid input syntax for type bigint` on a row this
-- trigger had accepted. Fail-closed, and still wrong. Comparing the rendered
-- text on both sides closes it, which is why the third check reads the way it
-- does rather than the obvious way.

-- The one assumption this migration cannot verify from inside the repo, turned
-- into a checked fact at deploy time.
--
-- `convert_to(…, 'UTF8')` is now load-bearing for whether a league can be
-- created at all, and its correctness rests on the digest being taken over the
-- same bytes Node hashed. On a UTF8 server that is the identity and was proven
-- exhaustively — every one of the 1,112,064 Unicode code points agrees with
-- `sha256Hex`. On a non-UTF8 server the round trip is lossless for anything
-- representable, so it should still hold, but "should" is reasoning rather than
-- a test, and no other check in this repo would notice if it did not.
--
-- Supabase provisions UTF8 and PGlite has no other encoding, so this refuses
-- nothing that exists today. It fails the migration loudly on a deployment where
-- the assumption is untrue, which is far better than hashing quietly wrong.
DO $$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION
      'league rule hashing requires a UTF8 database; this one is %',
      current_setting('server_encoding');
  END IF;
END;
$$;

CREATE FUNCTION check_stored_rule_bytes() RETURNS trigger AS $$
BEGIN
  -- Let the column's own NOT NULL answer for a null.
  --
  -- This trigger fires first, so without the early-out it reports "bytes do not
  -- hash" with a `<NULL>` length — burying `null value in column "canonical"
  -- violates not-null constraint`, which is the useful message. Unreachable from
  -- `createLeague`; it costs one line to not mislead whoever does reach it.
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

  -- Those bytes are JSON, checked before anything casts them.
  --
  -- Without this, bytes that are not JSON *and* carry a correct hash reach the
  -- cast below and surface as a raw `22P02 invalid input syntax for type json` —
  -- which is fail-closed but says nothing about rules. Review found that case;
  -- an earlier draft of this file claimed the clause order alone removed it, and
  -- clause order only removes it when the hash is wrong too.
  IF NEW.canonical IS NOT JSON THEN
    RAISE EXCEPTION
      'canonical is not JSON: league % — the hashed bytes are not a rule document',
      NEW.league_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- And the column that gets queried is the document those bytes encode.
  --
  -- Compared as **rendered jsonb text on both sides**, not as jsonb. jsonb
  -- equality is *numeric* equality, so `{"a":1}` and `{"a":1.0}` are equal to it
  -- while `->>` answers `1` and `1.0` — and both consumers cast that result, so
  -- the two columns can hold documents a reader distinguishes. Rendering both
  -- through jsonb normalises key order and whitespace, which is what makes an
  -- honest row pass however `rule_json` was written, while pinning the spelling
  -- of every number.
  --
  -- `NEW.rule_json::text IS DISTINCT FROM NEW.canonical` would be wrong: jsonb
  -- does not round-trip. It re-renders with a space after every colon and orders
  -- keys by length then bytes, while the canonical encoder emits no whitespace
  -- and orders by code unit. That comparison refuses every honest league.
  IF NEW.rule_json::text IS DISTINCT FROM NEW.canonical::jsonb::text THEN
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
  'Authoritative: getLeagueRules parses this column and nothing else, so every '
  'rule decision reached through it comes from here. Two production readers go '
  'to rule_json instead and are named in this migration''s header — do not read '
  'this comment as saying there are none. Checked against hash on INSERT by '
  'league_rules_stored_bytes_match_hash.';

COMMENT ON COLUMN league_rules.rule_json IS
  'The same document as canonical, parsed, so SQL can reach individual rule '
  'fields without a round trip. A convenience copy and never the source of '
  'truth — 0004 called it authoritative and that has long been false. Pinned to '
  'canonical on INSERT by league_rules_stored_bytes_match_hash, so the two '
  'cannot disagree about anything a reader can observe.';
