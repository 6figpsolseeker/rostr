-- Correct migration 0005's account of the LOWEST_TEAM_ID tiebreaker.
--
-- `0005_teams_and_play.sql:11-13` says, of `teams.slot`:
--
--   1..N within the league, assigned at join. This is the "team id" the
--   LOWEST_TEAM_ID tiebreaker refers to: a UUID has no meaningful order, and
--   the final tiebreaker must be deterministic when money is at stake.
--
-- That is wrong. `LOWEST_TEAM_ID` sorts `teams.id` — the random UUID — in
-- `packages/core/src/season/standings.ts`. It has never read `slot`.
--
-- Migrations are forward-only and the runner refuses to start when an applied
-- file's checksum moves, so the sentence in 0005 cannot be edited and stays in
-- the tree forever. This migration is the correction, and it is written into
-- the database itself so a reader inspecting the schema is told the truth by
-- the schema rather than by whichever comment they happened to find first.
--
-- The code was not changed to match the comment, and that was a decision
-- rather than an oversight. `slot` is `count(*) + 1` at join, so the lowest
-- slot belongs to whoever joined first — in practice the commissioner, who
-- holds the league URL before anybody else can. Ranking on it would hand the
-- final tiebreaker, and with it the 1000 bps regular-season prize, to one
-- participant by construction, every season. A UUID is arbitrary, which is the
-- point: four real criteria have already come up equal by the time anything
-- reads it, so there is nothing left to be fair about — only to be neutral,
-- deterministic, and reproducible by anyone holding the published standings.

COMMENT ON COLUMN teams.id IS
  'Random v4 UUID. This is what the LOWEST_TEAM_ID tiebreaker sorts, ascending. '
  'Never client-supplied, and there is no leave-league path, so a member cannot '
  're-roll it. Corrects the claim in migration 0005.';

COMMENT ON COLUMN teams.slot IS
  'Join order, 1..N. Two uses: the domain of the seeded draft-order shuffle, and '
  'a stable ORDER BY. It is NOT the LOWEST_TEAM_ID tiebreaker input — that sorts '
  'teams.id. Migration 0005 says otherwise and is wrong.';
