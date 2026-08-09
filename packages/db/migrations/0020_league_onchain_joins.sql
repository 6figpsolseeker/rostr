-- Record that a member has joined a league on-chain.
--
-- Fixes rostr issue #26: the application's join path recorded a membership in
-- Postgres but never invoked the program's `join_league` instruction, so the
-- on-chain `Membership` PDA was never created and `deposit`/`refund_stake` were
-- unreachable. This table is the DB-side audit trail for the on-chain half: the
-- member signs `join_league` from their own wallet, the server reads the
-- `Membership` PDA back (verify-don't-trust, like the anchor record), and writes
-- the result here.
--
-- It parallels `league_memberships` (the db-side consent) but is deliberately a
-- separate table: the two are independent facts. A member can be in Postgres but
-- not on-chain, or vice versa mid-flow; keeping them apart means each can be
-- checked on its own, and a failure in one does not corrupt the other.
--
-- One row per (league, wallet). The unique constraint makes a re-sent signature
-- idempotent rather than a duplicate record — re-posting after a lost response
-- is the ordinary case.

CREATE TABLE league_onchain_joins (
  league_id      uuid        NOT NULL REFERENCES leagues (id),
  wallet_address text        NOT NULL,
  signature      text        NOT NULL,
  cluster        text        NOT NULL,
  joined_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (league_id, wallet_address)
);

COMMENT ON TABLE league_onchain_joins IS
  'Audit trail for a member having joined a league on-chain (program join_league).';
