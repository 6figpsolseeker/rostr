/**
 * Is the scheduler running, and is it succeeding?
 *
 * `cron_runs` (migration `0029`) records that a job reached the end of a run,
 * and `listCronRuns` deliberately returns everything so that a *missing* row is
 * as visible as a stale one. Its docstring names the caller that was supposed to
 * exist — "a caller comparing against the expected job list" — and until now
 * nothing did. So the table was written on every invocation and read by nobody,
 * which is the same blind spot one layer up: the heartbeat existed and no one
 * took the pulse.
 *
 * Measured on 2026-08-17: `cron_runs` held **zero rows**. Six jobs are scheduled
 * in `apps/web/vercel.json`, `draft-tick` every minute, and the table had been
 * live for two days. Nothing had ever run. Everything in the deployed database
 * was put there by somebody typing `pnpm db:sync`.
 *
 * ## The expected list is parsed, never restated
 *
 * {@link expectedJobs} reads `apps/web/vercel.json` — the file the host actually
 * obeys. A second copy of the job list in this file would be a copy that drifts,
 * and the drift would be silent in the direction that matters: a job added to
 * the schedule and forgotten here would never be reported missing. This is the
 * `potDepositGate` property — the thing that decides is the thing that ships.
 *
 * ## An unreadable schedule is reported, never assumed healthy
 *
 * A cron expression this cannot parse yields `UNKNOWN_SCHEDULE` rather than a
 * guess. That is the same direction `blockTime` takes for an unrecognised RPC
 * error, and for the same reason: refusing costs someone a look, while guessing
 * costs the thing the check exists to protect. A staleness threshold derived
 * from a misread expression would report a dead job as healthy.
 *
 * ## What a green result does NOT mean
 *
 * **It means the routes ran. It does not mean they did anything.** A run over
 * zero games is a healthy run, so every job here can report `OK` while
 * `stat_lines` stays empty and every player scores zero. That is a real and
 * current state of this project, not a hypothetical. Read this as "the
 * scheduler is alive", never as "the data is right" — the data has its own
 * checks and this is not one of them.
 */

import type { CronRun } from "./cron-runs.js";

/** A job the deployment is configured to run, and how often. */
export interface ExpectedJob {
  /** The job name, matching what the route passes to `recordCronRun`. */
  readonly name: string;
  /** Minutes between runs, or `null` when the schedule could not be parsed. */
  readonly everyMinutes: number | null;
}

export type CronJobState =
  /** Ran recently enough for its schedule, and the last run was clean. */
  | "OK"
  /** Scheduled, and has never recorded a single run. */
  | "NEVER_RAN"
  /** Ran once, but not recently enough for its schedule. */
  | "STALE"
  /** Running, and the last run reported a problem. */
  | "FAILING"
  /** Its cron expression could not be parsed, so staleness is unknowable. */
  | "UNKNOWN_SCHEDULE"
  /** Has a `cron_runs` row and is in no schedule — a dropped cron config. */
  | "UNSCHEDULED";

export interface CronJobHealth {
  readonly name: string;
  readonly state: CronJobState;
  readonly everyMinutes: number | null;
  readonly lastRanAt: Date | null;
  readonly lastOutcome: string | null;
  /** Minutes since the last run, or `null` if it has never run. */
  readonly minutesSince: number | null;
}

export interface CronHealth {
  readonly jobs: readonly CronJobHealth[];
  /** True only when every job is `OK`. */
  readonly healthy: boolean;
  /** True when nothing has ever run — the "not deployed" shape. */
  readonly neverRanAtAll: boolean;
}

/** The shape of `vercel.json` this reads. Anything else is ignored. */
export interface CronConfig {
  readonly crons?: readonly { readonly path?: unknown; readonly schedule?: unknown }[];
}

/**
 * One missed invocation is not an outage; two is.
 *
 * Plus five minutes of slack, because a scheduler is allowed to be a little late
 * and a check that cries wolf is one people stop reading.
 */
export function stalenessLimitMinutes(everyMinutes: number): number {
  return everyMinutes * 2 + 5;
}

/**
 * How many minutes apart a cron expression fires, or `null` if unreadable.
 *
 * Handles only the shapes this repo actually schedules, and refuses everything
 * else rather than approximating. Day-of-month and day-of-week must be `*`: a
 * job that runs on Tuesdays has a gap that depends on the calendar, and a single
 * "every N minutes" number cannot describe it.
 */
