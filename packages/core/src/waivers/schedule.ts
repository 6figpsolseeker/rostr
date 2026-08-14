/**
 * When waivers lock, clear, and process.
 *
 * ## Timezones, not offsets
 *
 * Every moment here is expressed as a weekday and a local hour in the league's
 * timezone, and converted to an instant on demand. The NFL season crosses the
 * daylight-saving boundary in early November: "Wednesday 03:00 ET" is 08:00 UTC
 * before it and 07:00 UTC after.
 *
 * Freezing a UTC offset into the rules would shift every waiver run by an hour
 * midway through the season, somewhere around the trade deadline, and the only
 * symptom would be claims resolving an hour off. Nobody would connect it to the
 * clocks changing.
 *
 * All functions are pure and take `now` explicitly — no hidden clock, so a whole
 * season of waiver runs can be played out in a test.
 */

import type { Weekday, WaiverRules, WeeklyMoment } from "../rules/types.js";

const WEEKDAYS: readonly Weekday[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

export class WaiverScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaiverScheduleError";
  }
}

/**
 * The timezone's offset from UTC at a given instant, in milliseconds.
 *
 * Derived by asking `Intl` what the wall clock reads there and diffing — which
 * is correct across DST without shipping a timezone database.
 */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const read = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new WaiverScheduleError(`Timezone "${timeZone}" is not usable on this runtime`);
    }
    return parsed;
  };

  const asIfUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    // Intl renders midnight as 24 in some locales.
    read("hour") % 24,
    read("minute"),
    read("second"),
  );

  return asIfUtc - instant.getTime();
}

/** The local wall-clock parts of an instant in a timezone. */
function localParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; weekday: Weekday } {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const read = (type: string): string =>
    formatted.find((part) => part.type === type)?.value ?? "";

  const short = read("weekday").toUpperCase();
  const weekday = WEEKDAYS.find((day) => day.startsWith(short.slice(0, 3)));
  if (!weekday) {
    throw new WaiverScheduleError(`Could not read a weekday in "${timeZone}"`);
  }

  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    weekday,
  };
}

/**
 * The instant at which a given local wall-clock time occurs.
 *
 * Two passes: guess by treating the local time as UTC, measure the real offset
 * at that guess, then correct. The second pass matters when the guess lands on
 * the far side of a DST transition from the answer.
 */
