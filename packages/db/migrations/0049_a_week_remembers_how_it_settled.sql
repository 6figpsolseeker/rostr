-- A week records that it settled on the clock rather than on complete data.
--
-- `RULES.md` §10 lets a paying week finalise with games that never reached
-- `FINAL`, because a postponed fixture must not hold a pot open forever. #140
-- added a second cause: the window elapsed with games marked FINAL whose box
-- score we never read. Either way those players score **zero, permanently** —
-- a finalised week is never rescored.
--
-- `resolveLeagueWeek` has reported that since #140, as
-- `finalizedWithUnfinishedGames` on its outcome. The problem is where it went.
--
-- ## Why a column, and not a better cron note
--
-- The fact reached exactly two places: the cron's HTTP response body, which
-- Vercel does not retain, and `cron_runs.last_outcome`, which is one row per
-- job, upserted.
--
-- **So it survived one run of one ten-minute cron and was then overwritten.**
-- `resolveLeagueWeeksThrough` selects weeks where no row is finalised, so the
-- moment a week settles it is never selected again — the note cannot be
-- regenerated, by that job or any other. The loudest alarm this system can
-- raise, for the case where money is decided on data we never fetched, had a
-- ten-minute life.
--
-- Issue #323 proposed a second column on `cron_runs` for facts like this. It
-- would not have helped: `last_note` is upserted on the same row by the same
-- statement, so the next tick overwrites it exactly as `last_outcome` does. The
-- fault was never that the heartbeat had one channel. It was that a fact about
-- **a week** was being stored on a row about **a job**.
--
-- Here it lives as long as the league does, on the week it describes, and it is
-- reconstructible by anybody reading the matchup afterwards — which is also
-- what `Scoreboard` wants when a member asks why a starter scored zero.
--
-- ## Nullable, and never backfilled
--
-- Weeks settled before this migration carry NULL, which means "we do not know",
-- not "cleanly". Inventing a value for them would assert something no row
-- records. New settlements are written by `resolveLeagueWeek` inside the same
-- `finalized_at IS NULL` guard as the timestamp, so a losing concurrent run
-- cannot stamp a row another run already settled.

ALTER TABLE matchups ADD COLUMN finalized_on_fallback text;

COMMENT ON COLUMN matchups.finalized_on_fallback IS
  'Why this week settled on the correction-window clock rather than on complete '
  'data, or NULL when it settled cleanly — also NULL for any week finalised '
  'before migration 0049, which is not the same claim. Written once, with '
  'finalized_at, under the same guard.';
