-- A manager ranks their own pending waiver claims. Issue #125.
--
-- A team's own claims were tried in the order it filed them — `created_at`,
-- from the database clock. ESPN, Sleeper and Yahoo all let a manager drag
-- their pending claims into the order they want, and filing order was only an
-- approximation of that: claim your insurance pick on Monday, the breakout
-- back on Tuesday, and filing order hands you the insurance pick. The one way
-- to change it was to withdraw and re-file.
--
-- `claim_rank` is that order, 1 tried first. Priority still decides every
-- contest *between* teams; rank only orders one team's own claims, and a tie
-- falls through to `created_at`, then `id`.
--
-- ## No unique index, deliberately
--
-- #125 called duplicate ranks a trap because they "bring back the original
-- bug" — and they would have, while a tie fell through to a random UUID. It no
-- longer does: a tie falls to `created_at`, which is deterministic, so a
-- duplicate rank costs nothing. A unique index would cost a great deal:
-- Postgres checks a non-deferrable unique index row by row, so the reorder that
-- swaps two ranks fails on its first row, and a partial unique index cannot be
-- made deferrable.
--
-- Two concurrent `submitClaim`s from one team can therefore tie on max+1. That
-- is expected and harmless — the tie resolves by filing time, which is what the
-- two claims would have had anyway.
--
-- ## Nullable, and NULL sorts last
--
-- Every claim `submitClaim` writes from now on carries a rank. NULL is a claim
-- written by code that predates this column, in the window between running this
-- migration and deploying the code that reads it. Those sort last — after even a
-- ranked claim filed later, because `max(claim_rank)` ignores them. So a claim
-- filed in that window drops behind its team's newer ones. Run this migration
-- and deploy the code together and the window is empty.
--
-- ## The backfill
--
-- PENDING claims only, numbered per team in exactly the order the resolver
-- already tried them: `created_at`, then `id`. Settled claims stay NULL —
-- nothing reads a rank once a claim is no longer pending, except to sort the
-- results panel, which falls back to `created_at` exactly as it does today.
--
-- ## Locking lives in the code, and cannot be tested here
--
-- `reorderClaims` takes the league row FOR SHARE, then the team's pending claim
-- rows FOR UPDATE in id order, before it writes. That is what serialises a
-- reorder against the waiver run, which holds the league FOR UPDATE and every
-- pending claim FOR UPDATE. PGlite has one connection, so no test in this repo
-- can show either wait; see the comment on `reorderClaims`.

ALTER TABLE waiver_claims
  ADD COLUMN claim_rank integer CHECK (claim_rank > 0);

UPDATE waiver_claims c
   SET claim_rank = ranked.n
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY team_id ORDER BY created_at, id) AS n
      FROM waiver_claims
     WHERE state = 'PENDING'
  ) ranked
 WHERE c.id = ranked.id;
