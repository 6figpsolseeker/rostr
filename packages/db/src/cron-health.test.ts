import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cronHealth,
  everyMinutesOf,
  expectedJobs,
  stalenessLimitMinutes,
  type CronConfig,
} from "./cron-health.js";
import type { CronRun } from "./cron-runs.js";

const NOW = new Date("2026-08-17T12:00:00Z");
const ago = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

const run = (name: string, minutesAgo: number, outcome: string | null = null): CronRun => ({
  name,
  lastRanAt: ago(minutesAgo),
  lastOutcome: outcome,
});

describe("everyMinutesOf", () => {
  it("reads every-minute", () => {
    expect(everyMinutesOf("* * * * *")).toBe(1);
  });

  it("reads a step", () => {
    expect(everyMinutesOf("*/10 * * * *")).toBe(10);
  });

  it("reads a ranged step, which score-week actually uses", () => {
    // Offset from the stats job so it reads that run rather than the previous
    // one. Not an exotic expression — it is in vercel.json today.
    expect(everyMinutesOf("5-59/10 * * * *")).toBe(10);
  });

  it("reads hourly", () => {
    expect(everyMinutesOf("0 * * * *")).toBe(60);
  });

  it("reads daily", () => {
    expect(everyMinutesOf("20 9 * * *")).toBe(24 * 60);
  });

  it("refuses a day-of-week schedule rather than approximating it", () => {
    // A Tuesday job's gap depends on the calendar; one number cannot say it.
    expect(everyMinutesOf("0 9 * * 2")).toBeNull();
  });

  it("refuses a day-of-month schedule", () => {
    expect(everyMinutesOf("0 9 1 * *")).toBeNull();
  });

  it("refuses nonsense rather than guessing", () => {
    expect(everyMinutesOf("not a cron")).toBeNull();
    expect(everyMinutesOf("* * * *")).toBeNull();
    expect(everyMinutesOf("*/0 * * * *")).toBeNull();
  });

  it("refuses a repeating minute on a fixed hour", () => {
    // "*/10 9 * * *" fires six times, then not for 23 hours. No single interval
    // describes it, so it must not claim one.
    expect(everyMinutesOf("*/10 9 * * *")).toBeNull();
  });
});

describe("expectedJobs", () => {
  it("names a job by the last path segment, as the routes do", () => {
    const config: CronConfig = {
      crons: [{ path: "/api/cron/season-sync", schedule: "20 9 * * *" }],
    };
    expect(expectedJobs(config)).toEqual([{ name: "season-sync", everyMinutes: 1440 }]);
  });

  it("keeps a job whose schedule it cannot read, with a null interval", () => {
    // Dropping it would make an unreadable schedule indistinguishable from a
    // job nobody configured — silence, in the file that decides what runs.
    const config: CronConfig = { crons: [{ path: "/api/cron/x", schedule: "0 9 * * 2" }] };
    expect(expectedJobs(config)).toEqual([{ name: "x", everyMinutes: null }]);
  });

  it("ignores malformed entries rather than throwing", () => {
    const config = { crons: [{ schedule: "* * * * *" }, { path: 42 }] } as CronConfig;
    expect(expectedJobs(config)).toEqual([]);
  });

  it("handles a config with no crons at all", () => {
    expect(expectedJobs({})).toEqual([]);
  });

  it("pins the seven real jobs against the real vercel.json", () => {
    // The tripwire. If the file moves, or a job is added or renamed without
    // this being revisited, the check silently reports zero jobs scheduled —
    // which is exactly the "everything is fine" reading that hid the problem.
    const path = fileURLToPath(new URL("../../../apps/web/vercel.json", import.meta.url));
    const config = JSON.parse(readFileSync(path, "utf8")) as CronConfig;

    expect(expectedJobs(config)).toEqual([
      { name: "draft-tick", everyMinutes: 1 },
      { name: "stats", everyMinutes: 10 },
      { name: "score-week", everyMinutes: 10 },
      { name: "waivers", everyMinutes: 60 },
      { name: "trades", everyMinutes: 60 },
      // Hourly because Tank01 refreshes rosters hourly and this reads the
      // roster endpoint — a faster cadence would spend calls to learn what one
      // already knew. Offset to :35 so it does not land with waivers and trades.
      { name: "injuries", everyMinutes: 60 },
      { name: "season-sync", everyMinutes: 1440 },
    ]);
  });

  it("does not start the waiver run and trade execution on the same minute", () => {
    /*
      **These two block each other, so scheduling them together is a designed
      collision rather than a coincidence.**

      Trade execution takes `leagues … FOR SHARE` (#277) and a waiver run holds
      `FOR UPDATE` on the same row for its whole per-league transaction, so one
      waits for the other. Both were on `0 * * * *` until #312 moved trades to
      `:30`. The wait is short — the run loads the draft board *outside* its
      transaction precisely so the lock is held for as little as possible, and
      it locks one league at a time — so this was never an outage. It was two
      jobs queueing behind each other every hour for no reason.

      Nothing orders them. `RULES.md` ties execution to the veto window and to
      the trade deadline's *week*, never to a waiver run, and the window is 48
      hours — so the offset cannot be noticed by any rule.

      Asserted on the **minute field**, not on `everyMinutes`: both are hourly
      and always will be, so the cadence says nothing about whether they
      collide. This is what a future reader would otherwise have to rediscover
      by reading two lock acquisition orders.
    */
    const path = fileURLToPath(new URL("../../../apps/web/vercel.json", import.meta.url));
    const config = JSON.parse(readFileSync(path, "utf8")) as CronConfig;

    const startMinute = (name: string): string => {
      const entry = (config.crons ?? []).find(
        (cron) => typeof cron.path === "string" && cron.path.endsWith(`/${name}`),
      );
      const schedule = typeof entry?.schedule === "string" ? entry.schedule : "";
      const minute = schedule.split(" ")[0] ?? "";
      // A job that is not scheduled, or whose expression this cannot read, must
      // not pass by looking different from the other one.
      expect(minute, `${name} has a readable start minute`).toMatch(/^[0-9*/,-]+$/);
      return minute;
    };

    expect(startMinute("waivers")).not.toBe(startMinute("trades"));
  });
});

