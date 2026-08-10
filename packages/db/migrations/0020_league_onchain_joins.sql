-- Record that a member has joined a league on-chain.
--
-- Fixes rostr issue #26: the application's join path recorded a membership in
-- Postgres but never invoked the program's `join_league` instruction, so the
-- on-chain `Membership` PDA was never created and `deposit`/`refund_stake` were
-- unreachable. This table is the DB-side audit trail for the on-chain half: the
-- member signs `join_league` from their own wallet, the server reads the
-- `Membership` PDA back before recording anything, and writes the result here.
--
-- It parallels `league_memberships` (the db-side consent) but is deliberately a
-- separate table: the two are independent facts. A member can be in Postgres but
-- not on-chain mid-flow; keeping them apart means each can be checked on its own
-- and a failure in one does not corrupt the other.
--
-- `user_id` and `wallet_address` are both recorded, and this is the point of the
-- table rather than a convenience. Without `user_id` the row cannot say *whose*
-- join it is, so the on-chain fact could never be reconciled against the consent
-- that is supposed to sit behind it — `league_memberships` carries the same pair
-- (its `wallet_id` FK plus `user_id`), and the two have to be comparable.
--
-- **This row is not write-once, unlike the chain anchor in 0014.** There is
-- exactly one anchoring transaction per league, so that one can be frozen; here
-- a re-post after a lost response is the ordinary case and must succeed, so the
-- row is keyed on (league, wallet) and rewritten. What keeps that safe is
-- authorisation rather than immutability: the route derives the wallet from the
-- caller's own `league_memberships` row, so a caller can only ever write their
-- own record. Do not "fix" this by adding an immutability trigger without first
-- giving the retry path somewhere else to go.

CREATE TABLE league_onchain_joins (
  league_id      uuid        NOT NULL REFERENCES leagues (id) ON DELETE RESTRICT,
  wallet_address text        NOT NULL,
  user_id        uuid        NOT NULL REFERENCES users (id),
  signature      text        NOT NULL,
  cluster        text        NOT NULL,
  joined_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (league_id, wallet_address)
);

-- The reconciliation query this table exists to make possible: consent rows in
-- `league_memberships` with no on-chain half yet. Without an index that is a
-- sequential scan per league, and it is meant to be cheap enough to run often.
CREATE INDEX league_onchain_joins_user_idx ON league_onchain_joins (league_id, user_id);

COMMENT ON TABLE league_onchain_joins IS
  'Audit trail for a member having joined a league on-chain (program join_league).';
