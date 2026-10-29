-- A team holds at most one pending claim for a player. Issue #354.
--
-- `submitClaim` checked for an existing PENDING claim on the same player, then
-- inserted — two statements, no transaction, no lock, and no index behind the
-- check. `0005` gave `waiver_claims` only a non-unique index. So two tabs
-- pressing Claim at once both passed `DUPLICATE_CLAIM` and both inserted, and on
-- Wednesday one was awarded and the other recorded a loss the manager never
-- meant to file.
--
-- The index makes the loser a unique violation, which `submitClaim` reports as
-- the same `DUPLICATE_CLAIM` the check already returns.
--
-- **Partial on PENDING**, because a claim that was withdrawn, failed or awarded
-- does not stop the team claiming the player again. **`team_id` without
-- `league_id`**: `0048` already ties a team to its league, so the team is the
-- whole key.
--
-- ## Duplicates already in the table
--
-- The race was reachable before this, so a pending pair may already exist, and
-- `CREATE UNIQUE INDEX` would refuse to build over it. Each pair keeps its
-- earliest claim — the one the manager made first — and the later ones are
-- marked CANCELLED, as if withdrawn. Nothing is deleted. They resolve to the
-- same player for the same team, so keeping one changes no outcome except the
-- phantom loss this exists to remove.

UPDATE waiver_claims c
   SET state = 'CANCELLED'
  FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY team_id, add_player_id ORDER BY created_at, id
           ) AS n
      FROM waiver_claims
     WHERE state = 'PENDING'
  ) dup
 WHERE c.id = dup.id AND dup.n > 1;

CREATE UNIQUE INDEX waiver_claims_one_pending_per_player
  ON waiver_claims (team_id, add_player_id)
  WHERE state = 'PENDING';
