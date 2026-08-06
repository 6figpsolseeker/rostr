/**
 * Standings and playoff seeding.
 *
 * This decides who makes the playoffs, and therefore who can win the pot. It
 * has to be **totally ordered** — every tie broken, no ambiguity, no coin flip.
 * The rule set's tiebreaker chain must end in something deterministic, and
 * `validate.ts` enforces that; this module assumes it.
 *
 * ## Ties are resolved by group, not pairwise
 *
 * The naive approach — a comparator that consults each tiebreaker in turn — is
 * wrong for head-to-head. Head-to-head between A and B says nothing about where
 * C belongs, so a pairwise comparator can produce A > B > C > A and sort into
 * whatever order the sort algorithm happened to visit.
 *
 * Instead: rank by the first tiebreaker, then re-apply the next one *within*
 * each group that is still tied. Head-to-head is then evaluated across the
 * whole tied group at once, which is both correct and what every real platform
 * does.
 *
 * All points are milli-points, integers throughout.
 */

import type { Tiebreaker } from "../rules/types.js";

export interface MatchupResult {
  readonly week: number;
  readonly homeTeamId: string;
  /** `null` on a bye — no result, and it counts for nothing. */
  readonly awayTeamId: string | null;
  readonly homeMilliPoints: number;
  readonly awayMilliPoints: number;
}

export interface TeamRecord {
  readonly teamId: string;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly milliPointsFor: number;
  readonly milliPointsAgainst: number;
  /** Games played. Excludes byes, so win percentage stays comparable. */
  readonly games: number;
}

export interface StandingsRow extends TeamRecord {
  /** 1-based. Contiguous — there are no shared ranks. */
  readonly seed: number;
  /** Which tiebreaker separated this team from the one above, if any. */
  readonly decidedBy: Tiebreaker | null;
}

export class StandingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StandingsError";
  }
}

/**
 * Win percentage in basis points.
 *
 * A tie counts as half a win, which is how the NFL and every fantasy platform
 * treat it. Integer arithmetic: no float ever decides a seed.
 */
export function winPercentageBasisPoints(record: TeamRecord): number {
  if (record.games === 0) return 0;
  return Math.round(((record.wins * 2 + record.ties) * 10_000) / (record.games * 2));
}

/** Tally win-loss records and points from completed matchups. */
export function computeRecords(
  teamIds: readonly string[],
  results: readonly MatchupResult[],
): ReadonlyMap<string, TeamRecord> {
  const records = new Map<
    string,
    {
      teamId: string;
      wins: number;
      losses: number;
      ties: number;
      milliPointsFor: number;
      milliPointsAgainst: number;
      games: number;
    }
  >(
    teamIds.map((teamId) => [
      teamId,
      {
        teamId,
        wins: 0,
        losses: 0,
        ties: 0,
        milliPointsFor: 0,
        milliPointsAgainst: 0,
        games: 0,
      },
    ]),
  );

  for (const result of results) {
    // A bye is not a game. It contributes no record and no points, so a team on
    // a bye is neither rewarded nor punished beyond losing the chance at a win.
    if (result.awayTeamId === null) continue;

    const home = records.get(result.homeTeamId);
    const away = records.get(result.awayTeamId);
    if (!home || !away) {
      throw new StandingsError(
        `Matchup in week ${result.week} names a team not in the league: ` +
          `${result.homeTeamId} vs ${result.awayTeamId}`,
      );
    }

    home.milliPointsFor += result.homeMilliPoints;
    home.milliPointsAgainst += result.awayMilliPoints;
    away.milliPointsFor += result.awayMilliPoints;
    away.milliPointsAgainst += result.homeMilliPoints;
    home.games += 1;
    away.games += 1;

    if (result.homeMilliPoints > result.awayMilliPoints) {
      home.wins += 1;
      away.losses += 1;
    } else if (result.homeMilliPoints < result.awayMilliPoints) {
      away.wins += 1;
      home.losses += 1;
    } else {
      // Exact ties are vanishingly rare at milli-point resolution, but they are
      // possible, and a league with money in it cannot have an undefined case.
      home.ties += 1;
      away.ties += 1;
    }
  }

  return records;
}

/**
 * Head-to-head record within a tied group, as a win percentage in basis points.
 *
 * Returns `null` when head-to-head cannot fairly decide the group: if the tied
 * teams did not all play each other the same number of times, comparing their
 * records against each other compares different schedules. Every platform skips
 * the tiebreaker in that case rather than applying it unevenly.
 */
function headToHeadScores(
  group: readonly TeamRecord[],
  results: readonly MatchupResult[],
): ReadonlyMap<string, number> | null {
  if (group.length < 2) return null;

  const members = new Set(group.map((record) => record.teamId));
  const internal = results.filter(
    (result) =>
      result.awayTeamId !== null &&
      members.has(result.homeTeamId) &&
      members.has(result.awayTeamId),
  );

  const tally = new Map(group.map((record) => [record.teamId, { wins: 0, ties: 0, games: 0 }]));
  const meetings = new Map<string, number>();

  for (const result of internal) {
    const home = tally.get(result.homeTeamId)!;
    const away = tally.get(result.awayTeamId!)!;
    home.games += 1;
    away.games += 1;

    const key = [result.homeTeamId, result.awayTeamId!].sort().join("|");
    meetings.set(key, (meetings.get(key) ?? 0) + 1);

    if (result.homeMilliPoints > result.awayMilliPoints) home.wins += 1;
    else if (result.homeMilliPoints < result.awayMilliPoints) away.wins += 1;
    else {
      home.ties += 1;
      away.ties += 1;
    }
  }

  // Every pair in the group must have met, and met equally often.
  const expectedPairs = (group.length * (group.length - 1)) / 2;
  if (meetings.size !== expectedPairs) return null;
  const counts = [...meetings.values()];
  if (Math.max(...counts) !== Math.min(...counts)) return null;

  return new Map(
    [...tally].map(([teamId, t]) => [
      teamId,
      t.games === 0 ? 0 : Math.round(((t.wins * 2 + t.ties) * 10_000) / (t.games * 2)),
    ]),
  );
}