function instantOf(
  local: { year: number; month: number; day: number; hour: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, 0, 0);

  let instant = new Date(naive - offsetMs(new Date(naive), timeZone));
  instant = new Date(naive - offsetMs(instant, timeZone));

  return instant;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first occurrence of a weekly moment strictly after `after`.
 *
 * Walks forward a day at a time in local terms rather than adding fixed
 * millisecond amounts, because a DST day is 23 or 25 hours long.
 */
export function nextWeekly(after: Date, moment: WeeklyMoment, timeZone: string): Date {
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const probe = new Date(after.getTime() + dayOffset * DAY_MS);
    const parts = localParts(probe, timeZone);
    if (parts.weekday !== moment.day) continue;

    const candidate = instantOf({ ...parts, hour: moment.hour }, timeZone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }

  throw new WaiverScheduleError(
    `No ${moment.day} ${moment.hour}:00 found within 8 days of ${after.toISOString()}`,
  );
}

/**
 * The most recent occurrence of a weekly moment at or before `now`.
 *
 * **Consecutive weekly moments are not 168 hours apart.** Across a fall-back
 * they are 169, across a spring-forward 167, and a jurisdiction with a two-hour
 * transition moves them further still. Both callers of this used to find the
 * previous lock by asking `nextWeekly` from exactly `now - 7 * 24h`, and a
 * 168-hour lookback cannot span a 169-hour gap: it lands precisely *on* the
 * previous lock, `nextWeekly` is strictly-after so it skips it, and the answer
 * is a lock **one hour in the future**.
 *
 * That was live for the hour of Monday 2 November 2026, 23:00–23:59 ET, on the
 * shipped default rules — see the tests.
 *
 * So walk instead of guessing an interval. Starting nine days back guarantees at
 * least one occurrence in range whatever the transition, and stepping forward
 * while the next is still `<= now` lands on the last one. At most two
 * iterations, and it assumes nothing about how long a week is.
 */
export function latestWeekly(now: Date, moment: WeeklyMoment, timeZone: string): Date {
  let cursor = nextWeekly(new Date(now.getTime() - 9 * DAY_MS), moment, timeZone);

  for (;;) {
    const next = nextWeekly(cursor, moment, timeZone);
    if (next.getTime() > now.getTime()) return cursor;
    cursor = next;
  }
}

/** The next waiver processing run strictly after `now`. */
export function nextProcessingAt(now: Date, rules: WaiverRules): Date {
  return nextWeekly(now, rules.processing, rules.timezone);
}

/** The next weekly lock strictly after `now`. */
export function nextWeeklyLockAt(now: Date, rules: WaiverRules): Date {
  return nextWeekly(now, rules.weeklyLock, rules.timezone);
}

/**
 * Whether every unrostered player is on waivers right now.
 *
 * `docs/RULES.md` §6's cycle table, which members sign:
 *
 * > | **Tuesday 00:00**               | Every unrostered player returns to waivers |
 * > | **Wednesday 03:00**             | Claims process, blind, by priority         |
 * > | Wednesday 03:00 → Tuesday 00:00 | Free agency, first come first served       |
 * >
 * > This is the substance of the system, not the drop rule below it. A backup
 * > who breaks out on Sunday is claimed by priority on Wednesday morning — not
 * > by whoever happens to be refreshing on Sunday night.
 *
 * That is ESPN's model, verified against their published rules: *"All players
 * not on a fantasy roster reside on waivers following each week of play."* It is
 * **not** Sleeper's, which holds only recently-dropped players and instead locks
 * the pool during games — and Sleeper's is what this codebase actually
 * implemented, because the only writers of `waiver_wire` are drop-driven. Two
 * coherent designs got crossed and the members signed the other one.
 *
 * ## Derived, never stored
 *
 * The obvious reading of "returns to waivers" is a job that writes a wire row per
 * unrostered player each Tuesday — thousands of rows per league per week, a
 * clears-at for players who never landed anywhere, and a new failure mode every
 * time it half-runs. None of that is needed. Availability is already computed
 * rather than stored, and the weekly lock is a *default*: outside the window an
 * unrostered player with no wire row is a free agent, inside it he is on waivers.
 * One predicate, no writes, no migration, no job to fail.
 *
 * The window is half-open — `[lock, run)` — so the run itself is not inside it.
 * That matters: `processWaivers` executes *at* the processing instant, and its
 * claims must resolve against a pool that has already reopened, or the run would
 * be reasoning about a lock it is in the act of lifting.
 *
 * A player serving his own waiver period is unaffected either way: his wire row
 * answers first, and it outlives this window.
 */
export function everyoneIsOnWaivers(now: Date, rules: WaiverRules): boolean {
  const lock = latestWeekly(now, rules.weeklyLock, rules.timezone);

  return now.getTime() < nextProcessingAt(lock, rules).getTime();
}

export type DropDestination = "WAIVERS" | "FREE_AGENT";

/**
 * Where a dropped player goes.
 *
 * ESPN's short-tenure rule: a player rostered briefly goes straight to free
 * agency. It stops a manager adding someone, cutting them hours later, and
 * re-adding them to sidestep the claim queue.
 */
export function dropDestination(
  acquiredAt: Date,
  droppedAt: Date,
  rules: WaiverRules,
): DropDestination {
  const heldHours = (droppedAt.getTime() - acquiredAt.getTime()) / (60 * 60 * 1000);
  return heldHours < rules.shortTenureHours ? "FREE_AGENT" : "WAIVERS";
}

/**
 * When a player who landed on waivers at `landedAt` clears.
 *
 * The first processing run at least `waiverPeriodDays` after landing — so a
 * player dropped an hour before Wednesday's run does not clear that same
 * morning, which would give the dropping manager's league-mates no time to
 * claim him.
 */
export function waiverClearsAt(landedAt: Date, rules: WaiverRules): Date {
  const earliest = new Date(landedAt.getTime() + rules.waiverPeriodDays * DAY_MS);

  // `nextProcessingAt` is strictly-after, so a run falling exactly on the
  // boundary is found by stepping back a millisecond.
  return nextProcessingAt(new Date(earliest.getTime() - 1), rules);
}

export type PlayerAvailability = "ON_WAIVERS" | "FREE_AGENT";

/**
 * Whether an unrostered player can be claimed or simply added, at `now`.
 *
 * `landedOnWaiversAt` is when they last entered the waiver pool — either
 * dropped, or swept up by the weekly lock.
 */
export function availabilityAt(
  landedOnWaiversAt: Date | null,
  now: Date,
  rules: WaiverRules,
): PlayerAvailability {
  if (!landedOnWaiversAt) return "FREE_AGENT";
  return now < waiverClearsAt(landedOnWaiversAt, rules) ? "ON_WAIVERS" : "FREE_AGENT";
}
