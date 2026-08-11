-- A player sits on one active roster per league — enforced, not asserted.
--
-- `0005` says, in its own comment above the index:
--
--     -- A player may sit on only one active roster per league at a time.
--     CREATE UNIQUE INDEX roster_entries_one_owner
--       ON roster_entries (team_id, player_id)
--       WHERE released_at IS NULL;
--
-- The comment says *per league*; the index is *per team*. Two teams in the same
-- league could each hold the same player active and nothing anywhere refused it.
-- `0005` is applied and may never be edited, so this file is the correction.
--
-- It is not theoretical. `addFreeAgent` checks league-wide ownership on `db`
-- outside its transaction and inserts inside it; `processWaivers` reads every
-- roster in the league outside its transaction and writes inside it. Two adds of
-- the same free agent at the same instant — Wednesday morning, when a whole
-- league is clicking on the same players — both passed the check and both
-- inserted. `loadRosterForWeek` and `loadWeekMatchups` arbitrate nothing, so both
-- teams then start him and both score him, and `RULES.md` §7 does not reopen a
-- finalised week. Silent, and unrecoverable after the fact.
--
-- ## Why a column and not a cleverer index
--
-- The rule spans two tables: the league of a roster entry lives on `teams`. A
-- partial unique index may not contain a subquery or a join, and neither may an
-- exclusion constraint — both are single-table. So the league has to be *on the
-- row* for any constraint to see it, exactly as `0020` had to put `league_id` on
-- `trade_vetoes` to scope a veto to its own league.
--
-- Denormalised data is only as good as what keeps it honest, so two things do:
--
--   * A **BEFORE INSERT/UPDATE trigger derives it from `teams`.** No writer
--     supplies it and no writer can get it wrong — including the eight test
--     fixtures and three production call sites that insert roster rows today,
--     none of which had to change. A column every writer must remember is a
--     column somebody eventually forgets, and the forgetting would be silent.
--   * A **composite foreign key** `(team_id, league_id) -> teams (id, league_id)`
--     pins the pair even if the trigger were ever dropped, and refuses to let a
--     team be moved between leagues while it still holds roster rows. The
--     uniqueness it references, `teams_id_league_unique`, already exists — `0020`
--     added it for the same reason.
--
-- **What it costs.** One primary-key lookup on `teams` per roster insert. Roster
-- inserts are drafts, waiver awards, free-agent adds and trades: a few thousand a
-- league a season, against a hot path of reads. The index itself is one more
-- partial unique index to maintain on the same writes.
--
-- ## Locking
--
-- Per `migrations/README.md`: the *arbitration* this index provides rests on
-- Postgres's unique-index behaviour under concurrency — the loser of a race
-- blocks on the index entry until the winner commits and then fails with 23505.
-- **PGlite is a single connection and cannot reproduce that**, so the tests here
-- assert the constraint bites, not that a race resolves. `addFreeAgent` maps the
-- 23505 to `PLAYER_TAKEN` and `processWaivers` takes a league-row lock so two
-- runs serialise; both were read rather than raced, and neither is verified by
-- the suite.
--
-- Forward-only, like every migration here.

-- ---------------------------------------------------------------------------
-- The column, backfilled
-- ---------------------------------------------------------------------------

ALTER TABLE roster_entries
  ADD COLUMN IF NOT EXISTS league_id uuid;

UPDATE roster_entries r
   SET league_id = t.league_id
  FROM teams t
 WHERE t.id = r.team_id
   AND r.league_id IS NULL;

-- ---------------------------------------------------------------------------
-- Existing data
-- ---------------------------------------------------------------------------

-- There is no production data yet, but a database that already holds rosters
-- must migrate rather than fail — and if the bug has already fired, the unique
-- index below would fail on exactly the rows it exists to prevent.
--
-- The earliest acquisition keeps the player and every later active copy is
-- released. That is the rule the system was trying to apply in the first place
-- ("first come, first served" is what free agency means), and a later duplicate
-- exists *only* because the missing index let it through. Releasing rather than
-- deleting is how this table already retires a row, so past weeks stay
-- reconstructible.
--
-- It does not repair a lineup that already started the released copy, and it
-- cannot: a finalised week is not reopened. Anything it touches should be looked
-- at by a human, which is why it is a single deliberate statement here rather
-- than an ON CONFLICT somewhere in the application.
UPDATE roster_entries r
   SET released_at = now()
 WHERE r.released_at IS NULL
   AND EXISTS (
     SELECT 1
       FROM roster_entries keeper
      WHERE keeper.league_id = r.league_id
        AND keeper.player_id = r.player_id
        AND keeper.released_at IS NULL
        AND (keeper.acquired_at, keeper.id) < (r.acquired_at, r.id)
   );

ALTER TABLE roster_entries
  ALTER COLUMN league_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- What keeps it honest
-- ---------------------------------------------------------------------------

-- Derived, never supplied. A caller's value is overwritten rather than checked:
-- there is exactly one right answer and `teams` holds it, so accepting a second
-- opinion would only create a way for the two to disagree.
CREATE FUNCTION roster_entries_league_from_team() RETURNS trigger AS $$
DECLARE
  owning_league uuid;
BEGIN
  SELECT t.league_id INTO owning_league FROM teams t WHERE t.id = NEW.team_id;
  IF owning_league IS NULL THEN
    RAISE EXCEPTION 'roster_entries.team_id % names no team', NEW.team_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.league_id := owning_league;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only the two columns that can make the pair wrong. A release — the common
-- update on this table — does not fire it.
CREATE TRIGGER roster_entries_league_derived
  BEFORE INSERT OR UPDATE OF team_id, league_id ON roster_entries
  FOR EACH ROW EXECUTE FUNCTION roster_entries_league_from_team();

ALTER TABLE roster_entries
  ADD CONSTRAINT roster_entries_team_in_league
  FOREIGN KEY (team_id, league_id) REFERENCES teams (id, league_id);

-- ---------------------------------------------------------------------------
-- The constraint the comment always claimed
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX roster_entries_one_owner_per_league
  ON roster_entries (league_id, player_id)
  WHERE released_at IS NULL;

-- Subsumed: a team is in exactly one league, so any pair of active rows sharing
-- (team, player) also shares (league, player). Dropped rather than left in place,
-- because it is the index whose comment claimed the guarantee this file is
-- adding — and a constraint that promises more than it enforces is the defect
-- that produced this migration. `roster_entries_team_idx` still covers reads of
-- a team's active roster.
DROP INDEX roster_entries_one_owner;
