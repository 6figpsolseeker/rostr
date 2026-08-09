-- Records that a league's final standings were posted on-chain and, per prize,
-- that the payout was executed. Mirrors the program's `FinalStandings` account
-- (frozen winners + fee/prize payment flags) so the web app can show progress
-- without re-deriving it, and so a server route can refuse a duplicate payout.
--
-- The "single trusted input" to settlement is the standings themselves: the
-- settle authority (the league creator; rotatable to the Squads multisig) names
-- the five winners off-chain. Everything else — the split math, the fee, the
-- per-winner membership checks, idempotency — is enforced by the program.

CREATE TABLE IF NOT EXISTS league_onchain_settlements (
  league_id           UUID          NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  standings_signature TEXT          NOT NULL,
  cluster             TEXT          NOT NULL,
  posted_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  fee_paid            BOOLEAN       NOT NULL DEFAULT FALSE,
  -- One row per prize index (0 = champion … 4 = third place).
  paid_prizes         INTEGER[]     NOT NULL DEFAULT '{}',
  PRIMARY KEY (league_id)
);

COMMENT ON TABLE league_onchain_settlements IS
  'On-chain record of a league''s frozen final standings and payout progress.';