export function everyMinutesOf(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") return null;

  const minuteStep = stepOf(minute);
  if (minuteStep === null) return null;

  // Every hour: the minute field decides. A single minute (`0 * * * *`) fires
  // once an hour; a step (`*/10 * * * *`) fires at that step.
  if (hour === "*") return minuteStep === FIXED ? 60 : minuteStep;

  // Hourly or daily: the minute field must name a single minute, or the gap is
  // not constant.
  if (minuteStep !== FIXED) return null;

  const hourStep = stepOf(hour);
  if (hourStep === null) return null;
  return hourStep === FIXED ? 24 * 60 : hourStep * 60;
}

/** Marker for a field naming exactly one value rather than an interval. */
const FIXED = -1;

/**
 * The interval a single cron field describes: `FIXED` for one value, a positive
 * number for a repeating step, or `null` when it cannot be read.
 *
 * `5-59/10` is deliberately supported — `score-week` uses it to run offset from
 * `stats`, so it is not an exotic case.
 */
function stepOf(field: string): number | null {
  if (field === "*") return 1;

  const stepped = /^(\*|\d+-\d+)\/(\d+)$/.exec(field);
  if (stepped) {
    const step = Number(stepped[2]);
    return Number.isInteger(step) && step > 0 ? step : null;
  }

  return /^\d+$/.test(field) ? FIXED : null;
}

/**
 * The jobs a deployment is configured to run, from its own cron config.
 *
 * The name is the last path segment, which is what each route passes to
 * `recordCronRun` — `/api/cron/season-sync` records as `season-sync`. If that
 * convention is ever broken the job reports `NEVER_RAN` while running perfectly,
 * which is loud and wrong rather than quiet and wrong; there is a test pinning
 * the six real names against the real file for exactly that reason.
 */
export function expectedJobs(config: CronConfig): readonly ExpectedJob[] {
  return (config.crons ?? [])
    .map((entry) => {
      const path = typeof entry.path === "string" ? entry.path : "";
      const name = path.split("/").filter(Boolean).pop() ?? "";
      const schedule = typeof entry.schedule === "string" ? entry.schedule : "";
      return { name, everyMinutes: schedule === "" ? null : everyMinutesOf(schedule) };
    })
    .filter((job) => job.name !== "");
}

/**
 * Compare what should be running against what has run.
 *
 * Pure, so the interesting states are testable without a scheduler, a
 * deployment, or waiting a day for a daily job to be late.
 */
export function cronHealth(
  expected: readonly ExpectedJob[],
  runs: readonly CronRun[],
  now: Date,
): CronHealth {
  const byName = new Map(runs.map((run) => [run.name, run]));
  const jobs: CronJobHealth[] = [];

  for (const job of expected) {
    const run = byName.get(job.name);
    const minutesSince =
      run === undefined ? null : Math.floor((now.getTime() - run.lastRanAt.getTime()) / 60_000);

    jobs.push({
      name: job.name,
      state: stateOf(job, run, minutesSince),
      everyMinutes: job.everyMinutes,
      lastRanAt: run?.lastRanAt ?? null,
      lastOutcome: run?.lastOutcome ?? null,
      minutesSince,
    });
  }

  // A row with no schedule behind it. Migration 0029's comment names "a deploy
  // that dropped `vercel.json`" as a way the crons stop, and this is the only
  // shape that catches it: the job vanishes from the config while its history
  // remains.
  const scheduled = new Set(expected.map((job) => job.name));
  for (const run of runs) {
    if (scheduled.has(run.name)) continue;
    jobs.push({
      name: run.name,
      state: "UNSCHEDULED",
      everyMinutes: null,
      lastRanAt: run.lastRanAt,
      lastOutcome: run.lastOutcome,
      minutesSince: Math.floor((now.getTime() - run.lastRanAt.getTime()) / 60_000),
    });
  }

  return {
    jobs,
    healthy: jobs.every((job) => job.state === "OK"),
    // Distinguished from "some job is stale" on purpose: no rows at all, with
    // the table present, is the signature of a deployment that does not exist
    // rather than a scheduler that faltered.
    neverRanAtAll: runs.length === 0 && expected.length > 0,
  };
}

function stateOf(
  job: ExpectedJob,
  run: CronRun | undefined,
  minutesSince: number | null,
): CronJobState {
  if (run === undefined) return "NEVER_RAN";
  // Checked before staleness: a job failing every minute is punctual, and
  // reporting it as OK is the exact failure `last_outcome` was added to prevent.
  if (run.lastOutcome !== null) return "FAILING";
  if (job.everyMinutes === null) return "UNKNOWN_SCHEDULE";
  if (minutesSince !== null && minutesSince > stalenessLimitMinutes(job.everyMinutes)) {
    return "STALE";
  }
  return "OK";
}
