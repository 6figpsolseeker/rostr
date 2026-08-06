/**
 * Team-week scoring and matchup resolution. C6 and C8.
 *
 * These are the join between two halves that already worked separately. The
 * scoring engine turns stat lines into milli-points; `standings.ts` turns
 * `MatchupResult`s into a seeded table. Nothing produced a `MatchupResult`, so a
 * league could be scheduled, drafted, and scored, and still had no way to say
 * who won a week.
 *
 * ## Two representations of a lineup
 *
 * A lineup is *stored* as {@link LineupAssignment} — `(slotType, slotIndex,
 * playerId | null)`, which is what a manager edits and what the database keys
 * on. The engine consumes {@link LineupEntry} — `(slotType, playerId, stats)`,
 * which is what scoring needs. Converting between them is most of what this file
 * does, and it is the reason empty slots and absent stat lines both have to be
 * handled here rather than by either side.
 *
 * ## Absent, empty, and zero are three different things
 *
 *   - An **empty slot** (`playerId: null`) contributes nothing. A manager who
 *     left a slot empty scores zero for it, which is the rule, not a fault.
 *   - A player with **no stat line at all** scores zero. He was inactive, or on a
 *     bye, or his game has not been ingested yet. That is not an error.
 *   - A **team with no lineup at all** is an error and throws. Every team plays
 *     every week — the autolineup exists precisely so an abandoned team still has
 *     one — so a missing team means the caller lost it, not that a manager did
 *     nothing. Scoring it as zero would silently hand its opponent a free win.
 *
 * All arithmetic is integer milli-points, as everywhere else.
 */

import { scorePlayer, scoreTeamWeek } from "../scoring/engine.js";
import type { LineupEntry, PlayerScore, StatLine, TeamWeekScore } from "../scoring/engine.js";
import type { RosterRules, ScoringRule } from "../rules/types.js";
import type { LineupAssignment } from "./lineup.js";
import type { ScheduledMatchup } from "./schedule.js";
import type { MatchupResult } from "./standings.js";

/** Stat lines for a week, keyed by player. Absent means "did not appear". */
export type StatsByPlayer = ReadonlyMap<string, readonly StatLine[]>;

/**
 * Label reported on bench and IR players.
 *
 * A display label, not a slot type from any sport registry — bench scores are
 * built directly with `counted: false` and never pass through the starter
 * filter, so this string cannot affect a total even if a sport were to name a
 * starting slot the same thing.
 */
export const BENCH_SLOT = "BENCH";

export interface TeamLineup {
  readonly teamId: string;
  /** Starting slots. Empty ones are legal and score nothing. */
  readonly assignments: readonly LineupAssignment[];
  /**
   * Bench and IR players. Scored and returned so a manager can see what they
   * left out, never added to the total.
   */
  readonly bench?: readonly string[];
}

export class ResultsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultsError";
  }
}

/**
 * Score one team's week.
 *
 * Starters are scored through {@link scoreTeamWeek} rather than re-implemented,
 * so the rule about which slots count lives in exactly one place. Bench players
 * are scored with {@link scorePlayer} and appended as uncounted.
 *
 * @throws {ResultsError} if a player appears in more than one slot
 */