/**
 * A team's score under one tiebreaker. Higher is better, always.
 *
 * `null` means the tiebreaker cannot be applied to this group and should be
 * skipped — only head-to-head does that.
 */
function scoresFor(
  tiebreaker: Tiebreaker,
  group: readonly TeamRecord[],
  results: readonly MatchupResult[],
): ReadonlyMap<string, number> | null {
  switch (tiebreaker) {
    case "WIN_PCT":
      return new Map(group.map((r) => [r.teamId, winPercentageBasisPoints(r)]));
    case "POINTS_FOR":
      return new Map(group.map((r) => [r.teamId, r.milliPointsFor]));
    case "POINTS_AGAINST":
      // Fewer points allowed is better, so negate — "higher is better" has to
      // hold for every tiebreaker or the sort below silently inverts one.
      return new Map(group.map((r) => [r.teamId, -r.milliPointsAgainst]));
    case "HEAD_TO_HEAD":
      return headToHeadScores(group, results);
    case "LOWEST_TEAM_ID":
      // The deterministic backstop. Not fair in any meaningful sense — it is
      // simply guaranteed to terminate, which matters more than fairness once
      // every real criterion has come up equal.
      return null;
  }
}

/** Split a group into sub-groups of equal score, best first. */
function partition(
  group: readonly TeamRecord[],
  scores: ReadonlyMap<string, number>,
): TeamRecord[][] {
  const sorted = [...group].sort(
    (a, b) => (scores.get(b.teamId) ?? 0) - (scores.get(a.teamId) ?? 0),
  );

  const buckets: TeamRecord[][] = [];
  let previous: number | null = null;

  for (const record of sorted) {
    const score = scores.get(record.teamId) ?? 0;
    if (score === previous && buckets.length > 0) buckets[buckets.length - 1]!.push(record);
    else buckets.push([record]);
    previous = score;
  }

  return buckets;
}

/** Recursively order a tied group by the remaining tiebreakers. */
function orderGroup(
  group: readonly TeamRecord[],
  tiebreakers: readonly Tiebreaker[],
  results: readonly MatchupResult[],
  decidedBy: Tiebreaker | null,
): { record: TeamRecord; decidedBy: Tiebreaker | null }[] {
  if (group.length === 1) return [{ record: group[0]!, decidedBy }];

  for (let i = 0; i < tiebreakers.length; i++) {
    const tiebreaker = tiebreakers[i]!;

    if (tiebreaker === "LOWEST_TEAM_ID") {
      return [...group]
        .sort((a, b) => a.teamId.localeCompare(b.teamId))
        .map((record, index) => ({
          record,
          decidedBy: index === 0 ? decidedBy : tiebreaker,
        }));
    }

    const scores = scoresFor(tiebreaker, group, results);
    if (!scores) continue; // Not applicable — head-to-head on an uneven group.

    const buckets = partition(group, scores);
    if (buckets.length === 1) continue; // Everyone equal; this one decided nothing.

    const rest = tiebreakers.slice(i + 1);
    return buckets.flatMap((bucket, index) =>
      orderGroup(bucket, rest, results, index === 0 ? decidedBy : tiebreaker),
    );
  }

  // The chain ran out with teams still tied. `validate.ts` requires the last
  // tiebreaker to be deterministic, so this is unreachable for a valid rule set
  // — but seeding must be total, and silently returning input order would make
  // a seed depend on the order rows came back from the database.
  throw new StandingsError(
    `Tiebreakers exhausted with ${group.length} teams still tied ` +
      `(${group.map((r) => r.teamId).join(", ")}). ` +
      `The chain must end in a deterministic tiebreaker.`,
  );
}

/**
 * Full standings, seeded 1..n.
 *
 * @param tiebreakers applied in order; the last must be deterministic
 */
export function computeStandings(
  teamIds: readonly string[],
  results: readonly MatchupResult[],
  tiebreakers: readonly Tiebreaker[],
): readonly StandingsRow[] {
  if (tiebreakers.length === 0) {
    throw new StandingsError("At least one tiebreaker is required to seed a league");
  }

  const records = computeRecords(teamIds, results);
  const ordered = orderGroup([...records.values()], tiebreakers, results, null);

  return ordered.map((entry, index) => ({
    ...entry.record,
    seed: index + 1,
    decidedBy: entry.decidedBy,
  }));
}

/** The seeds that make the playoffs, best first. */
export function playoffField(
  standings: readonly StandingsRow[],
  playoffTeams: number,
): readonly StandingsRow[] {
  return standings.slice(0, playoffTeams);
}

/** The teams that missed, best first — the consolation bracket's field. */
export function consolationField(
  standings: readonly StandingsRow[],
  playoffTeams: number,
): readonly StandingsRow[] {
  return standings.slice(playoffTeams);
}
