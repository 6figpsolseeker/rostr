-- A league's season, declared started on-chain.
--
-- The escrow program has had `start_season` since the failed-league refund
-- landed (#170) and **nothing in the app ever sent it**. That is not a missing
-- feature, it is an open door: `refund_stake` has two ways in, and `started` is
-- the only thing separating them.
--
--     timelock_open = now >= refund_unlock_at            -- months away
--     failed_open   = !started && now >= start_deadline  -- draft time + 48h
--
-- A pot league that drafted successfully but was never marked started stays on
-- the second schedule. Forty-eight hours after its draft time, any member can
-- withdraw their entire stake — while keeping their roster, their place in the
-- standings, and their claim on the pot — and play out the season with nothing
-- at risk. That is exactly the outcome the timelock exists to prevent, and it
-- was reachable on every pot league that ever drafted.
--
-- ## Why the fact is recorded here rather than read from the chain
--
-- `drawDraftOrder` is the check that closes it, and it runs inside a
-- transaction in `@rostr/db` — a package with no RPC client, no escrow
-- dependency, and a test suite that runs against PGlite with no network. An
-- account read in the middle of that transaction would hold a row lock across a
-- network round trip, and would make the one function that decides whether a
-- league may draft untestable without a validator.
--
-- So this column is the chain's answer, **recorded** — written only after
-- `/api/leagues/[id]/start-season` has read `League.started` back off the
-- account, exactly as `league_onchain_stakes` is written only after `/deposit`
-- has read `Membership.deposited`. The same shape, for the same reason.
--
-- Deliberately absent: the deadline. It is `startDeadlineFor(scheduledAt)` from
-- the frozen rules, so storing it would be a second copy of something already
-- determined — and a second copy is a thing that can disagree. `0028` was added
-- because exactly that had happened to the draft time.

ALTER TABLE leagues ADD COLUMN season_started_at timestamptz;
ALTER TABLE leagues ADD COLUMN season_start_signature text;
ALTER TABLE leagues ADD COLUMN season_start_cluster text;

-- All three or none, like the anchor above. A timestamp with no transaction
-- behind it is an unverifiable claim, which is the shape of thing these columns
-- exist to remove; and the cluster matters as much here as it does there,
-- because the PDA is byte-identical on every chain, so a devnet `start_season`
-- and a mainnet one are indistinguishable without it.
ALTER TABLE leagues ADD CONSTRAINT season_started_together CHECK (
  (season_started_at IS NULL AND season_start_signature IS NULL AND season_start_cluster IS NULL)
  OR
  (season_started_at IS NOT NULL AND season_start_signature IS NOT NULL AND season_start_cluster IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Started once
-- ---------------------------------------------------------------------------
--
-- `League.started` is set once by the program and never unset — there is no
-- instruction that clears it. This is the matching guarantee on our side.
--
-- It is not about the draw, which the write-once draw trigger already protects.
-- It is about the *record*: a row that could be re-pointed at a different
-- transaction, or cleared, is a row that could be made to disagree with the
-- chain long after anybody was watching. The chain would still refuse a second
-- `start_season`, so a rewritten record could only ever be a lie about which
-- transaction started this season, or about whether one did.
--
-- Same reasoning as `leagues_chain_anchor_is_immutable` in 0014, and a separate
-- trigger rather than an extra clause in that one so each raises the message
-- that fits what it caught.

CREATE FUNCTION leagues_season_start_is_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.season_started_at IS NOT NULL AND (
       NEW.season_started_at      IS DISTINCT FROM OLD.season_started_at OR
       NEW.season_start_signature IS DISTINCT FROM OLD.season_start_signature OR
       NEW.season_start_cluster   IS DISTINCT FROM OLD.season_start_cluster
     ) THEN
    RAISE EXCEPTION
      'League % declared its season started on % in transaction %, and that cannot be rewritten',
      OLD.id, OLD.season_start_cluster, OLD.season_start_signature;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leagues_season_start_immutable
  BEFORE UPDATE ON leagues
  FOR EACH ROW EXECUTE FUNCTION leagues_season_start_is_immutable();
