-- A fixture is played once. One row per (league, week, phase, pairing).
--
-- `writeSchedule` counts the matchup rows a league already has, returns early if
-- there are any, and otherwise inserts the whole season with a bare `INSERT`.
-- `advancePlayoffs` has the same shape: it reads the non-`REGULAR` rows into a
-- `Set` and inserts whatever is missing. Both are check-then-act, and neither
-- had a constraint behind it — `matchups` has carried exactly one index since
-- `0005`, the plain `matchups_league_week_idx (league_id, week)`. Issue #319,
-- and item 5 of #90.
--
-- Being inside a transaction does not close it. At READ COMMITTED the count is
-- taken from a snapshot older than the inserts, so a second writer that commits
-- in between is invisible to the first and both proceed.
--
-- ## Why the regular season is the half that costs money
--
-- A duplicated *bracket* fixture is cosmetic, because `indexResults` keys a
-- `Map` on `week:home:away` in both orientations and a duplicate overwrites its
-- twin with an identical value — the ladder, the champion and the payout come
-- out the same. (`loadWeekResults` does **not** deduplicate; it is the shared
-- source that hands duplicated rows to both consumers, and the asymmetry is
-- entirely downstream of it. The issue's phrasing credits the wrong function.)
--
-- `computeStandings` does not deduplicate either, and nothing downstream of it
-- does. A duplicated `REGULAR` row counts the win twice and doubles points for
-- and against, which moves the standings, which moves the seeding, which moves
-- the bracket *and* decides the `REGULAR_SEASON` share of the pot. Nothing in
-- production code ever deletes from `matchups`, so the wrong ladder is
-- permanent.
--
-- ## Insurance, not a repair — and the priority is the other way round
--
-- The grouping query in #319 was run against production on 2026-09-19 and
-- returned nothing: no league has ever held a duplicate fixture. Traced
-- afterwards, the reason is that `writeSchedule`'s only production path runs
-- inside `recordPick`'s `SELECT … FROM drafts … FOR UPDATE`, and a second racer
-- re-reads the locked row, sees `status = 'COMPLETE'` and returns before it
-- reaches the write. `persistSchedule` is the one unlocked path into it and
-- nothing in the repo calls it.
--
-- So this closes a hole that is currently unreachable, and the repair step below
-- is expected to be a no-op for ever. It is worth having anyway because
-- `writeSchedule`'s safety lives in a different module, on a different table,
-- and nothing local asserts it — which is precisely what a refactor breaks
-- silently.
--
-- `advancePlayoffs` is the writer with an actual hole: it reads on the bare
-- connection outside any transaction, and `score-week`'s gate is
-- `if (entered || league.state === 'PLAYOFFS')`, so from round two onward every
-- tick calls it ungated. Its blast radius is the cosmetic one.
--
-- ## Why NULLS NOT DISTINCT is not a stylistic choice
--
-- `generateSchedule` emits `awayTeamId: null` for a bye, and `away_team_id` is
-- nullable to hold it. Under Postgres's default, NULLs in a unique key are
-- distinct from one another, so every bye row would satisfy an ordinary UNIQUE
-- however many copies existed — the constraint would exempt precisely the rows
-- an odd league is made of, on the table where a duplicate moves the standings.
-- `NULLS NOT DISTINCT` (PG 15+; production is 17.6 and the PGlite the tests run
-- on is 16.4, both checked) makes two byes for the same team in the same week
-- collide.
--
-- No league can currently reach `writeSchedule` with a bye — `drawDraftOrder`
-- refuses an odd field, so there is no draw, no draft and no schedule. The
-- clause costs one keyword and the alternative is a constraint that silently
-- stops covering the table the day that rule is relaxed.
--
-- It also follows that `GROUP BY` and `PARTITION BY` below are the right tools:
-- both already treat NULLs as equal, so the repair and the constraint agree
-- about what a duplicate is without either saying `IS NOT DISTINCT FROM`.
--
-- ## Why the repair is in this file, above the constraint
--
-- `0026` and `0048` deliberately carried no cleanup: a dirty row made the
-- `ALTER` fail, the runner rolled back without recording anything, and the file
-- re-ran unchanged once a human had looked. That was right there because the
-- dirty row was a *claim* or a *trade* — a record of an act, whose deletion
-- would destroy the only evidence of it.
--
-- A duplicate fixture carrying no result is a second copy of a row that already
-- exists, and is provably worthless. So this file repairs that case and refuses
-- the other one.
--
-- ## Which copy survives
--
-- Not an arbitrary `ctid`. `matchups` carries `home_milli_points`,
-- `away_milli_points`, `finalized_at` and, since `0049`,
-- `finalized_on_fallback`; deleting the copy holding them would destroy a
-- settled week's result, and a finalised week is never rescored. The ordering
-- below keeps the copy that has been scored, then finalised, then the lowest
-- `id` — the primary key, stable, rather than `ctid`, which is a physical
-- address `VACUUM` or any `UPDATE` can move.
--
-- The tiebreak never adjudicates, because of the step above it. If more than one
-- copy of a fixture carries a result this migration **raises and rolls back**,
-- naming every offending fixture. It does not guess and does not quietly keep
-- the newest: a league in that state has wrong standings *already*, which a
-- person has to look at and possibly re-settle, and no `DELETE` can decide which
-- of two recorded results the league actually played. `matchups` has no
-- `created_at`, so there is not even an ordering to appeal to.
--
-- ## Locking
--
-- `ADD CONSTRAINT … UNIQUE` builds its index under `ACCESS EXCLUSIVE`, blocking
-- reads as well as writes on `matchups`. At a few rows per league-week the build
-- is milliseconds; the risk is *waiting* to take the lock. `migrate.ts` sets
-- `SET LOCAL statement_timeout = 0` on every migration transaction so a long
-- index build cannot be cancelled halfway — and the same setting removes the
-- only bound on how long this queues behind, say, an in-flight `score-week`
-- transaction, with every later reader of `matchups` queued behind *it*.
-- `CREATE INDEX CONCURRENTLY` is not an escape: it cannot run inside a
-- transaction block, and the runner wraps every migration in one precisely so
-- the DDL and its `schema_migrations` row commit together.
--
-- **Apply this outside a scoring window.**
--
-- ## What this does not close
--
-- **Orientation.** `(A home, B away)` and `(B home, A away)` are two different
-- keys, so the constraint permits both in one week — verified against 16.4, not
-- assumed. `advancePlayoffs` checks both orientations in its own `Set` and
-- `generateSchedule` never emits a reversed pair, so nothing writes one today.
-- That `Set` is therefore **stricter than this constraint and cannot be replaced
-- by it.** Anyone reading "unique fixture" as "that pair can only be stored
-- once" will be wrong.
--
-- **`round`.** Deliberately not in the key. A bracket plays a pairing at most
-- once per phase, so two rows for one pairing in one week are a duplicate
-- whatever their `round` says, and including it would let a mislabelled round
-- reopen the hole.
--
-- **`phase` is in the key, and only ever permits more.** The three values are
-- `REGULAR`, `PLAYOFF` and `CONSOLATION` (`0005`). The same two teams in one
-- week across two phases is not a fixture this code can produce, but if it ever
-- happened it would be two different games, so refusing it is not this
-- constraint's business. `week.test.ts` copies a `REGULAR` row into `PLAYOFF` at
-- the same week with the same pair and depends on this.
--
-- **The writers.** A constraint alone converts the race from a silent duplicate
-- into an aborted transaction — which in `writeSchedule` rolls back the whole
-- season *and* the final draft pick it commits with. `ON CONFLICT DO NOTHING`
-- on both writers lands with this, and is not a migration.
--
-- `matchups_league_week_idx` is left in place, although the unique index below
-- leads with the same two columns and could serve its queries. Dropping it is a
-- separate judgement about a separate object.
--
-- Forward-only, like every migration here.

-- ---------------------------------------------------------------------------
-- 1. Refuse rather than guess.
-- ---------------------------------------------------------------------------

DO $refuse$
DECLARE
  ambiguous text;
BEGIN
  SELECT string_agg(line, E'\n' ORDER BY line)
    INTO ambiguous
    FROM (
      SELECT format(
               '  league %s, week %s, %s: %s v %s — %s of %s copies carry a result',
               league_id, week, phase, home_team_id,
               coalesce(away_team_id::text, '(bye)'), with_result, copies
             ) AS line
        FROM (
          SELECT league_id,
                 week,
                 phase,
                 home_team_id,
                 away_team_id,
                 count(*) AS copies,
                 count(*) FILTER (
                   WHERE home_milli_points IS NOT NULL
                      OR away_milli_points IS NOT NULL
                      OR finalized_at IS NOT NULL
                      OR finalized_on_fallback IS NOT NULL
                 ) AS with_result
            FROM matchups
           GROUP BY league_id, week, phase, home_team_id, away_team_id
          HAVING count(*) > 1
        ) AS duplicated
       WHERE with_result > 1
    ) AS reported;

  IF ambiguous IS NOT NULL THEN
    RAISE EXCEPTION
      'matchups holds duplicate fixtures where more than one copy carries a result:%',
      E'\n' || ambiguous
      USING HINT =
        'This migration will not choose between two recorded results. Decide by '
        'hand which row the league actually played, delete the other, check that '
        'league''s standings, then re-run the migration unchanged.';
  END IF;
END
$refuse$;

-- ---------------------------------------------------------------------------
-- 2. Drop the copies that carry nothing.
-- ---------------------------------------------------------------------------

DELETE FROM matchups
 WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    row_number() OVER (
                      PARTITION BY league_id, week, phase, home_team_id, away_team_id
                      ORDER BY (home_milli_points IS NULL AND away_milli_points IS NULL),
                               (finalized_at IS NULL),
                               (finalized_on_fallback IS NULL),
                               id
                    ) AS copy_number
               FROM matchups
           ) AS ranked
          WHERE copy_number > 1
       );

-- ---------------------------------------------------------------------------
-- 3. The constraint.
-- ---------------------------------------------------------------------------

ALTER TABLE matchups
  ADD CONSTRAINT matchups_one_fixture_per_pairing
  UNIQUE NULLS NOT DISTINCT (league_id, week, phase, home_team_id, away_team_id);

COMMENT ON CONSTRAINT matchups_one_fixture_per_pairing ON matchups IS
  'One row per league, week, phase and ordered pairing. NULLS NOT DISTINCT so a '
  'bye — away_team_id NULL, from generateSchedule in an odd league — cannot be '
  'written twice; under the default every bye row is distinct from every other '
  'and the constraint would exempt them. Ordered: a reversed pairing is a '
  'different key and is NOT refused, so advancePlayoffs'' both-orientation Set '
  'is stricter than this and must stay. Backstop for the check-then-act in '
  'writeSchedule and advancePlayoffs, which both take ON CONFLICT DO NOTHING so '
  'that a loser aborts nothing. #319.';
