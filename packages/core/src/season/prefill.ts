/**
 * Which week's lineups to fill *before* its games start, if any.
 *
 * The autofill only ever ran while a week was being scored, which meant its
 * first pass happened at that week's first kickoff — and, for playoff week 15,
 * days later still. Week 15's fixtures are written by `advancePlayoffs`, which
 * refuses until every regular-season matchup is finalised, and week 14 is a
 * paying week with a 168-hour hold; so the first fill for the round that decides
 * the pot landed on the Monday, after that week's whole slate had kicked off.
 * Started players are excluded from the pool, so an abandoned team fielded about
 * one starter out of nine, and often none (issue #288).
 *
 * This names a week to fill ahead of time. It is deliberately a pure function of
 * facts the caller already holds, so the decision can be tested without a
 * database, a clock or a cron.
 */

import { latestWeekly } from "../waivers/schedule.js";
import type { WaiverRules } from "../rules/types.js";

export interface PrefillInput {
  /**
   * The week whose games come next — `transactionWeek`, which reads `games`.
   *
   * **Never a fixture-derived week.** `matchups` rows for a playoff week arrive
   * only after the previous week finalises, which is the whole defect; a week
   * read off the schedule is knowable months ahead.
   */
  readonly ahead: number | null;
  /** The week being scored — `currentWeek`, the week of the most recent kickoff. */
  readonly lagging: number | null;
  /** The last week this league plays: its regular season, or its final playoff week. */
  readonly lastPlayedWeek: number;
  readonly now: Date;
  readonly waivers: WaiverRules;
}

/**
 * The week to fill early, or `null` for "nothing to do".
 *
 * Three conditions, and each one is load-bearing:
 *
 * **It must be a week this league plays.** `ahead` is "the next week with a
 * game", which after the championship week is the NFL's own week 18 — a week no
 * league has fixtures for and nobody can score. Nothing moves a finished league
 * out of `IN_SEASON`/`PLAYOFFS`, so without this the fill would write lineup
 * rows for week 18 every ten minutes, forever.
 *
 * **It must be ahead of the week being scored.** Once that week's games have
 * started, its fill is the ordinary one that runs with scoring.
 *
 * **This cycle's waivers must have run.** The autofill keeps any assignment
 * already stored and only fills gaps, so a fill run before Wednesday's waiver
 * processing would freeze a pre-waiver roster that no later pass upgrades — a
 * manager's claim would be granted and then left on the bench. Comparing the
 * most recent processing moment against the most recent weekly lock answers
 * "have this week's waivers run yet" in the league's own timezone, via the same
 * `latestWeekly` the waiver cycle uses — which is walked rather than computed as
 * `now - 7 days`, so it stays correct across the November fall-back.
 */
export function weekToPrefill(input: PrefillInput): number | null {
  const { ahead, lagging, lastPlayedWeek, now, waivers } = input;

  if (ahead === null) return null;
  if (ahead > lastPlayedWeek) return null;
  if (lagging !== null && ahead <= lagging) return null;

  const lock = latestWeekly(now, waivers.weeklyLock, waivers.timezone);
  const processed = latestWeekly(now, waivers.processing, waivers.timezone);
  if (processed.getTime() <= lock.getTime()) return null;

  return ahead;
}

/** The last week a league plays, from its schedule rules. */
export function lastPlayedWeek(schedule: {
  readonly regularSeasonWeeks: number;
  readonly playoffWeeks: readonly number[];
}): number {
  return Math.max(schedule.regularSeasonWeeks, ...schedule.playoffWeeks);
}
