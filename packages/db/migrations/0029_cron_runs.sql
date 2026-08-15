-- What the scheduler actually did, one row per job.
--
-- Nothing recorded that a cron ran, so every way of them not running looked the
-- same from inside the app: the project paused, a deploy that dropped
-- `vercel.json`, a job disabled in the dashboard, a route that 500s on every
-- invocation, a misconfigured secret refusing every call, or a provider quota
-- exhausted mid-season. All of them produce *nothing happening*, and nothing
-- happening is also what a quiet Tuesday looks like.
--
-- That matters more here than in most systems because a finalised week is never
-- rescored. A scoring cron that silently stops for one weekend settles those
-- weeks wrong, permanently, and the first evidence is a member asking why their
-- starter scored zero.
--
-- **One row per job, upserted — not an append-only log.** `draft-tick` runs
-- every minute, so a history table would be 1,440 rows a day and a retention
-- question, to answer a question that only ever concerns the *last* run. If
-- per-run history is ever wanted it is a different table with a different
-- purpose, and this one does not stand in its way.
--
-- **`last_outcome` is the point, not `last_ran_at`.** A route that fires every
-- minute and throws every time is worse than one that never fires, and a bare
-- timestamp reports both as healthy. Success stores NULL; anything else stores
-- why.

CREATE TABLE cron_runs (
    name         text PRIMARY KEY,
    last_ran_at  timestamptz NOT NULL,
    last_outcome text
);

COMMENT ON TABLE cron_runs IS
  'One row per scheduled job, upserted at the end of each run. Answers "is the '
  'scheduler running, and is it succeeding" without dashboard access.';

COMMENT ON COLUMN cron_runs.last_ran_at IS
  'When this job last reached the end of a run, successfully or not. A row that '
  'is stale relative to the job''s schedule means it is not running at all.';

COMMENT ON COLUMN cron_runs.last_outcome IS
  'NULL when the last run completed normally; otherwise why it did not. A job '
  'with a fresh timestamp and a non-NULL outcome is running and failing, which '
  'a timestamp alone would report as healthy.';
