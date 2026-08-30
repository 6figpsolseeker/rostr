-- Where a league's rules live is written once. Issue #69.
--
-- `rules_hash` is the guarantee and `0004` already protects it: `league_rules`
-- refuses UPDATE and DELETE outright, and 0014 pins the on-chain anchor that
-- proves the hash was published. But `rules_uri` — the address a member actually
-- fetches to *read* the rules — was a plain nullable `text` column that any
-- UPDATE could move, at any time, to anywhere.
--
-- That is the gap. Repointing the URI leaves `rules_hash` untouched, so the
-- immutability check in `verifyStoredRules`, the trigger in `0004` and the
-- on-chain account all still agree. Nothing in the system notices. Meanwhile
-- every member who follows the link after the swap reads a different document
-- from the one they joined under — and the hash they would need in order to
-- catch that is the one thing the swap does not touch.
--
-- A member who verifies properly is safe: they fetch the document, hash the
-- bytes, compare to the chain. The point is that this makes the careless path
-- and the careful path disagree, silently, which is exactly the arrangement
-- `docs/RULES.md` says this project exists to remove.
--
-- **Set-once is the right rule because the URI is content-addressed.** An IPFS
-- CID is a function of the bytes, so re-pinning the same rules yields the same
-- URI and a re-pin is a no-op rather than a change. A *different* URI therefore
-- means different bytes, always — there is no legitimate reason for this column
-- to take a second value, and no need to reason case-by-case about which
-- rewrites are honest.
--
-- The one genuine exception is a re-encoding of the same content — CIDv0
-- `Qm…` against CIDv1 `bafy…` are two encodings of the same multihash, and SQL
-- cannot tell one from a substitution without a CID parser. Which one comes back
-- is an account setting on the pinning service's side rather than a property of
-- the bytes, so the request pins it: `pinataOptions: { cidVersion: 0 }` in
-- `PinataPinningService.pin`. That line is what makes this rule safe, and this
-- comment asserted it before it existed — it was added in the same change that
-- added this migration's review, which is the failure this repo names.
--
-- The escape hatch here is another migration, deliberately: moving where a
-- member's rules live should cost as much as changing the schema, because it is
-- the same kind of act.
--
-- Clearing to NULL is refused for the same reason. Otherwise the rewrite is
-- simply two statements instead of one, and a rule that a second UPDATE defeats
-- is not a rule.
--
-- Same shape as `leagues_chain_anchor_is_immutable` in 0014 and
-- `drafts_order_is_immutable` in 0010: it RAISEs rather than clamping, because
-- unlike 0043's status column there is no ten-minute ingest to keep alive here —
-- a refused pin is a retry, and a silent clamp would hide a caller that had
-- genuinely lost track of which document it was attaching.

CREATE FUNCTION leagues_rules_uri_is_set_once() RETURNS trigger AS $$
BEGIN
  IF OLD.rules_uri IS NOT NULL AND NEW.rules_uri IS DISTINCT FROM OLD.rules_uri THEN
    RAISE EXCEPTION
      'League % has its rules pinned at %, and that cannot be repointed to %',
      OLD.id, OLD.rules_uri, COALESCE(NEW.rules_uri, '(null)');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leagues_rules_uri_set_once
  BEFORE UPDATE ON leagues
  FOR EACH ROW EXECUTE FUNCTION leagues_rules_uri_is_set_once();

COMMENT ON COLUMN leagues.rules_uri IS
  'Where the canonical rule document is pinned, as an IPFS URI. Written once by '
  'setRulesUri after a successful pin and never again — see '
  'leagues_rules_uri_set_once. NULL means the rules exist and are hashed but '
  'have not been published yet, which is an ordinary state: pinning is a network '
  'call that can fail, and a league with no members yet publishes nothing.';

-- Leagues whose rules were never published. The mirror of 0014's
-- `leagues_unanchored_idx`, and a real state for the same reason: the pin is a
-- second step after creation and it can fail on its own.
CREATE INDEX leagues_unpinned_idx ON leagues (created_at) WHERE rules_uri IS NULL;
