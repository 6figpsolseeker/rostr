-- Record a member's on-chain stake lifecycle: deposit and (after the timelock)
-- refund.
--
-- Fixes rostr issue #27: the program exposes `deposit` and `refund_stake`, but
-- the app had no client or UI wiring for them, so pot leagues could not take or
-- return money. This table is the DB-side audit trail for those two on-chain
-- halves, mirroring `league_onchain_joins` (issue #26).
--
-- The server does not take the client's word for a stake: the deposit/refund
-- verify routes read the `Membership` PDA back (deposited > 0, refunded == true)
-- before writing here. The signatures are audit breadcrumbs, not proof.
--
-- One row per (league, wallet). Deposit and refund each upsert their own
-- columns, so a re-post after a lost response is idempotent rather than a
-- duplicate.

CREATE TABLE league_onchain_stakes (
  league_id            uuid        NOT NULL REFERENCES leagues (id),
  wallet_address       text        NOT NULL,

  deposited_base_units text,
  deposited_signature  text,
  deposited_cluster    text,
  deposited_at         timestamptz,

  refunded_at          timestamptz,
  refund_signature     text,
  refund_cluster       text,

  PRIMARY KEY (league_id, wallet_address)
);

COMMENT ON TABLE league_onchain_stakes IS
  'Audit trail for a member depositing into and refunding from a league pot on-chain.';
