/**
 * The scoring engine.
 *
 * A pure fold over stat lines. It has no dependencies, no I/O, and no knowledge
 * of any sport — it reads the league's frozen scoring rules and applies them.
 *
 * ## Everything is integer milli-points
 *
 * 1 point = 1000 milli-points. Nothing here produces or consumes a float.
 *
 * Passing yards score 0.04 points each. A single product usually survives IEEE
 * 754 intact — `0.04 * 25` really is `1` — but a season is nothing but
 * accumulation, and accumulation is where it fails: adding `0.1` ten times gives
 * `0.9999999999999999`. Matchups decided by hundredths happen constantly, and
 * this engine decides who gets paid.
 *
 * Conversion to a decimal happens once, at the display edge, in `formatPoints`.
 */

import type { LeagueRules, RosterRules, ScoringRule } from "../rules/types.js";

export interface StatLine {
  readonly statKey: string;
  /** Whole units: yards, receptions, touchdowns, points allowed. */
  readonly value: number;
}

export class ScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoringError";
  }
}

/** Index rules by stat key. Build once per league, reuse across every player. */
export function indexScoringRules(
  rules: readonly ScoringRule[],
): ReadonlyMap<string, ScoringRule> {
  return new Map(rules.map((rule) => [rule.statKey, rule]));
}

function applyTiered(rule: Extract<ScoringRule, { kind: "TIERED" }>, value: number): number {
  for (const tier of rule.tiers) {
    const withinLower = value >= tier.min;
    const withinUpper = tier.max === null || value <= tier.max;
    if (withinLower && withinUpper) return tier.milliPoints;
  }

  // Validation guarantees contiguous tiers ending unbounded, so the only way
  // here is a value below the first tier's minimum — a negative points-allowed,
  // say. Silently scoring zero would hide a broken feed.
  throw new ScoringError(
    `No tier in "${rule.statKey}" covers value ${value}. ` +
      `Tiers start at ${rule.tiers[0]?.min ?? "?"}.`,
  );
}

/**
 * Score one player's stat line.
 *
 * Stats with no matching rule score nothing — a league is free to ignore a stat
 * the sport defines.
 *
 * **Absent is not zero.** A stat key missing from `stats` contributes nothing at
 * all, which is correct for a player who did not appear. It matters most for
 * tiered rules: a defense that allowed 0 points must be given an explicit
 * `def_pts_allowed: 0` to earn the shutout bonus. Emitting that zero is the
 * provider adapter's job.
 *
 * @returns milli-points
 */
export function scorePlayer(
  stats: readonly StatLine[],
  rules: ReadonlyMap<string, ScoringRule>,
): number {
  let total = 0;

  for (const stat of stats) {
    const rule = rules.get(stat.statKey);
    if (!rule) continue;

    if (!Number.isSafeInteger(stat.value)) {
      throw new ScoringError(
        `Stat "${stat.statKey}" has non-integer value ${stat.value}. ` +
          `Stat values are whole units; fractional scoring lives in the rule.`,
      );
    }

    total +=
      rule.kind === "LINEAR"
        ? stat.value * rule.milliPointsPerUnit
        : applyTiered(rule, stat.value);
  }

  return total;
}

export interface LineupEntry {
  readonly slotType: string;
  readonly playerId: string;
  readonly stats: readonly StatLine[];
}

export interface PlayerScore {
  readonly playerId: string;
  readonly slotType: string;
  readonly milliPoints: number;
  /** False for bench and IR: present in the lineup, contributing nothing. */
  readonly counted: boolean;
}

export interface TeamWeekScore {
  readonly milliPoints: number;
  readonly players: readonly PlayerScore[];
}

/**
 * Score a team's week.
 *
 * Only slots the league lists as starters count. Bench and IR are scored and
 * returned — managers want to see what they left on the bench — but excluded
 * from the total. Filtering by the frozen roster rules rather than by a
 * hardcoded list of bench slot names means a league that renames or reshapes its
 * slots still totals correctly.
 */
export function scoreTeamWeek(
  lineup: readonly LineupEntry[],
  scoringRules: ReadonlyMap<string, ScoringRule>,
  roster: RosterRules,
): TeamWeekScore {
  const startingSlots = new Set(roster.starters.map((slot) => slot.slotType));

  const players = lineup.map((entry): PlayerScore => {
    const counted = startingSlots.has(entry.slotType);
    return {
      playerId: entry.playerId,
      slotType: entry.slotType,
      milliPoints: scorePlayer(entry.stats, scoringRules),
      counted,
    };
  });

  const milliPoints = players
    .filter((player) => player.counted)
    .reduce((sum, player) => sum + player.milliPoints, 0);

  return { milliPoints, players };
}

/** Convenience wrapper that indexes the rules for a single call. */
export function scoreTeamWeekWithRules(
  lineup: readonly LineupEntry[],
  rules: LeagueRules,
): TeamWeekScore {
  return scoreTeamWeek(lineup, indexScoringRules(rules.scoring), rules.roster);
}

/**
 * Milli-points to a display string.
 *
 * The only place a fantasy point becomes a decimal. Two places, matching every
 * other fantasy platform, and never fed back into arithmetic.
 */
export function formatPoints(milliPoints: number): string {
  return (milliPoints / 1000).toFixed(2);
}

/** Compare two milli-point totals. Exact — no epsilon, because these are integers. */
export function compareScores(a: number, b: number): -1 | 0 | 1 {
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}
