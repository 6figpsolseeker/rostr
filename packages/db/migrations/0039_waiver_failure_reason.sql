-- Why a waiver claim lost.
--
-- `resolveWaiverClaims` has always produced a `ClaimFailure` — PLAYER_TAKEN,
-- ROSTER_FULL, ALREADY_ROSTERED, DROP_NOT_ON_ROSTER — and `processWaivers`
-- discarded it, writing only the state. So a manager whose claim failed was told
-- FAILED and nothing else, and the four reasons are not interchangeable: one
-- says somebody outranked you, one says your own roster had no room, and one
-- says the player you offered to drop was already gone.
--
-- The distinction is the whole value of the screen. "Somebody with better
-- priority took him" is the system working as the rules describe; "your roster
-- was full" is a mistake the manager could have avoided and will make again
-- unless told.
--
-- **Stored rather than re-derived.** The resolver is pure and replayable, so in
-- principle a run could be recomputed to explain itself — and it must not be.
-- Replaying needs the rosters and the wire *as they were*, and both have moved
-- on by the time anybody reads the result: a claim that lost to a rival would
-- silently start reporting ROSTER_FULL once the winner's roster filled up. A
-- settled outcome is a fact about a moment, and this repo already records
-- `priority_at_claim` for exactly the same reason.
--
-- Free-text rather than an enum. A new failure mode should not need a migration
-- to be recordable, and nothing branches on this in SQL — the value is read by
-- one screen and mapped to a sentence in TypeScript, where an unknown one falls
-- back to the plain word.
ALTER TABLE waiver_claims
  ADD COLUMN failure_reason text;

-- An awarded claim has no reason to carry, and a reason on a winner would be a
-- row nothing could render. PENDING is unresolved and carries none either.
ALTER TABLE waiver_claims
  ADD CONSTRAINT waiver_claims_reason_only_on_failure
  CHECK (failure_reason IS NULL OR state = 'FAILED');