describe("cronHealth", () => {
  const jobs = [
    { name: "draft-tick", everyMinutes: 1 },
    { name: "season-sync", everyMinutes: 1440 },
  ];

  it("reports a job that has never run", () => {
    const health = cronHealth(jobs, [], NOW);

    expect(health.jobs.map((j) => j.state)).toEqual(["NEVER_RAN", "NEVER_RAN"]);
    expect(health.healthy).toBe(false);
  });

  it("distinguishes nothing-has-ever-run from a job being late", () => {
    // The signature of a deployment that does not exist, as against a scheduler
    // that faltered. Measured on 2026-08-17: zero rows, six jobs scheduled.
    expect(cronHealth(jobs, [], NOW).neverRanAtAll).toBe(true);
    expect(cronHealth(jobs, [run("draft-tick", 0)], NOW).neverRanAtAll).toBe(false);
  });

  it("is healthy when every job has run recently and cleanly", () => {
    const health = cronHealth(jobs, [run("draft-tick", 1), run("season-sync", 60)], NOW);
    expect(health.healthy).toBe(true);
  });

  it("calls a punctual job with a failing outcome FAILING, not OK", () => {
    // A job that fires every minute and fails every time is worse than one that
    // never fires, and a bare timestamp reports both as healthy.
    const health = cronHealth(jobs, [run("draft-tick", 0, "2 of 3 seasons failed")], NOW);

    expect(health.jobs[0]?.state).toBe("FAILING");
    expect(health.jobs[0]?.lastOutcome).toBe("2 of 3 seasons failed");
  });

  it("calls a job late by more than two intervals STALE", () => {
    const health = cronHealth(jobs, [run("draft-tick", 30), run("season-sync", 60)], NOW);
    expect(health.jobs[0]?.state).toBe("STALE");
  });

  it("tolerates one missed invocation", () => {
    // A scheduler is allowed to be slightly late; a check that cries wolf is one
    // people stop reading.
    const health = cronHealth(
      [{ name: "waivers", everyMinutes: 60 }],
      [run("waivers", 90)],
      NOW,
    );
    expect(health.jobs[0]?.state).toBe("OK");
  });

  it("does not call an unreadable schedule healthy", () => {
    const health = cronHealth([{ name: "odd", everyMinutes: null }], [run("odd", 5)], NOW);

    expect(health.jobs[0]?.state).toBe("UNKNOWN_SCHEDULE");
    expect(health.healthy).toBe(false);
  });

  it("reports a run with no schedule behind it as UNSCHEDULED", () => {
    // Migration 0029 names "a deploy that dropped the cron config" as a way the
    // crons stop. This is the only shape that catches it — the job leaves the
    // config and its history stays.
    const health = cronHealth([jobs[0]!], [run("draft-tick", 0), run("waivers", 10)], NOW);

    expect(health.jobs.find((j) => j.name === "waivers")?.state).toBe("UNSCHEDULED");
    expect(health.healthy).toBe(false);
  });

  it("reports minutes since the last run, and null when there was none", () => {
    const health = cronHealth(jobs, [run("draft-tick", 7)], NOW);

    expect(health.jobs[0]?.minutesSince).toBe(7);
    expect(health.jobs[1]?.minutesSince).toBeNull();
  });
});

describe("stalenessLimitMinutes", () => {
  it("allows two intervals plus slack", () => {
    expect(stalenessLimitMinutes(1)).toBe(7);
    expect(stalenessLimitMinutes(60)).toBe(125);
  });
});
