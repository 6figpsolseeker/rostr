-- A league's rules, anchored on-chain.
--
-- The rules hash has always been stored here, and `docs/RULES.md` has always
-- said it goes on-chain. Until now nothing put it there, so the immutability
-- guarantee rested on this database — which is the arrangement the whole project
-- exists to replace. A row we control is not evidence.
--
-- The escrow program creates a `League` account at a PDA derived from this
-- league's `id`, holding the same `rules_hash`. That account is what a member
-- verifies against before joining, and what makes "nobody can rewrite the rules"
-- a fact rather than a promise. Both pot and free leagues are anchored: a
-- guarantee that only covers leagues with money in them is not the guarantee
-- that was advertised.
--
-- Deliberately absent: the on-chain address. It is a PDA derived from `id`, so
-- storing it would be a second copy of something already determined — and a
-- second copy is a thing that can disagree.

ALTER TABLE leagues ADD COLUMN chain_anchored_at timestamptz;
ALTER TABLE leagues ADD COLUMN chain_signature text;

-- Which chain it was anchored on. A league anchored on devnet is not anchored
-- for the purposes of a mainnet pot, and without this the two are
-- indistinguishable — the PDA is identical on every cluster, so "the account
-- exists" is not an answer on its own.
ALTER TABLE leagues ADD COLUMN chain_cluster text;

-- All three arrive together or not at all. A timestamp without the transaction
-- that produced it is an unverifiable claim, which is the shape of thing this
-- column exists to remove.
ALTER TABLE leagues ADD CONSTRAINT chain_anchored_together CHECK (
  (chain_anchored_at IS NULL AND chain_signature IS NULL AND chain_cluster IS NULL)
  OR
  (chain_anchored_at IS NOT NULL AND chain_signature IS NOT NULL AND chain_cluster IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Anchored once
-- ---------------------------------------------------------------------------
--
-- The program itself refuses a second `initialize_league` for the same id — the
-- PDA already exists, so the system program rejects it. This trigger is the
-- matching guarantee on our side: it stops the *record* being rewritten to point
-- at a different transaction, which is how a real anchor could be papered over
-- with a fake one long after the fact.
--
-- Same reasoning as `drafts_order_is_immutable` in 0010. Application-layer
-- immutability is a promise; this survives a bug, a migration, or psql.

CREATE FUNCTION leagues_chain_anchor_is_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.chain_anchored_at IS NOT NULL AND (
       NEW.chain_anchored_at IS DISTINCT FROM OLD.chain_anchored_at OR
       NEW.chain_signature   IS DISTINCT FROM OLD.chain_signature OR
       NEW.chain_cluster     IS DISTINCT FROM OLD.chain_cluster
     ) THEN
    RAISE EXCEPTION
      'League % was anchored on % in transaction %, and that cannot be rewritten',
      OLD.id, OLD.chain_cluster, OLD.chain_signature;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leagues_chain_anchor_immutable
  BEFORE UPDATE ON leagues
  FOR EACH ROW EXECUTE FUNCTION leagues_chain_anchor_is_immutable();

-- Finding leagues that were created but never anchored — a real state, because
-- anchoring is a second transaction the commissioner signs from their own
-- wallet and they can close the tab before it lands.
CREATE INDEX leagues_unanchored_idx ON leagues (created_at) WHERE chain_anchored_at IS NULL;
