/**
 * Did the scheduler run?
 *
 * Nothing used to record it, which made a stopped scheduler and a quiet week
 * indistinguishable — and there are several ways to stop one: the host pauses
 * the project, a deploy drops the cron config, a job is disabled, the route
 * throws on every invocation, the secret is misconfigured so every call is
 * refused, or a provider quota is exhausted. All of them look like nothing
 * happening.
 *
 * That is expensive here specifically because a finalised week is never
 * rescored. A scoring cron that stops for one weekend settles those weeks
 * wrong, permanently.
 *
 * ## The stamp must never fail the job
 *
 * This is bookkeeping about work, not the work. A route whose real job
 * succeeded must not report failure because the record of it failed —
 * otherwise observability becomes a new way for the crons to break, which is
 * the opposite of the point. So {@link recordCronRun} swallows its own error,
 * and it is the only function in this package that does.
 *
 * It logs rather than swallowing silently: a heartbeat that stops working
 * without saying so leaves exactly the blind spot it was added to remove.
 */

import type { SqlClient } from "./client.js";

export interface CronRun {
  readonly name: string;
  readonly lastRanAt: Date;
  /** `null` when the last run finished normally, otherwise why it did not. */
  readonly lastOutcome: string | null;
}

/**
 * Record that a job reached the end of a run.
 *
 * Called once per invocation, at the end, whatever happened — the outcome is
 * more informative than the timestamp. A job that fires every minute and throws
 * every time is worse than one that never fires, and a bare timestamp reports
 * both as healthy.
 *
 * @param outcome `null` on success, otherwise a short reason.
 */
export async function recordCronRun(
  db: SqlClient,
  name: string,
  outcome: string | null = null,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO cron_runs (name, last_ran_at, last_outcome)
            VALUES ($1, now(), $2)
       ON CONFLICT (name) DO UPDATE
            SET last_ran_at = now(), last_outcome = EXCLUDED.last_outcome`,
      [name, outcome],
    );
  } catch (error) {
    // Deliberately swallowed — see the module docstring. The job's own result is
    // what matters and it has already been decided by the time this runs.
    // eslint-disable-next-line no-console
    console.error(
      `[cron] could not record a run of ${name}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Every job that has ever recorded a run, most recently first.
 *
 * The whole point of the table, and deliberately not filtered: a job whose row
 * is *missing* is as interesting as one whose row is stale, and a caller
 * comparing against the expected job list can only notice that if it sees
 * everything.
 */
export async function listCronRuns(db: SqlClient): Promise<readonly CronRun[]> {
  const rows = await db.query<{
    name: string;
    last_ran_at: string;
    last_outcome: string | null;
  }>("SELECT name, last_ran_at, last_outcome FROM cron_runs ORDER BY last_ran_at DESC");

  return rows.map((row) => ({
    name: row.name,
    lastRanAt: new Date(row.last_ran_at),
    lastOutcome: row.last_outcome,
  }));
}