export function scoreTeamLineup(
  lineup: TeamLineup,
  stats: StatsByPlayer,
  scoringRules: ReadonlyMap<string, ScoringRule>,
  roster: RosterRules,
): TeamWeekScore {
  const seen = new Map<string, string>();

  const claim = (playerId: string, where: string): void => {
    const already = seen.get(playerId);
    if (already !== undefined) {
      // A duplicate silently doubles a player's points, which decides a matchup
      // and therefore a payout. `validateLineup` rejects this when a manager
      // submits, but scoring is the last place it can be caught before money
      // moves, and it costs one map lookup.
      throw new ResultsError(
        `Team ${lineup.teamId} has ${playerId} in both ${already} and ${where}`,
      );
    }
    seen.set(playerId, where);
  };

  const starters: LineupEntry[] = [];

  for (const assignment of lineup.assignments) {
    if (assignment.playerId === null) continue;
    claim(assignment.playerId, `${assignment.slotType}${assignment.slotIndex + 1}`);

    starters.push({
      slotType: assignment.slotType,
      playerId: assignment.playerId,
      stats: stats.get(assignment.playerId) ?? [],
    });
  }

  const scored = scoreTeamWeek(starters, scoringRules, roster);

  const bench: PlayerScore[] = (lineup.bench ?? []).map((playerId) => {
    claim(playerId, BENCH_SLOT);
    return {
      playerId,
      slotType: BENCH_SLOT,
      milliPoints: scorePlayer(stats.get(playerId) ?? [], scoringRules),
      counted: false,
    };
  });

  return {
    milliPoints: scored.milliPoints,
    players: [...scored.players, ...bench],
  };
}

/** Score every team's week, keyed by team. */
export function scoreWeek(
  lineups: readonly TeamLineup[],
  stats: StatsByPlayer,
  scoringRules: ReadonlyMap<string, ScoringRule>,
  roster: RosterRules,
): ReadonlyMap<string, TeamWeekScore> {
  const scores = new Map<string, TeamWeekScore>();

  for (const lineup of lineups) {
    if (scores.has(lineup.teamId)) {
      throw new ResultsError(`Team ${lineup.teamId} was given two lineups for the same week`);
    }
    scores.set(lineup.teamId, scoreTeamLineup(lineup, stats, scoringRules, roster));
  }

  return scores;
}

/**
 * Turn a week's scheduled matchups into results the standings can consume.
 *
 * A bye keeps `awayTeamId: null` and scores zero on that side. `computeRecords`
 * skips byes entirely, so the zero is never counted against anyone — but the row
 * has to exist so the week is complete.
 *
 * @throws {ResultsError} if a scheduled team has no score
 */
export function resolveMatchups(
  scheduled: readonly ScheduledMatchup[],
  scores: ReadonlyMap<string, TeamWeekScore>,
): readonly MatchupResult[] {
  const pointsFor = (teamId: string, week: number): number => {
    const score = scores.get(teamId);
    if (!score) {
      throw new ResultsError(
        `No lineup was scored for team ${teamId} in week ${week}. ` +
          `Every scheduled team must have one — the autolineup covers teams whose ` +
          `manager set nothing.`,
      );
    }
    return score.milliPoints;
  };

  return scheduled.map((matchup) => ({
    week: matchup.week,
    homeTeamId: matchup.homeTeamId,
    awayTeamId: matchup.awayTeamId,
    homeMilliPoints: pointsFor(matchup.homeTeamId, matchup.week),
    awayMilliPoints:
      matchup.awayTeamId === null ? 0 : pointsFor(matchup.awayTeamId, matchup.week),
  }));
}

/**
 * Score a week and resolve it in one call.
 *
 * The common path: every team's lineup, one week's stats, out come the results.
 */
export function resolveWeek(
  scheduled: readonly ScheduledMatchup[],
  lineups: readonly TeamLineup[],
  stats: StatsByPlayer,
  scoringRules: ReadonlyMap<string, ScoringRule>,
  roster: RosterRules,
): {
  readonly results: readonly MatchupResult[];
  readonly scores: ReadonlyMap<string, TeamWeekScore>;
} {
  const scores = scoreWeek(lineups, stats, scoringRules, roster);
  return { results: resolveMatchups(scheduled, scores), scores };
}

/** Who won a resolved matchup, or `null` on a tie or a bye. */
export function winnerOf(result: MatchupResult): string | null {
  if (result.awayTeamId === null) return null;
  if (result.homeMilliPoints > result.awayMilliPoints) return result.homeTeamId;
  if (result.homeMilliPoints < result.awayMilliPoints) return result.awayTeamId;
  return null;
}
