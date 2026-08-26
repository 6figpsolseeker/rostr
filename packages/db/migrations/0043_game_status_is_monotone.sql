-- The box score becomes a second writer of games.status, so FINAL has to become
-- a property of the column rather than a habit of one writer. Issue #256.
--
-- Until now `syncGames` was the only thing that wrote this column, from a daily
-- cron at 09:20 UTC — 05:20 Eastern, an hour at which no NFL game has ever been
-- in progress. So no box score was ever read while a game was being played, and
-- Sunday's slate first reached `stat_lines` on Monday morning.
--
-- `syncBoxScores` now writes it too, from a response it was already paying for.

-- The vendor's own wording, verbatim and unmapped.
--
-- Evidence, never control flow. `mapGameStatus` recognises three live spellings
-- and all three are guesses: IN_PROGRESS has never been observed from any Tank01
-- endpoint, and an unrecognised string falls through to SCHEDULED. docs/TANK01.md
-- says to switch to the numeric code "once the in-progress and postponed codes
-- are seen", and the only place to see them is a live Sunday — of which there is
-- exactly one before the season starts.
--
-- So this records the answer rather than relying on somebody remembering to run
-- a probe at 17:30 UTC on 13 September. Both halves are captured because the
-- claim that the code is the stable one has been checked against two values out
-- of an unknown vocabulary, and a string alone cannot settle it.
ALTER TABLE games ADD COLUMN provider_status text;
ALTER TABLE games ADD COLUMN provider_status_code text;

COMMENT ON COLUMN games.provider_status IS
  'The provider''s verbatim gameStatus from the last successful box-score read. '
  'Evidence only — nothing keys on it. Written so a live Sunday records the '
  'in-progress and postponed wordings that have never been observed out of season.';

COMMENT ON COLUMN games.provider_status_code IS
  'The provider''s verbatim gameStatusCode, captured alongside the string so the '
  'claim that the code is the stabler discriminator can be checked rather than '
  'assumed. Evidence only.';

COMMENT ON COLUMN games.status IS
  'Written by syncGames (daily, 09:20 UTC) and by syncBoxScores (every ten '
  'minutes, from the box score''s own gameStatus). The second is what makes it '
  'true during a game; the first is the backstop for a game that never produces '
  'a box score at all. FINAL is one-way — see games_status_is_monotone.';

-- FINAL is a one-way door, enforced on the column.
--
-- `syncGames` writes `status = EXCLUDED.status` unconditionally while `final_at`
-- is COALESCEd, and `mapGameStatus` answers SCHEDULED for any wording it does
-- not recognise — and warns while doing so, which makes this documented
-- behaviour rather than a hypothetical. So a settled game could already be
-- walked backwards to SCHEDULED while keeping its final timestamp: an incoherent
-- row, latent only because there was one writer and it ran once a day.
--
-- The consequence is worse than it first looks. `finalizationHold` counts a game
-- as unread only when `status = 'FINAL'`, so a backwards walk makes a genuinely
-- unread game **invisible to the hold** — and the week then finalises past its
-- window blaming RULES.md section 10's abandoned-game rule for our own ingest.
--
-- It **clamps rather than refusing**, and that is the whole design. A trigger
-- that raised would take the ten-minute ingest down over a provider's vocabulary
-- drift, on a Sunday, which is the one time it must not stop. Rewriting the row
-- means no writer has to remember — the same reasoning as 0014's chain anchor,
-- 0028's draft field and 0031's season start, applied to the column that now has
-- two writers instead of one.
CREATE OR REPLACE FUNCTION games_status_is_monotone() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'FINAL' AND NEW.status <> 'FINAL' THEN
    NEW.status := 'FINAL';
    -- A row that reached FINAL always has a final_at; restore it if a writer
    -- cleared it in the same statement, so the two can never disagree.
    NEW.final_at := COALESCE(NEW.final_at, OLD.final_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER games_status_is_monotone
  BEFORE UPDATE ON games
  FOR EACH ROW
  EXECUTE FUNCTION games_status_is_monotone();

-- The work list no longer leads on status, so the index that matched it no
-- longer matches. `games` holds ~256 rows a season, so this is about intent
-- rather than speed: the next person reading these indexes should see what the
-- query actually asks for.
CREATE INDEX games_live_idx
  ON games (sport_id, season, kickoff_at)
  WHERE kickoff_tbd = false;
