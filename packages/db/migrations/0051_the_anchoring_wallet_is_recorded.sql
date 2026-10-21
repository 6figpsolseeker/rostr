-- The wallet that anchored a league, recorded, because it is now part of the
-- league's on-chain address.
--
-- `0014` said the on-chain address was "a PDA derived from `id`" and so needed no
-- column. That derivation was the bug. League ids are public — `GET /api/leagues`
-- lists unanchored ones and every invite link carries one — so a stranger could
-- send `initialize_league` for somebody else's id first. There is no `close`, so
-- the real league could then never be anchored (`HASH_MISMATCH` for ever), or,
-- with a copy of its rules, the stranger became its on-chain commissioner.
--
-- The program now seeds a league as `[b"league", id, commissioner]`, where
-- `commissioner` is the wallet that paid for `initialize_league` and had to sign
-- it. A stranger's account lands at an address derived from their own key, which
-- nothing reads. But the address can no longer be derived from `id` alone: every
-- reader needs the wallet, and a commissioner may hold several, so it has to be
-- the one that actually anchored — recorded here, once, by the anchor route after
-- it has checked the wallet is one of the commissioner's own verified ones.
--
-- Text, not a foreign key to `wallets`. The address is what the PDA depends on,
-- for as long as the account exists; a `wallets` row can go with its user.
--
-- ## Leagues anchored before this
--
-- Their accounts sit at the old `[b"league", id]` address, which the program no
-- longer derives, so nothing on-chain can be done with them — and their column
-- stays NULL for ever, because no wallet seeds that address. Readers treat NULL on
-- an anchored league as "anchored under the old program" and refuse every
-- on-chain step rather than guess.
--
-- **That includes their vaults.** `refund_stake` addresses the league by the new
-- seeds, so a stake sitting in an old-seed vault can never be refunded once the
-- program is upgraded in place. Counted on-chain, not from these rows, on
-- 2026-10-20: devnet held four old-seed League accounts, and one of them
-- (`f38182b9-…`) held two unrefunded test stakes, 10 devnet USDC, whose season was
-- marked started — so no refund could open before the 2027-02-20 timelock. The
-- owner's own test wallets; stranding them was accepted. Nothing was on mainnet.
-- **Never change the League seeds in place on a program holding real deposits**:
-- deploy a new program id and leave the old one running for its refunds.
--
-- That is why this is a trigger and not an extension of `0014`'s
-- `chain_anchored_together` CHECK. A CHECK is evaluated on every UPDATE of the
-- row, so a legacy league would fail its next unrelated write — a state change,
-- say — and be bricked by the migration meant to protect it. The trigger looks
-- only at the moment of anchoring — an UPDATE that sets the anchor, or an INSERT
-- that arrives already anchored — and at every change afterwards.
--
-- `0014` also said the program refuses a second `initialize_league` for the same
-- id. That now holds per wallet only: each of a commissioner's wallets can create
-- one, which is why `recordChainAnchor` is conditional and the wallet write-once.
--
-- Who controls this wallet controls the two commissioner instructions,
-- `start_season` and `initialize_scores`, and nothing that changes a term or moves
-- a token. The key is fixed at anchoring and the program has no instruction to
-- change it, so taking over the commissioner's *account* here gains nothing
-- on-chain.

ALTER TABLE leagues ADD COLUMN chain_commissioner text;

-- A wallet with no anchor beside it is a claim about a transaction that did not
-- happen.
ALTER TABLE leagues ADD CONSTRAINT chain_commissioner_needs_anchor CHECK (
  chain_commissioner IS NULL OR chain_anchored_at IS NOT NULL
);

-- Shape only — base58, the length of an ed25519 key. Whether it is *this*
-- commissioner's wallet is the route's question, and it asks it of `wallets`.
ALTER TABLE leagues ADD CONSTRAINT chain_commissioner_is_base58 CHECK (
  chain_commissioner IS NULL OR chain_commissioner ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
);

CREATE FUNCTION leagues_chain_commissioner_is_bound() RETURNS trigger AS $$
BEGIN
  -- Anchoring now has to say who anchored. Without the wallet the address cannot
  -- be derived, so an anchor recorded without one is an anchor nobody can use.
  -- On an INSERT there is no OLD row, and a row arriving already anchored is
  -- the same moment of anchoring as an UPDATE that sets it.
  IF (TG_OP = 'INSERT' OR OLD.chain_anchored_at IS NULL)
     AND NEW.chain_anchored_at IS NOT NULL
     AND NEW.chain_commissioner IS NULL THEN
    RAISE EXCEPTION
      'League % cannot be recorded as anchored without the wallet that anchored it',
      NEW.id;
  END IF;

  -- And once anchored it never moves — including from NULL, which is what keeps
  -- a legacy league from being "repaired" with a wallet that never seeded it.
  IF TG_OP = 'UPDATE'
     AND OLD.chain_anchored_at IS NOT NULL
     AND NEW.chain_commissioner IS DISTINCT FROM OLD.chain_commissioner THEN
    RAISE EXCEPTION
      'League % was anchored by %, and that cannot be rewritten',
      OLD.id, coalesce(OLD.chain_commissioner, 'an unrecorded wallet');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leagues_chain_commissioner_bound
  BEFORE INSERT OR UPDATE ON leagues
  FOR EACH ROW EXECUTE FUNCTION leagues_chain_commissioner_is_bound();
